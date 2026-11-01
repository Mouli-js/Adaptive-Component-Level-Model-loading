/**
 * Phase 7 runner page. Executes ONE experiment run per call: window.p7.run(cfg).
 * Uses only the package's public exports (the same ones the Phase 3–5 pages use); it does not
 * change the engine or the runtime. Everything measured is returned as plain JSON.
 *
 * cfg = {
 *   policy: 'baseline' | 'chain' | 'plan',
 *   precision: 'fp32' | 'int8' | 'mixedC2',
 *   plan: { pinned: [...], groupSize, prewarm, earlyExit }      // policy 'plan' only
 *   workload: [validation indices],        // first index = the TTFI request
 *   requestMode: 'single' | 'batch',        // single: each sentence is its own request (M4 per request)
 *                                           // batch : one call over the workload (chunk-major for G > 1)
 *   discard: 5,                             // warm-up requests excluded from M4 (kept in raw data)
 *   accuracy: false,                        // also classify all 872 sentences (M5 + logits hash)
 *   cache: true                             // IndexedDB chunk cache in the Workers (policy 'plan')
 * }
 */
import { installWasmMemoryProbe, wasmHeapBytes, measureMemory, WordPieceTokenizer, loadManifest, FullModelRunner,
         ChainRunner, PlanRunner, PRECISION_PLANS, ChunkStore, planId, sha256Hex, readSignals, decide, calibrate,
         DEFAULT_CALIBRATION, predictMemory, predictTime, chunkInfo, applyProfile } from 'adaptive-onnx-loader';
import { encodeToTensors } from '/packages/adaptive-onnx-loader/src/chunks/chain.js';
installWasmMemoryProbe();
const ort = await import('onnxruntime-web');
const U = p => new URL(p, location.href).href;
const PAGE_THREADS = Number(new URLSearchParams(location.search).get('threads') || 1);   // Mac thread sweep (MAC-1); chunk Workers always use 1
ort.env.wasm.wasmPaths = U('/node_modules/onnxruntime-web/dist/'); ort.env.wasm.numThreads = PAGE_THREADS;
const DB = 'adaptive-onnx-loader';
const workerOpts = cache => ({ workerUrl: U('/packages/adaptive-onnx-loader/src/workers/chunkWorker.js'),
  ortUrl: U('/node_modules/onnxruntime-web/dist/ort.wasm.min.mjs'), wasmPaths: U('/node_modules/onnxruntime-web/dist/'),
  numThreads: 1, cache: cache ? { dbName: DB, verifyOnRead: true } : null });
document.getElementById('coi').textContent = String(crossOriginIsolated);

const getJSON = async u => (await fetch(u)).json();
const manifest = await loadManifest('/models/onnx/manifest.json');
const tokenizer = WordPieceTokenizer.fromVocabText(await (await fetch('/models/onnx/vocab.txt')).text(), { maxLength: manifest.max_length });
const rows = await getJSON('/data/sst2/validation.json');
const tau = (await getJSON('/models/heads/early_exit_policy.json')).chosen.tau;
const refCache = {};
const reference = (precision, ee) => refCache[`${precision}${ee}`] ??= getJSON(ee ? `/data/sst2/wasm_ee_${precision}.json` : `/data/sst2/wasm_chain_${precision}_logits.json`);

const median = a => { const s = [...a].sort((x, y) => x - y), m = s.length >> 1; return s.length ? (s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2) : null; };
const MiB = b => +(b / 1048576).toFixed(2);
async function hashLogits(list) {               // SHA-256 over the float32 bytes, row-major
  const f = new Float32Array(list.length * 2); list.forEach((l, i) => { f[2 * i] = l[0]; f[2 * i + 1] = l[1]; });
  return sha256Hex(new Uint8Array(f.buffer));
}
const seqLen = t => encodeToTensors(tokenizer, [t]).input_ids.dims[1];

/** Build an executor with a uniform interface for the three policies. */
async function makeExecutor(cfg) {
  const pp = PRECISION_PLANS[cfg.precision];
  if (cfg.policy === 'baseline') {
    if (cfg.precision === 'mixedC2') throw new Error('no single-file mixed model');
    const t0 = performance.now(); const m = await FullModelRunner.create(ort, `/models/onnx/${cfg.precision}/full.onnx`);
    return { loadMs: performance.now() - t0, loads: [{ chunk: 'full', source: 'network', bytesMs: m.stats.fetchMs, createMs: m.stats.createMs }],
      many: async texts => { const out = []; for (const t of texts) out.push({ logits: (await m.classify(tokenizer, [t])).logits[0], exitAt: 'full' }); return out; },
      peakBytes: () => wasmHeapBytes(), workers: () => 0, release: () => m.release(), meta: {} };
  }
  if (cfg.policy === 'chain') {
    const r = new ChainRunner(ort, manifest, { precision: pp }); const t0 = performance.now(); const st = await r.load();
    return { loadMs: performance.now() - t0, loads: st.map(s => ({ chunk: s.name ?? s.url, source: 'network', bytesMs: s.fetchMs, createMs: s.createMs })),
      many: async texts => { const out = []; for (const t of texts) out.push({ logits: (await r.classify(tokenizer, [t])).logits[0], exitAt: 'full' }); return out; },
      peakBytes: () => wasmHeapBytes(), workers: () => 0, release: () => r.release(), meta: {} };
  }
  const plan = { precision: cfg.precision, pinned: cfg.plan.pinned, groupSize: cfg.plan.groupSize, prewarm: !!cfg.plan.prewarm, earlyExit: !!cfg.plan.earlyExit };
  plan.id = planId(plan);
  const r = new PlanRunner(manifest, plan, { workerOpts: workerOpts(cfg.cache !== false), earlyExitTau: tau });
  return { loadMs: 0, runner: r, plan,                         // PlanRunner loads lazily: load time is inside the first request
    many: async texts => (await r.classifyMany(tokenizer, texts)).results,
    peakBytes: () => r.peakLiveHeapBytes, workers: () => Math.max(0, ...r.timeline.map(e => e.liveWorkers)), release: () => r.release(),
    meta: { planId: plan.id } };
}

async function run(cfg) {
  const T0 = performance.now(), texts = cfg.workload.map(i => rows[i].sentence);
  const memStart = wasmHeapBytes();
  // ---- M2: time to first inference (fresh executor, first sentence) ----
  const ex = await makeExecutor(cfg);
  // cfg.ttfi === false: no separate first request — the workload call is the first call (E-ENG: measure exactly
  // the request the engine was asked to plan for; a separate first request would add an extra load cycle).
  const first = cfg.ttfi === false ? [] : await ex.many([texts[0]]);
  const ttfiMs = cfg.ttfi === false ? null : performance.now() - T0;
  const firstLoads = ex.runner ? ex.runner.loads.map(l => ({ ...l })) : ex.loads;
  // ---- M4: workload ----
  const requests = [], results = [];
  let workloadMs = null;
  if (cfg.firstRequestOnly) {
    // E5 revisits / cold visits: exactly ONE request (the first one); no workload afterwards
  } else if (cfg.requestMode === 'batch') {
    const t = performance.now(); results.push(...await ex.many(texts)); workloadMs = performance.now() - t;
  } else {
    const t = performance.now();
    for (const s of texts) { const q = performance.now(); results.push(...await ex.many([s])); requests.push(performance.now() - q); }
    workloadMs = performance.now() - t;
  }
  const kept = requests.slice(cfg.discard ?? 5);
  // ---- output check on EVERY run (D-7.3): workload outputs vs the precision's WASM reference ----
  //      int8: exact (Δ = 0); fp32 / mixed: Δ < 1e-4 (the full fp32 model differs from the chain by ~2.4e-5, F-1)
  let refCheck = null;
  {
    const ee = !!cfg.plan?.earlyExit, ref = await reference(cfg.precision, ee), idx = cfg.ttfi === false ? cfg.workload : [cfg.workload[0], ...cfg.workload];
    const outs = [...first, ...results]; let maxDiff = 0, exitMismatch = 0;
    outs.forEach((x, k) => { const rl = ee ? ref[idx[k]].logits : ref[idx[k]];
      maxDiff = Math.max(maxDiff, Math.abs(x.logits[0] - rl[0]), Math.abs(x.logits[1] - rl[1]));
      if (ee && x.exitAt !== ref[idx[k]].exitAt) exitMismatch++; });
    const tol = cfg.precision === 'int8' ? 0 : 1e-4;
    refCheck = { n: outs.length, maxAbsDiffVsRef: maxDiff, exitMismatch, tolerance: tol, pass: maxDiff <= tol && exitMismatch === 0 };
  }
  // ---- optional UA-memory spot check (D-7.7), taken while the plan's resident memory is still alive ----
  let ua = null;
  if (cfg.uaCheck) { const m = await measureMemory({ withUA: true }); ua = { uaMiB: m.uaBytes != null ? MiB(m.uaBytes) : null, uaError: m.uaError ?? null,
    liveWorkerProbeMiB: ex.runner ? MiB(ex.runner.liveHeapBytes) : null, pageWasmMiB: MiB(m.wasmHeapBytes) }; }
  // waiting hidden states in chunk-major plans (F-21): largest group's sum of seq × 768 × 4 bytes
  let hiddenBytes = 0;
  const G = cfg.policy === 'plan' ? cfg.plan.groupSize : 1;
  if (cfg.requestMode === 'batch' && G > 1 && !cfg.firstRequestOnly)
    for (let g = 0; g < texts.length; g += G) hiddenBytes = Math.max(hiddenBytes, texts.slice(g, g + G).reduce((s, t) => s + seqLen(t) * 768 * 4, 0));
  // ---- M5 (optional): all 872 ----
  let acc = null;
  if (cfg.accuracy) {
    const t = performance.now(); const all = await ex.many(rows.map(r => r.sentence)); const ms = performance.now() - t;
    const ref = await reference(cfg.precision, !!cfg.plan?.earlyExit);
    let correct = 0, maxDiff = 0, exitMismatch = 0;
    all.forEach((x, i) => { correct += (x.logits[1] > x.logits[0]) === (rows[i].label === 1);
      const rl = cfg.plan?.earlyExit ? ref[i].logits : ref[i];
      maxDiff = Math.max(maxDiff, Math.abs(x.logits[0] - rl[0]), Math.abs(x.logits[1] - rl[1]));
      if (cfg.plan?.earlyExit && x.exitAt !== ref[i].exitAt) exitMismatch++; });
    acc = { n: all.length, accuracy: correct / all.length, logitsHash: await hashLogits(all.map(x => x.logits)), maxAbsDiffVsRef: maxDiff,
            exitMismatch, exits: all.reduce((a, x) => (a[x.exitAt] = (a[x.exitAt] || 0) + 1, a), {}), ms,
            predictions: all.map(x => +(x.logits[1] > x.logits[0])), exitAt: all.map(x => x.exitAt) };
  }
  if (ex.runner) await ex.release();               // terminations go into the timeline before it is read
  const peak = ex.peakBytes();
  const bound = ex.runner ? overlapUpperBound(ex.runner.timeline, ex.runner.loads) : null;
  const out = {
    cfg, planId: ex.meta.planId ?? `${cfg.policy}|${cfg.precision}`, ttfiMs, loadMsBeforeFirst: ex.loadMs,
    firstLoads, allLoads: ex.runner ? ex.runner.loads : ex.loads,
    workloadMs, n: texts.length, requestMs: requests, m4MedianMs: kept.length ? median(kept) : null,
    m4AmortisedMs: cfg.firstRequestOnly ? null : workloadMs / texts.length,
    trace: results.map(x => ({ exitAt: x.exitAt, path: x.path, computeMs: x.computeMs, transferMs: x.transferMs })),
    workloadLogitsHash: await hashLogits([...first, ...results].map(x => x.logits)),
    memory: { probe: cfg.policy === 'plan' ? 'sum of live Worker heaps (Worker replies)' : 'page WASM heap',
              peakWasmMiB: MiB(peak), pageHeapStartMiB: MiB(memStart), waitingHiddenMiB: MiB(hiddenBytes), peakTotalMiB: MiB(peak + hiddenBytes),
              // upper bound: each Worker's heap counted from the START of its spawn (covers a pre-started Worker still loading)
              lifetimeOverlapUpperMiB: bound != null ? +bound.toFixed(2) : null },
    refCheck, ua, pageThreads: PAGE_THREADS,
    maxLiveWorkers: ex.workers(), spawns: ex.runner?.spawns ?? 0, timeline: ex.runner?.timeline ?? [],
    accuracy: acc, totalRunMs: performance.now() - T0 };
  if (!ex.runner) await ex.release();
  return out;
}

/** Peak of Σ heap over Worker lifetimes [spawn start, terminate]. Heap per Worker = its share of the live heap
 *  at its 'terminated' event (or at 'loaded' if larger). Timeline times and load durations are both ms since t0. */
function overlapUpperBound(timeline, loads) {
  let prev = 0, li = 0; const open = {}, iv = [];
  for (const e of timeline) {
    const d = e.liveHeapMiB - prev; prev = e.liveHeapMiB;
    if (e.event === 'loaded') { const L = loads[li++]; open[e.chunk] = { start: e.t - (L?.totalMs ?? 0) + 1, h: d }; /* +1 ms: timeline t is rounded to whole ms */ }
    else if (e.event === 'terminated' && open[e.chunk]) { const o = open[e.chunk]; iv.push({ start: o.start, end: e.t, h: Math.max(o.h, -d) }); delete open[e.chunk]; }
  }
  for (const k in open) iv.push({ ...open[k], end: Infinity });
  const pts = iv.flatMap(x => [[x.start, x.h], [x.end, -x.h]]).sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  let cur = 0, max = 0; for (const [, h] of pts) { cur += h; max = Math.max(max, cur); }
  return max;
}

/** UA-memory cross-check of the probe (needs --enable-blink-features=ForceEagerMeasureMemory). Keeps Workers alive while measuring. */
async function probeCheck({ precision = 'int8', pinned = ['c0_embed', 'c1_l0_1', 'c2_l2_3', 'c3_l4_5_cls'] } = {}) {
  const before = await measureMemory({ withUA: true });
  const plan = { precision, pinned, groupSize: 1, prewarm: false, earlyExit: false }; plan.id = planId(plan);
  const r = new PlanRunner(manifest, plan, { workerOpts: workerOpts(true), earlyExitTau: tau });
  await r.classifyMany(tokenizer, [rows[0].sentence]);
  const perWorker = [...r.live.entries()].map(([k, w]) => ({ chunk: k, heapMiB: MiB(w.heapBytes) }));
  const during = await measureMemory({ withUA: true });
  r.release();
  await new Promise(res => setTimeout(res, 500));
  const after = await measureMemory({ withUA: true });
  const pick = m => ({ uaMiB: m.uaBytes != null ? MiB(m.uaBytes) : null, uaByType: m.uaByType, uaError: m.uaError, pageWasmMiB: MiB(m.wasmHeapBytes) });
  return { plan: plan.id, perWorker, probeSumMiB: MiB(r.peakLiveHeapBytes), liveWorkersAtMeasure: perWorker.length,
           before: pick(before), during: pick(during), after: pick(after) };
}

async function cacheState() {
  const s = await ChunkStore.open({ dbName: DB });
  try { const list = await s.list(); return { entries: list.length, bytes: list.reduce((a, m) => a + m.size, 0), items: list.map(m => ({ name: m.name ?? m.file ?? m.key, size: m.size, key: m.sha256 ?? m.key })) }; } finally { s.close(); }
}
async function clearCache() { const s = await ChunkStore.open({ dbName: DB }); try { await s.clear(); } finally { s.close(); } }

/** E-F28 helper: create one chunk Worker under a given state of other Workers. */
async function creation({ chunk = 'c1_l0_1', precision = 'int8', state = 'a' }) {
  const { WorkerChunk, chunkEntry } = await import('adaptive-onnx-loader');
  const wo = workerOpts(true), entry = chunkEntry(manifest, chunk, precision);
  const other = manifest.chain.find(c => c !== chunk);
  let helper = null;
  if (state === 'b') helper = await WorkerChunk.spawn(chunkEntry(manifest, other, precision), wo);          // other chunk Worker, session alive
  if (state === 'c') { helper = new Worker(wo.workerUrl, { type: 'module' });                                  // ORT loaded, no session
    await new Promise((res, rej) => { helper.onmessage = e => e.data.ok ? res() : rej(e.data.error); helper.postMessage({ id: 1, type: 'init', ortUrl: wo.ortUrl, wasmPaths: wo.wasmPaths, numThreads: 1 }); }); }
  if (state === 'e') { helper = await WorkerChunk.spawn(chunkEntry(manifest, 'e1_after_c1', 'fp32'), wo); await helper.call('release'); }   // WASM instance alive, session released
  if (state === 'd') { const w = await WorkerChunk.spawn(chunkEntry(manifest, other, precision), wo); w.terminate(); await new Promise(r => setTimeout(r, 50)); }
  const t = performance.now(); const w = await WorkerChunk.spawn(entry, wo); const totalMs = performance.now() - t;
  const s = { state, chunk, precision, totalMs, spawnInitMs: w.stats.spawnInitMs, createMs: w.stats.createMs, bytesMs: w.stats.fetchMs, source: w.stats.cache?.source };
  w.terminate(); helper?.terminate?.();
  return s;
}

// ---- decision engine hooks (E-ENG). Same inputs as AdaptiveModel.decideWith: signals from the monitor,
//      early-exit table from models/onnx/early_exit.json, an explicit calibration object (measured once, saved by Node).
const eeMeta = await getJSON('/models/onnx/early_exit.json');
async function signalsNow() { const s = await ChunkStore.open({ dbName: DB }); try { return await readSignals({ store: s }); } finally { s.close(); } }
async function calibrateHere(n = 16) {
  return calibrate({ manifest, workerOpts: workerOpts(true), tokenizer, sentences: rows.filter((_, i) => i % 54 === 0).slice(0, n).map(r => r.sentence) });
}
async function decideHere({ profile = 'mid', overrides = {}, calibration = DEFAULT_CALIBRATION }) {
  const signals = await signalsNow();
  const d = decide({ manifest, signals, profile, overrides, calibration, earlyExitTable: eeMeta.plans, trace: true });
  return { signals, feasible: d.feasible, plan: d.plan, budget: d.budget, predicted: d.predicted, candidates: d.candidates,
           runnersUp: (d.runnersUp ?? []).map(r => r.id), trace: d.trace, explanation: d.explanation };
}
/** Engine prediction for a plan under the ACTUAL conditions of a run (link, cache state, workload size). */
async function predictHere({ plan, n, downlinkMbps = 1000, rttMs = 1, diskFits = true, calibration = DEFAULT_CALIBRATION }) {
  const p = { ...plan, id: planId(plan) };
  const signals = await signalsNow();
  const ctx = applyProfile(signals, null, { downlinkMbps, rttMs, sentencesPerRequest: n, earlyExit: !!p.earlyExit });
  const chunks = chunkInfo(manifest, p);
  const pm = predictMemory(p, chunks, ctx);
  const pt = predictTime(p, chunks, ctx, calibration, { exitStats: eeMeta.plans?.[p.precision] ?? null, diskFits });
  return { planId: p.id, predictedWasmMiBWithMargin: pm.workerWasmMiB / 1, predictedWasmMiBNoMargin: pm.workerWasmMiB / ctx.heapUncertainty,
           predictedMaxLiveWorkers: pm.maxLiveWorkers, initialLoadMs: pt.initialLoadMs, perSentenceMs: pt.perSentenceMs, time: pt, memory: pm };
}

/** E-B browser spot check: the int8/fp32 chain in the PAGE at batch size B, dataset order (same batching as node_wasm.mjs). */
async function batchedChain({ precision = 'int8', batch = 32 }) {
  const r = new ChainRunner(ort, manifest, { precision: PRECISION_PLANS[precision] }); await r.load();
  const out = []; const t = performance.now();
  for (let s = 0; s < rows.length; s += batch) out.push(...(await r.classify(tokenizer, rows.slice(s, s + batch).map(x => x.sentence))).logits);
  const ms = performance.now() - t; await r.release();
  const correct = out.reduce((a, l, i) => a + ((l[1] > l[0]) === (rows[i].label === 1)), 0);
  return { precision, batch, n: out.length, accuracy: correct / out.length, logitsHash: await hashLogits(out), ms };
}

function env() {
  return { origin: location.origin, pageThreads: PAGE_THREADS, userAgent: navigator.userAgent, hardwareConcurrency: navigator.hardwareConcurrency, deviceMemory: navigator.deviceMemory ?? null,
           crossOriginIsolated, ortVersion: ort.env.versions?.web ?? null };
}

window.p7 = { run, probeCheck, cacheState, clearCache, creation, env, decide: decideHere, calibrate: calibrateHere, predict: predictHere, batchedChain, rows: rows.length, tau, ready: true };
