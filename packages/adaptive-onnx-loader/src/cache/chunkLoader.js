/**
 * ChunkLoader — get a chunk's bytes from the fastest tier that has a VALID copy:
 *   T1 memory (MemoryLRU)  →  T2 IndexedDB (ChunkStore)  →  T3 network
 * Integrity: the manifest's SHA-256 is the source of truth.
 *   - network bytes are always verified BEFORE they are stored (a bad download is never cached)
 *   - IndexedDB bytes are verified on read when `verifyOnRead` (detects disk corruption or
 *     tampering); a bad entry is deleted and the loader falls through to the network
 *   - size is always checked (cheap)
 * Works on the main thread and inside Workers (IndexedDB, fetch and WebCrypto exist in both).
 */
import { sha256Hex } from './hash.js';

export class IntegrityError extends Error {}

export class ChunkLoader {
  constructor({ store = null, memory = null, fetchImpl = (u) => fetch(u), verifyOnRead = true } = {}) {
    Object.assign(this, { store, memory, fetchImpl, verifyOnRead });
    this.stats = { memory: 0, idb: 0, network: 0, corruptEvicted: 0, verifyMs: 0 };
  }

  async verify(bytes, entry, t) {
    if (bytes.byteLength !== entry.bytes) return false;
    const t0 = performance.now(); const h = await sha256Hex(bytes);
    const ms = performance.now() - t0; t.verifyMs = (t.verifyMs || 0) + ms; this.stats.verifyMs += ms;
    return h === entry.sha256;
  }

  /** -> { bytes, source: 'memory'|'idb'|'network', timings, corruptEvicted } */
  async getBytes(entry) {
    const t = {}; let corruptEvicted = false;
    if (this.memory) {
      const b = this.memory.get(entry.sha256);
      if (b) { this.stats.memory++; return { bytes: b, source: 'memory', timings: t, corruptEvicted }; }
    }
    if (this.store) {
      const t0 = performance.now(); const hit = await this.store.get(entry.sha256); t.idbReadMs = performance.now() - t0;
      if (hit) {
        const ok = this.verifyOnRead ? await this.verify(hit.bytes, entry, t) : hit.bytes.byteLength === entry.bytes;
        if (ok) { this.stats.idb++; this.memory?.set(entry.sha256, hit.bytes); return { bytes: hit.bytes, source: 'idb', timings: t, corruptEvicted }; }
        await this.store.delete(entry.sha256); corruptEvicted = true; this.stats.corruptEvicted++;
      }
    }
    const t1 = performance.now();
    const res = await this.fetchImpl(entry.url);
    if (!res.ok) throw new Error(`fetch ${entry.url}: HTTP ${res.status}`);
    const bytes = new Uint8Array(await res.arrayBuffer()); t.fetchMs = performance.now() - t1;
    if (!(await this.verify(bytes, entry, t)))
      throw new IntegrityError(`${entry.name}/${entry.precision}: downloaded bytes do not match the manifest SHA-256`);
    if (this.store) { const t2 = performance.now(); t.stored = await this.store.put(entry.sha256, bytes, entry); t.idbPutMs = performance.now() - t2; }
    this.memory?.set(entry.sha256, bytes);
    this.stats.network++;
    return { bytes, source: 'network', timings: t, corruptEvicted };
  }
}
