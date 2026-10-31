/**
 * MemoryLRU — a size-bounded Least-Recently-Used cache.
 *
 * A JS Map iterates in insertion order, so "re-insert on access" keeps the most recently
 * used key at the END and the least recently used at the FRONT. Eviction pops from the front
 * until the total size fits the budget. get / set / evict are all O(1) per entry.
 */
export class MemoryLRU {
  /** @param budgetBytes max total size; @param sizeOf value -> bytes */
  constructor(budgetBytes, sizeOf = v => v.byteLength) {
    this.budget = budgetBytes; this.sizeOf = sizeOf; this.map = new Map(); this.size = 0;
    this.stats = { hits: 0, misses: 0, evictions: 0, rejected: 0 };
  }
  has(k) { return this.map.has(k); }
  get(k) {
    if (!this.map.has(k)) { this.stats.misses++; return undefined; }
    const v = this.map.get(k); this.map.delete(k); this.map.set(k, v); this.stats.hits++;   // move to MRU end
    return v;
  }
  /** Returns false (and stores nothing) if the value alone is larger than the budget. */
  set(k, v) {
    const s = this.sizeOf(v);
    if (s > this.budget) { this.stats.rejected++; return false; }
    if (this.map.has(k)) this.delete(k);
    this.map.set(k, v); this.size += s;
    while (this.size > this.budget) {                         // evict LRU entries from the front
      const [oldK, oldV] = this.map.entries().next().value;
      this.map.delete(oldK); this.size -= this.sizeOf(oldV); this.stats.evictions++;
    }
    return true;
  }
  delete(k) { if (!this.map.has(k)) return false; this.size -= this.sizeOf(this.map.get(k)); return this.map.delete(k); }
  keys() { return [...this.map.keys()]; }                    // LRU → MRU order
  clear() { this.map.clear(); this.size = 0; }
}
