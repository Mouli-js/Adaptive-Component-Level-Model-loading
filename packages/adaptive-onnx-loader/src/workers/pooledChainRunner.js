/**
 * PooledChainRunner — sentence-major chain whose chunk Workers come from a WorkerPool.
 * Large budget  -> behaves like 'resident' (every acquire after the first is a hit).
 * Small budget  -> LRU eviction between chunks; with the IndexedDB tier enabled, each miss
 *                  reloads from disk instead of the network.
 * Batch size 1 per sentence (keeps int8 bit-identical, F-6).
 */
import { WorkerPool } from './workerPool.js';
import { feedsFor, encodeToTensors, logitsRows } from '../chunks/chain.js';
import { chunkEntry, precisionPlan } from '../manifest.js';

const cloneT = t => ({ type: t.type, data: t.data.slice(), dims: [...t.dims] });

export class PooledChainRunner {
  constructor(manifest, { precision = 'int8', heapBudgetBytes = Infinity, workerOpts }) {
    this.plan = precisionPlan(manifest, precision);
    this.entries = manifest.chain.map(n => chunkEntry(manifest, n, this.plan[n]));
    this.pool = new WorkerPool({ heapBudgetBytes, workerOpts });
    this.loadEvents = [];
  }

  async classify(tokenizer, text) {
    const t0 = performance.now();
    const state = encodeToTensors(tokenizer, [text]);
    for (let i = 0; i < this.entries.length; i++) {
      const e = this.entries[i];
      const { wc, hit } = await this.pool.acquire(e);
      if (!hit) this.loadEvents.push({ chunk: e.name, ...wc.stats });
      const f = feedsFor(e.name, i, state);
      if (f.attention_mask) f.attention_mask = cloneT(f.attention_mask);
      const { outputs } = await wc.run(f);
      if (outputs.hidden) state.hidden = outputs.hidden; else state.logits = outputs.logits;
    }
    return { logits: logitsRows(state.logits)[0], ms: performance.now() - t0 };
  }

  release() { this.pool.terminateAll(); }
}
