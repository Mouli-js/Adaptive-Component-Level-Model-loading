/**
 * ChunkStore — persistent ("cold") chunk storage in IndexedDB, content-addressed by SHA-256.
 *
 * Two object stores so that LRU bookkeeping never rewrites the large value:
 *   'blobs' : sha256 -> ArrayBuffer            (written once per chunk version)
 *   'meta'  : sha256 -> { sha256, name, precision, size, storedAt, lastUsed, hits }
 * Content addressing: the key IS the hash of the bytes, so a new model version gets a new
 * key automatically and stale versions are simply never requested again (they age out by LRU).
 *
 * Budget: an optional byte budget (`budgetBytes`); puts evict least-recently-used entries
 * first. The browser's own quota still applies; on QuotaExceededError we evict and retry once.
 */
const req = r => new Promise((res, rej) => { r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });
const done = tx => new Promise((res, rej) => { tx.oncomplete = () => res(); tx.onabort = tx.onerror = () => rej(tx.error); });

export class ChunkStore {
  constructor(db, { budgetBytes = Infinity } = {}) {
    this.db = db; this.budgetBytes = budgetBytes;
    this.stats = { hits: 0, misses: 0, puts: 0, evictions: 0, quotaErrors: 0, rejected: 0 };
  }

  static async open({ dbName = 'adaptive-onnx-loader', budgetBytes = Infinity, indexedDB = globalThis.indexedDB } = {}) {
    if (!indexedDB) throw new Error('IndexedDB is not available in this context');
    const open = indexedDB.open(dbName, 1);
    open.onupgradeneeded = () => {                       // runs once, when the DB is first created
      const db = open.result;
      db.createObjectStore('blobs');
      db.createObjectStore('meta', { keyPath: 'sha256' }).createIndex('lastUsed', 'lastUsed');
    };
    return new ChunkStore(await req(open), { budgetBytes });
  }

  async list() { return req(this.db.transaction('meta').objectStore('meta').getAll()); }
  async usage() { return (await this.list()).reduce((s, m) => s + m.size, 0); }
  async has(sha) { return (await req(this.db.transaction('meta').objectStore('meta').getKey(sha))) !== undefined; }

  /** -> { bytes: Uint8Array, meta } or null. Updates lastUsed/hits (meta store only). */
  async get(sha) {
    const tx = this.db.transaction(['blobs', 'meta']);
    const [buf, meta] = await Promise.all([req(tx.objectStore('blobs').get(sha)), req(tx.objectStore('meta').get(sha))]);
    if (!buf || !meta) { this.stats.misses++; return null; }
    this.stats.hits++;
    const w = this.db.transaction('meta', 'readwrite');
    w.objectStore('meta').put({ ...meta, lastUsed: Date.now(), hits: (meta.hits || 0) + 1 });
    await done(w);
    return { bytes: new Uint8Array(buf), meta };
  }

  /** Store bytes under sha. Returns false if it can't fit the budget or the quota. */
  async put(sha, bytes, info = {}) {
    const size = bytes.byteLength;
    if (size > this.budgetBytes) { this.stats.rejected++; return false; }
    await this.evictToFit(size, sha);
    // store a standalone ArrayBuffer (a view's .buffer could be larger than the view)
    const buf = bytes.byteOffset === 0 && bytes.byteLength === bytes.buffer.byteLength ? bytes.buffer : bytes.slice().buffer;
    const write = async () => {
      const tx = this.db.transaction(['blobs', 'meta'], 'readwrite');
      tx.objectStore('blobs').put(buf, sha);
      tx.objectStore('meta').put({ sha256: sha, name: info.name ?? null, precision: info.precision ?? null, size,
                                   storedAt: Date.now(), lastUsed: Date.now(), hits: 0 });
      await done(tx);
    };
    try { await write(); }
    catch (e) {
      if (e?.name !== 'QuotaExceededError') throw e;
      this.stats.quotaErrors++;
      if (!(await this.evictOldest(sha))) return false;   // free something and retry once
      try { await write(); } catch { return false; }
    }
    this.stats.puts++;
    return true;
  }

  /** Evict least-recently-used entries until `incoming` more bytes fit the budget. */
  async evictToFit(incoming, keepSha = null) {
    if (this.budgetBytes === Infinity) return [];
    const metas = (await this.list()).sort((a, b) => a.lastUsed - b.lastUsed);
    let used = metas.reduce((s, m) => s + m.size, 0); const evicted = [];
    for (const m of metas) {
      if (used + incoming <= this.budgetBytes) break;
      if (m.sha256 === keepSha) continue;
      await this.delete(m.sha256); used -= m.size; evicted.push(m); this.stats.evictions++;
    }
    return evicted;
  }
  async evictOldest(keepSha) {
    const m = (await this.list()).filter(x => x.sha256 !== keepSha).sort((a, b) => a.lastUsed - b.lastUsed)[0];
    if (!m) return false; await this.delete(m.sha256); this.stats.evictions++; return true;
  }

  async delete(sha) {
    const tx = this.db.transaction(['blobs', 'meta'], 'readwrite');
    tx.objectStore('blobs').delete(sha); tx.objectStore('meta').delete(sha);
    await done(tx);
  }
  async clear() {
    const tx = this.db.transaction(['blobs', 'meta'], 'readwrite');
    tx.objectStore('blobs').clear(); tx.objectStore('meta').clear(); await done(tx);
  }
  close() { this.db.close(); }

  /** Browser storage quota / usage, and whether storage is marked persistent. */
  static async storageInfo({ requestPersist = false } = {}) {
    const s = globalThis.navigator?.storage;
    if (!s?.estimate) return { supported: false };
    const est = await s.estimate();
    let persisted = s.persisted ? await s.persisted() : null;
    if (requestPersist && s.persist && !persisted) persisted = await s.persist();
    return { supported: true, quota: est.quota, usage: est.usage, persisted };
  }
}
