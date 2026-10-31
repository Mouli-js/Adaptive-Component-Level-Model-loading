/**
 * Cost model — predicts, for one candidate plan, every component SEPARATELY:
 *   memory : Worker WASM heap · page-held tensors · cached bytes in memory · browser overhead
 *   time   : download · session creation (+ Worker start) · inference · transfer
 *   network: bytes that must be downloaded this session
 * A plan: { precision: 'fp32'|'int8'|'mixedC2', pinned: [chunk names], groupSize, prewarm, earlyExit }
 */
import { HEAP_MIB, EXIT_HEAD_EXTRA_MIB, BROWSER_OVERHEAD, PAGE_TENSOR_MIB_PER_SENTENCE,
         CACHED_BYTES_IN_MEMORY_MIB, PRECISION_PLANS } from './measurements.js';

export const CHAIN = ['c0_embed', 'c1_l0_1', 'c2_l2_3', 'c3_l4_5_cls'];
const EXIT_AFTER = { c1_l0_1: 'e1_after_c1', c2_l2_3: 'e2_after_c2' };

export function chunkInfo(manifest, plan) {
  const pp = PRECISION_PLANS[plan.precision];
  return CHAIN.map(name => {
    const prec = pp[name], e = manifest.chunks[name][prec];
    return { name, precision: prec, sizeMiB: e.bytes / 1048576, sha256: e.sha256,
             heapMiB: HEAP_MIB[prec][name] + (plan.earlyExit && EXIT_AFTER[name] ? EXIT_HEAD_EXTRA_MIB : 0),
             hasExit: !!(plan.earlyExit && EXIT_AFTER[name]) };
  });
}

/** Fraction of sentences that reach each chunk (early exit lets some stop after C1 or C2). */
export function reachFractions(plan, exitStats) {
  if (!plan.earlyExit) return [1, 1, 1, 1];
  const { exit1Frac, exit2Frac } = exitStats;
  return [1, 1, 1 - exit1Frac, 1 - exit1Frac - exit2Frac];
}

export function predictMemory(plan, chunks, ctx) {
  const pinned = new Set(plan.pinned);
  const P = chunks.filter(c => pinned.has(c.name)), U = chunks.filter(c => !pinned.has(c.name));
  const pinnedHeap = P.reduce((s, c) => s + c.heapMiB, 0);
  let transientHeap = 0;                                    // worst moment for the non-pinned Workers
  U.forEach((c, i) => { transientHeap = Math.max(transientHeap, c.heapMiB + (plan.prewarm && U[i + 1] ? U[i + 1].heapMiB : 0)); });
  const maxLiveWorkers = P.length + (U.length === 0 ? 0 : (plan.prewarm && U.length > 1 ? 2 : 1));
  const workerWasmMiB = (pinnedHeap + transientHeap) * ctx.heapUncertainty;
  const pageTensorsMiB = (U.length ? plan.groupSize : 1) * PAGE_TENSOR_MIB_PER_SENTENCE;
  const browserOverheadMiB = BROWSER_OVERHEAD.pageMiB + BROWSER_OVERHEAD.perWorkerMiB * maxLiveWorkers;
  const cachedBytesMiB = CACHED_BYTES_IN_MEMORY_MIB;
  return { workerWasmMiB, pageTensorsMiB, cachedBytesMiB, browserOverheadMiB, maxLiveWorkers,
           peakMiB: workerWasmMiB + pageTensorsMiB + cachedBytesMiB + browserOverheadMiB };
}

/** Time to obtain bytes + start a Worker + create the session, for one chunk. */
export function loadTime(c, cal, ctx, cached, compileWarm = false) {
  const download = cached ? 0 : ctx.rttMs + (c.sizeMiB * 1.048576 * 8 / ctx.downlinkMbps) * 1000;
  const fromDisk = cached ? (c.sizeMiB * 1.048576 / cal.idbReadMBps) * 1000 : 0;
  const store = cached ? 0 : (c.sizeMiB * 1.048576 / cal.idbWriteMBps) * 1000;
  const verify = (c.sizeMiB * 1.048576 / cal.hashMBps) * 1000;
  const base = compileWarm ? cal.createBaseMs : (cal.createBaseColdMs ?? cal.createBaseMs);   // F-28
  const create = cal.spawnMs + base + cal.createPerMiBMs * c.sizeMiB * (c.hasExit ? 1.03 : 1);
  return { download, fromDisk, store, verify, create, total: download + fromDisk + store + verify + create };
}

export function predictTime(plan, chunks, ctx, cal, { exitStats = null, diskFits = true } = {}) {
  const pinned = new Set(plan.pinned), cachedNow = new Set(ctx.cachedSha256);
  const reach = reachFractions(plan, exitStats);
  const infer = chunks.map((c, i) => reach[i] * (cal.inferMs[c.precision][c.name] + (c.hasExit ? cal.exitHeadMs : 0)));
  const transfer = reach.reduce((s, r) => s + r, 0) * cal.transferMs;
  const computePerSentence = infer.reduce((s, x) => s + x, 0) + transfer;
  // F-28: a load is "compile-warm" when another chunk Worker is alive while it is created:
  //  first request — any earlier chunk is pinned (still alive), or prewarm (spawned while the previous one runs)
  //  steady reload — some chunk is pinned, or prewarm; plain sequential reloads are always cold
  const anyPinnedBefore = i => chunks.slice(0, i).some(c => pinned.has(c.name));
  const first = chunks.map((c, i) => loadTime(c, cal, ctx, cachedNow.has(c.sha256), i > 0 && (anyPinnedBefore(i) || plan.prewarm)));
  const steadyWarm = pinned.size > 0 || plan.prewarm;
  const steady = chunks.map(c => loadTime(c, cal, ctx, diskFits, steadyWarm));
  const G = Math.max(1, Math.min(plan.groupSize, ctx.sentencesPerRequest));
  const U = chunks.map((c, i) => i).filter(i => !pinned.has(chunks[i].name));
  let reloadPerGroup = 0;
  U.forEach((i, k) => {
    const prev = U[k - 1];
    const overlap = plan.prewarm && k > 0 ? G * infer[prev] : 0;    // next chunk loads while the previous computes
    reloadPerGroup += Math.max(0, steady[i].total - overlap);
  });
  let initialLoad = 0;                                           // L: load on the first request's critical path
  chunks.forEach((c, i) => { initialLoad += plan.prewarm && i > 0 && !pinned.has(c.name) ? Math.max(0, first[i].total - infer[i - 1]) : first[i].total; });
  const perSentence = computePerSentence + reloadPerGroup / G;
  const startupsPerSentence = U.length / G;
  const networkMiB = chunks.filter(c => !cachedNow.has(c.sha256)).reduce((s, c) => s + c.sizeMiB, 0)
;   // if the plan does not fit the disk budget it is re-downloaded every session (see network.persistentCache)
  return { perSentenceMs: perSentence, computeMs: computePerSentence, transferMs: transfer, reloadPerSentenceMs: reloadPerGroup / G,
           initialLoadMs: initialLoad, effectiveGroupSize: G, startupsPerSentence, networkMiBFirstRequest: networkMiB,
           loadBreakdownFirst: first.map((l, i) => ({ chunk: chunks[i].name, ...roundAll(l) })) };
}

const roundAll = o => Object.fromEntries(Object.entries(o).map(([k, v]) => [k, Math.round(v)]));
