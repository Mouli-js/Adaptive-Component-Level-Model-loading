/**
 * ChainRunner — all chunks as separate sessions in ONE context (main thread or one Worker).
 * Functionally equal to the full model; exists to prove the chain is correct and to measure
 * what splitting alone costs before Workers are added.
 */
import { ChunkSession } from './chunkSession.js';
import { feedsFor, encodeToTensors, logitsRows } from './chain.js';
import { chunkEntry, precisionPlan } from '../manifest.js';

export class ChainRunner {
  constructor(ort, manifest, { precision = 'int8', sessionOptions = {}, fetchImpl = globalThis.fetch } = {}) {
    this.ort = ort; this.manifest = manifest; this.sessionOptions = sessionOptions; this.fetchImpl = fetchImpl;
    this.plan = precisionPlan(manifest, precision);
    this.chunks = [];
  }

  async load() {
    for (const name of this.manifest.chain)
      this.chunks.push(await ChunkSession.create(this.ort, chunkEntry(this.manifest, name, this.plan[name]),
                                                 { sessionOptions: this.sessionOptions, fetchImpl: this.fetchImpl }));
    return this.chunks.map(c => c.stats);
  }

  /** Run the chain on already-encoded tensors; returns logits + per-chunk timings. */
  async forward(enc) {
    const state = { ...enc }, timings = [];
    for (let i = 0; i < this.chunks.length; i++) {
      const t0 = performance.now();
      const out = await this.chunks[i].run(feedsFor(this.chunks[i].entry.name, i, state));
      timings.push(performance.now() - t0);
      if (out.hidden) state.hidden = out.hidden;
      if (out.logits) state.logits = out.logits;
    }
    return { logits: state.logits, timings };
  }

  async classify(tokenizer, texts) {
    const t0 = performance.now();
    const { logits, timings } = await this.forward(encodeToTensors(tokenizer, texts));
    return { logits: logitsRows(logits), ms: performance.now() - t0, chunkMs: timings };
  }

  async release() { for (const c of this.chunks) await c.release(); this.chunks = []; }
}
