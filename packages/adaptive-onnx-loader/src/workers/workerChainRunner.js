/**
 * WorkerChainRunner — the chain with ONE Worker PER CHUNK.
 *
 * Modes
 *   'resident'   : spawn all chunk Workers up front and keep them alive (fast, most memory).
 *                  Sentence-major: each sentence flows C0→C1→C2→C3, then the next sentence.
 *   'sequential' : at most ONE chunk Worker alive at a time (least memory, slowest).
 *                  Chunk-major: spawn C0, run every sentence through it, TERMINATE it; then C1 …
 *                  The intermediate hidden states of all sentences wait in the main thread.
 * Every sentence is always run at batch size 1, so int8 results stay identical to the
 * baseline (dynamic quantization is batch-dependent, F-6).
 *
 * Memory accounting: each Worker reports its WASM heap after every call. `liveHeapBytes` =
 * sum over Workers that have not been terminated. The peak of that sum is metric M3.
 */
import { WorkerChunk } from './workerChunk.js';
import { feedsFor, encodeToTensors, logitsRows } from '../chunks/chain.js';
import { chunkEntry, precisionPlan } from '../manifest.js';

const cloneT = t => ({ type: t.type, data: t.data.slice(), dims: [...t.dims] });

export class WorkerChainRunner {
  constructor(manifest, { precision = 'int8', mode = 'resident', workerUrl, ortUrl, wasmPaths, numThreads = 1, sessionOptions = {}, cache = null } = {}) {
    if (!['resident', 'sequential'].includes(mode)) throw new Error(`unknown mode ${mode}`);
    Object.assign(this, { manifest, mode, workerOpts: { workerUrl, ortUrl, wasmPaths, numThreads, sessionOptions, cache } });
    this.plan = precisionPlan(manifest, precision);
    this.entries = manifest.chain.map(n => chunkEntry(manifest, n, this.plan[n]));
    this.workers = new Map();          // name -> WorkerChunk (alive only)
    this.timeline = []; this.peakLiveHeapBytes = 0; this.loads = []; this.t0 = performance.now();
  }

  get liveHeapBytes() { let s = 0; for (const w of this.workers.values()) s += w.heapBytes; return s; }
  mark(event, chunk = null, extra = {}) {
    const live = this.liveHeapBytes;
    this.peakLiveHeapBytes = Math.max(this.peakLiveHeapBytes, live);
    this.timeline.push({ t: performance.now() - this.t0, event, chunk, liveWorkers: this.workers.size, liveHeapBytes: live, ...extra });
  }

  async spawn(entry) {
    const w = await WorkerChunk.spawn(entry, this.workerOpts);
    this.workers.set(entry.name, w); this.loads.push(w.stats);
    this.mark('loaded', entry.name, { workerHeapBytes: w.heapBytes });
    return w;
  }
  kill(name) { this.workers.get(name).terminate(); this.workers.delete(name); this.mark('terminated', name); }

  async load() { if (this.mode === 'resident') for (const e of this.entries) await this.spawn(e); return this.loads; }

  /** One sentence through the resident chain. */
  async forwardResident(enc, acc) {
    const state = { ...enc };
    for (let i = 0; i < this.entries.length; i++) {
      const name = this.entries[i].name;
      const f = feedsFor(name, i, state);
      if (f.attention_mask) f.attention_mask = cloneT(f.attention_mask);   // the mask is reused by later chunks; send a copy
      const { outputs, runMs, overheadMs } = await this.workers.get(name).run(f);
      acc.runMs[i] += runMs; acc.overheadMs[i] += overheadMs;
      if (outputs.hidden) state.hidden = outputs.hidden; else state.logits = outputs.logits;
    }
    return state.logits;
  }

  /**
   * Classify many sentences (each at batch 1). Returns logits rows plus timing / memory stats.
   */
  async classifyMany(tokenizer, texts, { onProgress } = {}) {
    const n = texts.length, k = this.entries.length;
    const acc = { runMs: new Array(k).fill(0), overheadMs: new Array(k).fill(0) };
    const states = texts.map(t => encodeToTensors(tokenizer, [t]));
    const logits = new Array(n);
    let maxActivationBytes = 0;
    const t0 = performance.now();
    if (this.mode === 'resident') {
      for (let j = 0; j < n; j++) {
        logits[j] = logitsRows(await this.forwardResident(states[j], acc))[0];
        if (onProgress && j % 50 === 0) onProgress(j, n);
      }
    } else {
      for (let i = 0; i < k; i++) {
        const e = this.entries[i];
        const w = await this.spawn(e);
        let activationBytes = 0;
        for (let j = 0; j < n; j++) {
          const f = feedsFor(e.name, i, states[j]);
          if (f.attention_mask) f.attention_mask = cloneT(f.attention_mask);
          const { outputs, runMs, overheadMs } = await w.run(f);
          acc.runMs[i] += runMs; acc.overheadMs[i] += overheadMs;
          if (outputs.hidden) { states[j].hidden = outputs.hidden; activationBytes += outputs.hidden.data.byteLength; }
          else { logits[j] = logitsRows(outputs.logits)[0]; delete states[j].hidden; }
          if (i === 0) delete states[j].input_ids;              // no longer needed after C0
        }
        maxActivationBytes = Math.max(maxActivationBytes, activationBytes);
        this.mark('ran', e.name, { activationBytes });
        this.kill(e.name);                                       // give the chunk's heap back
        if (onProgress) onProgress(i + 1, k, 'chunks');
      }
    }
    return {
      logits, totalMs: performance.now() - t0,
      perChunk: this.entries.map((e, i) => ({ name: e.name, precision: e.precision,
        meanRunMs: acc.runMs[i] / n, meanMessageOverheadMs: acc.overheadMs[i] / n })),
      maxActivationBytes,
    };
  }

  async release() { for (const name of [...this.workers.keys()]) this.kill(name); }
}
