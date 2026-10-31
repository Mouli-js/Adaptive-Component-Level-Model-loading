/**
 * Public API — the one entry point a developer uses:
 *
 *   const model = await loadModel({ manifestUrl: '/models/onnx/manifest.json', profile: 'mid' });
 *   model.explainPlan();  await model.infer(['great film']);  await model.getCacheStats();
 *   await model.replan({ profile: 'low' });  await model.clearCache();  model.dispose();
 *
 * loadModel wires together: resource monitor → (optional) calibration → decision engine →
 * PlanRunner (one Worker per chunk, IndexedDB tier). Decisions are deterministic unless
 * `calibrate: true` is passed (calibration measures this device and so varies run to run).
 */
import { loadManifest } from './manifest.js';
import { WordPieceTokenizer } from './tokenizer/wordpiece.js';
import { ChunkStore } from './cache/chunkStore.js';
import { readSignals } from './engine/monitor.js';
import { decide } from './engine/planner.js';
import { calibrate as calibrateDevice } from './engine/calibrate.js';
import { DEFAULT_CALIBRATION } from './engine/measurements.js';
import { PlanRunner } from './workers/planRunner.js';

export class AdaptiveLoaderError extends Error {
  /** codes: BAD_OPTIONS · NOT_ISOLATED · NO_WORKERS · MANIFEST · NO_FEASIBLE_PLAN · EARLY_EXIT_UNAVAILABLE · DISPOSED */
  constructor(code, message, details = {}) { super(`[${code}] ${message}`); this.name = 'AdaptiveLoaderError'; this.code = code; this.details = details; }
}

const softmax = ([a, b]) => { const m = Math.max(a, b), ea = Math.exp(a - m), eb = Math.exp(b - m); return [ea / (ea + eb), eb / (ea + eb)]; };

function resolveOptions(opts) {
  if (!opts || typeof opts.manifestUrl !== 'string') throw new AdaptiveLoaderError('BAD_OPTIONS', 'loadModel({ manifestUrl }) is required');
  const base = globalThis.location?.href;
  const ortUrl = opts.ortUrl ?? (base ? new URL('/node_modules/onnxruntime-web/dist/ort.wasm.min.mjs', base).href : null);
  return {
    profile: null, overrides: {}, earlyExit: false, calibrate: false, calibration: null, cache: true,
    dbName: 'adaptive-onnx-loader', verifyOnRead: true, requireIsolation: true, threadsPerWorker: 1, ...opts,
    ortUrl, wasmPaths: opts.wasmPaths ?? (ortUrl ? new URL('./', ortUrl).href : null),
    workerUrl: opts.workerUrl ?? new URL('./workers/chunkWorker.js', import.meta.url).href,
  };
}

export async function loadModel(options) {
  const o = resolveOptions(options);
  if (o.requireIsolation && !globalThis.crossOriginIsolated)
    throw new AdaptiveLoaderError('NOT_ISOLATED', 'the page is not cross-origin isolated: serve it with "Cross-Origin-Opener-Policy: same-origin" and "Cross-Origin-Embedder-Policy: require-corp" (see README)');
  if (typeof globalThis.Worker !== 'function') throw new AdaptiveLoaderError('NO_WORKERS', 'Web Workers are not available in this environment');
  if (!o.ortUrl) throw new AdaptiveLoaderError('BAD_OPTIONS', 'ortUrl is required outside a page (absolute URL of onnxruntime-web/dist/ort.wasm.min.mjs)');
  let manifest;
  try { manifest = await loadManifest(o.manifestUrl); } catch (e) { throw new AdaptiveLoaderError('MANIFEST', `cannot load manifest ${o.manifestUrl}: ${e.message}`); }
  const vocab = await (await fetch(new URL(manifest.tokenizer.vocab, manifest.baseUrl))).text();
  const tokenizer = WordPieceTokenizer.fromVocabText(vocab, { maxLength: manifest.max_length });
  let earlyExitMeta = null;
  if (o.earlyExit) {
    const r = await fetch(new URL('early_exit.json', manifest.baseUrl));
    if (!r.ok) throw new AdaptiveLoaderError('EARLY_EXIT_UNAVAILABLE', 'earlyExit requested but early_exit.json was not found next to the manifest');
    earlyExitMeta = await r.json();
  }
  const store = o.cache ? await ChunkStore.open({ dbName: o.dbName }) : null;
  const model = new AdaptiveModel(o, manifest, tokenizer, store, earlyExitMeta);
  await model.replan({});
  return model;
}

export class AdaptiveModel {
  constructor(o, manifest, tokenizer, store, earlyExitMeta) {
    Object.assign(this, { o, manifest, tokenizer, store, earlyExitMeta });
    this.runner = null; this.decision = null; this.queue = Promise.resolve(); this.disposed = false; this.calibration = null;
    this.stats = { requests: 0, sentences: 0 };
  }
  get workerOpts() {
    return { workerUrl: this.o.workerUrl, ortUrl: this.o.ortUrl, wasmPaths: this.o.wasmPaths, numThreads: this.o.threadsPerWorker,
             cache: this.store ? { dbName: this.o.dbName, verifyOnRead: this.o.verifyOnRead } : null };
  }
  guard() { if (this.disposed) throw new AdaptiveLoaderError('DISPOSED', 'this model has been disposed'); }

  /** Re-run the decision engine (e.g. new profile, budget or workload). Releases current Workers. */
  async replan(changes = {}) {
    this.guard();
    if ('earlyExit' in changes && changes.earlyExit && !this.earlyExitMeta)
      throw new AdaptiveLoaderError('EARLY_EXIT_UNAVAILABLE', 'enable earlyExit in loadModel() to load its metadata');
    Object.assign(this.o, changes, { overrides: { ...this.o.overrides, ...(changes.overrides || {}) } });
    await this.queue;
    if (this.o.calibrate && !this.calibration)
      this.calibration = await calibrateDevice({ manifest: this.manifest, workerOpts: this.workerOpts, tokenizer: this.tokenizer,
        sentences: ['a gorgeous , witty , seductive movie .', 'the plot is dull and the acting is worse than the script .',
                    'it is a well-made , often funny film that never quite finds its footing .', 'boring .'] });
    const d = await this.decideWith(this.o);
    if (!d.feasible) throw new AdaptiveLoaderError('NO_FEASIBLE_PLAN', d.explanation.join(' '), { decision: d });
    this.runner?.release();
    this.decision = d;
    this.runner = new PlanRunner(this.manifest, d.plan, { workerOpts: this.workerOpts, earlyExitTau: this.earlyExitMeta?.tau ?? null });
    return this.explainPlan();
  }

  get calibrationUsed() { return this.o.calibration ?? this.calibration ?? DEFAULT_CALIBRATION; }

  /** Run the decision engine for a set of options (pure: changes nothing). trace = per-candidate records (output only). */
  async decideWith(o) {
    const signals = await readSignals({ store: this.store });
    return decide({ manifest: this.manifest, signals, profile: o.profile ?? null, calibration: this.calibrationUsed,
                    overrides: { ...(o.overrides || {}), earlyExit: !!o.earlyExit },
                    earlyExitTable: this.earlyExitMeta?.plans ?? null, trace: true });
  }

  /** What would the engine choose with these changes? Does NOT change the running plan or Workers. */
  async previewPlan(changes = {}) {
    this.guard();
    const o = { ...this.o, ...changes, overrides: { ...this.o.overrides, ...(changes.overrides || {}) } };
    const d = await this.decideWith(o);
    return d.feasible ? { feasible: true, profile: d.profile, planId: d.plan.id, plan: d.plan, predicted: d.predicted, budget: d.budget, candidates: d.candidates }
                      : { feasible: false, profile: d.profile, budget: d.budget, candidates: d.candidates, explanation: d.explanation };
  }

  get plan() { return this.decision?.plan ?? null; }

  /** The decision in plain language plus its numbers. */
  explainPlan({ full = false } = {}) {
    const d = this.decision;
    const { cachedSha256, ...ctx } = d.context;
    const cal = this.calibrationUsed;
    return { planId: d.plan.id, plan: d.plan, profile: d.profile, explanation: d.explanation, predicted: d.predicted,
             budget: d.budget, candidates: d.candidates, calibration: d.calibrationSource, runnersUp: d.runnersUp.map(r => r.id),
             earlyExit: earlyExitStatus(this.o.earlyExit, d, this.earlyExitMeta),
             alternatives: summarizeAlternatives(d.trace),
             context: { ...ctx, cachedChunks: cachedSha256.length },
             calibrationValues: { source: cal.source, spawnMs: cal.spawnMs, createBaseWarmMs: cal.createBaseMs, createBaseColdMs: cal.createBaseColdMs ?? null,
                                  createPerMiBMs: cal.createPerMiBMs, inferC1Ms: { int8: cal.inferMs.int8.c1_l0_1, fp32: cal.inferMs.fp32.c1_l0_1 },
                                  transferMs: cal.transferMs, idbReadMBps: cal.idbReadMBps, hashMBps: cal.hashMBps },
             ...(full ? { trace: d.trace } : {}) };
  }

  /** Classify one string or an array. Calls are serialised (one at a time) so Workers are never shared. */
  infer(input) {
    // always report errors through the returned promise (never a synchronous throw)
    try { this.guard(); } catch (e) { return Promise.reject(e); }
    const texts = Array.isArray(input) ? input : [input];
    if (!texts.every(t => typeof t === 'string')) return Promise.reject(new AdaptiveLoaderError('BAD_OPTIONS', 'infer() takes a string or an array of strings'));
    const job = this.queue.then(async () => {
      const { results, totalMs } = await this.runner.classifyMany(this.tokenizer, texts);
      this.stats.requests++; this.stats.sentences += texts.length; this.lastInferMs = totalMs;
      return results.map(r => { const p = softmax(r.logits), k = p[1] > p[0] ? 1 : 0;
        return { label: this.manifest.labels[k], score: p[k], logits: r.logits, exitAt: r.exitAt,
                 path: r.path, computeMs: r.computeMs, transferMs: r.transferMs }; });
    });
    this.queue = job.catch(() => {});
    return Array.isArray(input) ? job : job.then(r => r[0]);
  }

  async getCacheStats() {
    // after dispose() the IndexedDB connection is closed: report runtime state only (no crash)
    const live = this.store && !this.disposed;
    const entries = live ? (await this.store.list()).map(m => ({ name: m.name, precision: m.precision, sizeMiB: +(m.size / 1048576).toFixed(2), hits: m.hits })) : [];
    const r = this.runner;
    return { planId: this.plan?.id ?? null,
             disposed: this.disposed,
             persistent: { enabled: !!this.store, entries, usageMiB: +entries.reduce((s, e) => s + e.sizeMiB, 0).toFixed(2), storage: await ChunkStore.storageInfo() },
             runtime: { liveWorkers: r?.live.size ?? 0, liveWasmMiB: +((r?.liveHeapBytes ?? 0) / 1048576).toFixed(2),
                        peakWasmMiB: +((r?.peakLiveHeapBytes ?? 0) / 1048576).toFixed(2), workerStarts: r?.spawns ?? 0,
                        lastInferMs: this.lastInferMs ?? null, ...this.stats } };
  }

  async clearCache() { this.guard(); await this.queue; if (this.store) await this.store.clear(); }

  dispose() { if (this.disposed) return; this.runner?.release(); this.store?.close(); this.disposed = true; }
}

const modeOf = r => r.pinned === 4 ? 'resident' : r.pinned === 0 ? 'one at a time' : 'hybrid (some pinned)';

/** One row per plan family (precision × mode × early exit): the chosen plan, the best feasible
 *  alternative, or — if the whole family was rejected — the hard constraint that ruled it out. */
export function summarizeAlternatives(trace) {
  if (!trace) return [];
  const fam = new Map();
  for (const r of trace) { const k = `${r.precision}|${modeOf(r)}|${r.earlyExit ? 'early exit' : 'full'}`; (fam.get(k) ?? fam.set(k, []).get(k)).push(r); }
  const rows = [];
  for (const [k, rs] of fam) {
    const [precision, mode, exit] = k.split('|');
    const chosen = rs.find(r => r.status === 'chosen');
    const feas = rs.filter(r => r.status === 'feasible').sort((a, b) => a.rank - b.rank)[0];
    const rej = rs.filter(r => r.status === 'rejected');
    const byReason = rej.reduce((a, r) => (a[r.reason] = (a[r.reason] || 0) + 1, a), {});
    let status, detail;
    if (chosen) { status = 'chosen'; detail = `${chosen.id} · cost ${chosen.cost}`; }
    else if (feas) { status = 'feasible'; detail = `best ${feas.id} · rank ${feas.rank} · cost ${feas.cost}`; }
    else {
      status = 'rejected';
      const mem = rej.filter(r => r.reason === 'memory').sort((a, b) => a.peakMiB - b.peakMiB)[0];
      const acc = rej.find(r => r.reason === 'accuracy');
      detail = acc ? `accuracy ${acc.detail}` : mem ? `memory: smallest ${mem.detail}` : 'accuracy never measured';
    }
    rows.push({ family: `${precision} · ${mode} · ${exit}`, precision, mode, earlyExit: exit === 'early exit', status, detail,
                candidates: rs.length, rejected: byReason, rank: chosen ? 0 : feas ? feas.rank : Infinity });
  }
  return rows.sort((a, b) => a.rank - b.rank || a.family.localeCompare(b.family));
}

function earlyExitStatus(requested, d, meta) {
  if (!requested) return { requested: false, used: false, tau: null, reason: 'Off — early exit is opt-in (it changes predictions).' };
  if (d.plan.earlyExit) return { requested: true, used: true, tau: meta.tau,
    reason: `Used: a sentence stops after C1 or C2 when the exit head's confidence ≥ τ = ${meta.tau} (τ tuned on the dev split).` };
  const ee = (d.trace || []).filter(r => r.earlyExit);
  const feas = ee.filter(r => r.status === 'feasible').sort((a, b) => a.rank - b.rank)[0];
  if (feas) { const ch = d.trace.find(r => r.status === 'chosen');
    return { requested: true, used: false, tau: meta.tau, reason: `Early exit enabled, but early-exit plans ranked lower (best ${feas.id}, cost ${feas.cost} vs chosen ${ch.cost}). Running full inference instead.` }; }
  const accRej = ee.filter(r => r.reason === 'accuracy'), memRej = ee.filter(r => r.reason === 'memory');
  const bestAcc = accRej.length ? Math.max(...accRej.map(r => r.accuracy)) : null;
  return { requested: true, used: false, tau: meta.tau,
    reason: `Early exit enabled, but no early-exit plan satisfies the hard constraints (${accRej.length} rejected for accuracy` +
            (bestAcc != null ? ` — best early-exit accuracy ${(bestAcc * 100).toFixed(2)}% < ${(d.context.minAccuracy * 100).toFixed(1)}% floor` : '') +
            `; ${memRej.length} for memory). Running full inference instead.` };
}
