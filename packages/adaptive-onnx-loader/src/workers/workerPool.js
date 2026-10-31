/**
 * WorkerPool — the HOT tier: chunk Workers whose sessions are already created.
 *
 * A hit costs nothing (no fetch, no IndexedDB read, no session creation). The pool is bounded
 * by a WASM-heap budget; when a new Worker would exceed it, the least-recently-used Worker is
 * TERMINATED (which frees 100% of its heap, D-3), never merely released.
 *
 * Budget enforcement happens BEFORE spawning, using an estimate of the new Worker's heap:
 * the heap observed last time this chunk was loaded, or bytes × HEAP_RATIO + BASE if never
 * seen (ratios measured in Phase 3: 2.9–3.4× + ~16–19 MiB, F-18). After the spawn the real
 * heap is known and the budget is re-checked. A single chunk larger than the whole budget is
 * still allowed (otherwise inference would be impossible) and is flagged as `overBudget`.
 */
import { WorkerChunk } from './workerChunk.js';

const HEAP_RATIO = 3.5, BASE = 20 * 1048576;

export class WorkerPool {
  constructor({ heapBudgetBytes = Infinity, workerOpts }) {
    this.budget = heapBudgetBytes; this.workerOpts = workerOpts;
    this.live = new Map();             // key -> { wc, lastUsed }   (Map order not relied upon)
    this.observedHeap = new Map();     // key -> last real heap (better estimate next time)
    this.stats = { hits: 0, misses: 0, evictions: 0, overBudget: 0 };
    this.peakLiveHeapBytes = 0; this.timeline = []; this.t0 = performance.now(); this.tick = 0;
  }
  static key(e) { return `${e.name}/${e.precision}`; }
  get liveHeapBytes() { let s = 0; for (const { wc } of this.live.values()) s += wc.heapBytes; return s; }
  estimate(e) { return this.observedHeap.get(WorkerPool.key(e)) ?? e.bytes * HEAP_RATIO + BASE; }

  mark(event, key) {
    const live = this.liveHeapBytes; this.peakLiveHeapBytes = Math.max(this.peakLiveHeapBytes, live);
    this.timeline.push({ t: Math.round(performance.now() - this.t0), event, key, liveWorkers: this.live.size, liveHeapMiB: +(live / 1048576).toFixed(1) });
  }

  /** Evict LRU Workers (never those in `keep`) until `incoming` more bytes fit. */
  evictFor(incoming, keep = new Set()) {
    const order = [...this.live.entries()].filter(([k]) => !keep.has(k)).sort((a, b) => a[1].lastUsed - b[1].lastUsed);
    for (const [k, v] of order) {
      if (this.liveHeapBytes + incoming <= this.budget) break;
      v.wc.terminate(); this.live.delete(k); this.stats.evictions++; this.mark('evicted', k);
    }
  }

  /** -> { wc, hit } ; `pin` = keys that must not be evicted for this call (e.g. the chunk in use) */
  async acquire(entry, { pin = [] } = {}) {
    const k = WorkerPool.key(entry), keep = new Set([k, ...pin]);
    const cur = this.live.get(k);
    if (cur) { cur.lastUsed = ++this.tick; this.stats.hits++; return { wc: cur.wc, hit: true }; }
    this.stats.misses++;
    this.evictFor(this.estimate(entry), keep);
    const wc = await WorkerChunk.spawn(entry, this.workerOpts);
    this.observedHeap.set(k, wc.heapBytes);
    this.live.set(k, { wc, lastUsed: ++this.tick });
    this.mark('loaded', k);
    if (this.liveHeapBytes > this.budget) {
      this.evictFor(0, keep);
      if (this.liveHeapBytes > this.budget) { this.stats.overBudget++; this.mark('overBudget', k); }
    }
    return { wc, hit: false };
  }

  terminateAll() {
    for (const k of [...this.live.keys()]) {          // remove BEFORE marking, so the timeline's liveWorkers is correct
      this.live.get(k).wc.terminate(); this.live.delete(k); this.mark('terminated', k);
    }
  }
}
