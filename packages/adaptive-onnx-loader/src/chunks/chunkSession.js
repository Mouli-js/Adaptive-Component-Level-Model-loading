/**
 * ChunkSession — one independently loaded model component (one ONNX graph, one
 * InferenceSession). The unit that the chain, the Workers, the cache (Phase 4) and the
 * decision engine (Phase 5) all manage.
 */
import { toOrt, fromOrt } from '../tensors.js';

export class ChunkSession {
  constructor(ort, entry, session, stats) {
    this.ort = ort; this.entry = entry; this.session = session; this.stats = stats;
    this.inputNames = session.inputNames; this.outputNames = session.outputNames;
  }

  /**
   * @param ort    injected onnxruntime-web module
   * @param entry  from chunkEntry(manifest, name, precision): { name, precision, url, bytes, sha256, … }
   * @param opts.bytes  optional Uint8Array (already fetched / from cache) — skips the fetch
   */
  static async create(ort, entry, { bytes = null, sessionOptions = {}, fetchImpl = fetch } = {}) {
    const t0 = performance.now();
    if (!bytes) {
      const res = await fetchImpl(entry.url);
      if (!res.ok) throw new Error(`fetch ${entry.url}: HTTP ${res.status}`);
      bytes = new Uint8Array(await res.arrayBuffer());
    }
    const t1 = performance.now();
    if (entry.bytes && bytes.byteLength !== entry.bytes)
      throw new Error(`${entry.name}/${entry.precision}: got ${bytes.byteLength} bytes, manifest says ${entry.bytes}`);
    const session = await ort.InferenceSession.create(bytes, {
      executionProviders: ['wasm'], graphOptimizationLevel: 'all', ...sessionOptions });
    const t2 = performance.now();
    return new ChunkSession(ort, entry, session,
      { name: entry.name, precision: entry.precision, bytes: bytes.byteLength, fetchMs: t1 - t0, createMs: t2 - t1 });
  }

  /** feeds: { inputName: plainTensor } -> { outputName: plainTensor } (buffers owned by caller) */
  async run(feeds) {
    const ortFeeds = {};
    for (const n of this.inputNames) {
      if (!feeds[n]) throw new Error(`${this.entry.name}: missing input "${n}"`);
      ortFeeds[n] = toOrt(this.ort, feeds[n]);
    }
    const out = await this.session.run(ortFeeds);
    const res = {};
    for (const n of this.outputNames) res[n] = fromOrt(out[n]);
    return res;
  }

  async release() { await this.session.release(); this.session = null; }
}
