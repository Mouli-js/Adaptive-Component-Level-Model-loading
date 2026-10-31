/**
 * PlanRunner — executes ANY plan produced by the decision engine:
 *   precision : per-chunk weights ('fp32' | 'int8' | 'mixedC2')
 *   pinned    : chunks whose Workers stay alive (all = resident, none = sequential, some = hybrid)
 *   groupSize : sentences processed together, chunk-major, before non-pinned Workers are reloaded
 *   prewarm   : start the next non-pinned chunk's Worker while the current chunk computes
 *   earlyExit : { tau } — exit heads run inside the C1 / C2 Workers; confident sentences stop early
 * Every sentence still runs at batch size 1 (keeps int8 results reference-identical, F-6).
 * Live WASM memory is tracked exactly as in Phases 3–4 (sum over Workers not yet terminated).
 */
import { WorkerChunk } from './workerChunk.js';
import { feedsFor, encodeToTensors, logitsRows } from '../chunks/chain.js';
import { chunkEntry } from '../manifest.js';
import { PRECISION_PLANS } from '../engine/measurements.js';

const cloneT = t => ({ type: t.type, data: t.data.slice(), dims: [...t.dims] });
const EXIT_AFTER = { c1_l0_1: 'e1_after_c1', c2_l2_3: 'e2_after_c2' };
const conf = ([a, b]) => { const m = Math.max(a, b), ea = Math.exp(a - m), eb = Math.exp(b - m); return Math.max(ea, eb) / (ea + eb); };

export class PlanRunner {
  constructor(manifest, plan, { workerOpts, earlyExitTau = null }) {
    this.manifest = manifest; this.plan = plan; this.workerOpts = workerOpts;
    this.tau = plan.earlyExit ? earlyExitTau : null;
    if (plan.earlyExit && this.tau == null) throw new Error('early exit requires a tuned τ');
    const pp = PRECISION_PLANS[plan.precision];
    this.entries = manifest.chain.map(n => chunkEntry(manifest, n, pp[n]));
    this.exitEntries = Object.fromEntries(Object.entries(EXIT_AFTER).map(([c, e]) => [c, chunkEntry(manifest, e, 'fp32')]));
    this.pinned = new Set(plan.pinned); this.live = new Map();
    this.peakLiveHeapBytes = 0; this.timeline = []; this.spawns = 0; this.loads = []; this.t0 = performance.now();
  }
  get liveHeapBytes() { let s = 0; for (const w of this.live.values()) s += w.heapBytes; return s; }
  mark(event, name) {
    const live = this.liveHeapBytes; this.peakLiveHeapBytes = Math.max(this.peakLiveHeapBytes, live);
    this.timeline.push({ t: Math.round(performance.now() - this.t0), event, chunk: name, liveWorkers: this.live.size, liveHeapMiB: +(live / 1048576).toFixed(1) });
  }
  async spawn(e) {
    const t = performance.now();
    const w = await WorkerChunk.spawn(e, { ...this.workerOpts, exitEntry: this.tau != null ? this.exitEntries[e.name] ?? null : null });
    this.loads.push({ chunk: e.name, totalMs: performance.now() - t, spawnInitMs: w.stats.spawnInitMs, bytesMs: w.stats.fetchMs,
                      source: w.stats.cache?.source ?? 'network', createMs: w.stats.createMs });
    this.live.set(e.name, w); this.spawns++; this.mark('loaded', e.name); return w;
  }
  kill(name) { const w = this.live.get(name); if (!w) return; w.terminate(); this.live.delete(name); this.mark('terminated', name); }

  async classifyMany(tokenizer, texts, { onProgress } = {}) {
    const n = texts.length, G = this.plan.groupSize;      // resident plans use groupSize 1 (sentence-major), as the cost model assumes
    const results = new Array(n); const t0 = performance.now();
    for (let g0 = 0; g0 < n; g0 += G) {
      const idx = [...Array(Math.min(G, n - g0)).keys()].map(k => g0 + k);
      const st = new Map(idx.map(j => [j, encodeToTensors(tokenizer, [texts[j]])]));
      let active = idx, warming = null;
      for (let i = 0; i < this.entries.length && active.length; i++) {
        const e = this.entries[i];
        let w = this.live.get(e.name);
        if (!w) w = warming?.name === e.name ? await warming.p : await this.spawn(e);
        warming = null;
        const next = this.entries[i + 1];
        if (this.plan.prewarm && next && !this.pinned.has(next.name) && !this.live.has(next.name))
          warming = { name: next.name, p: this.spawn(next) };            // overlaps with the runs below
        const withExit = this.tau != null && !!EXIT_AFTER[e.name];
        const still = [];
        for (const j of active) {
          const s = st.get(j), f = feedsFor(e.name, i, s);
          if (f.attention_mask) f.attention_mask = cloneT(f.attention_mask);
          const { outputs } = await w.run(f, { withExit });
          if (outputs.logits) { results[j] = { logits: logitsRows(outputs.logits)[0], exitAt: 'full' }; continue; }
          s.hidden = outputs.hidden; if (i === 0) delete s.input_ids;
          if (withExit) {
            const lg = logitsRows(outputs.exitLogits)[0];
            if (conf(lg) >= this.tau) { results[j] = { logits: lg, exitAt: e.name === 'c1_l0_1' ? 'e1' : 'e2' }; continue; }
          }
          still.push(j);
        }
        active = still;
        if (!this.pinned.has(e.name)) this.kill(e.name);
        if (!active.length && warming) { await warming.p; this.kill(warming.name); warming = null; }   // nothing left to compute
      }
      if (onProgress) onProgress(Math.min(g0 + G, n), n);
    }
    return { results, totalMs: performance.now() - t0 };
  }
  release() { for (const k of [...this.live.keys()]) this.kill(k); }
}
