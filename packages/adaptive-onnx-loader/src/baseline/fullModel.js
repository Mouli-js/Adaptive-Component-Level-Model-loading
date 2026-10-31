/**
 * Baseline: the conventional approach — download the whole model and create ONE
 * InferenceSession. Every adaptive policy in later phases is compared against this.
 * `ort` is injected (not imported) so the same code runs in browsers, workers and Node.
 */
export class FullModelRunner {
  constructor(ort, session, stats) { this.ort = ort; this.session = session; this.stats = stats; }

  /** @param {string} url  e.g. '/models/onnx/int8/full.onnx' */
  static async create(ort, url, { sessionOptions = {}, fetchImpl = fetch } = {}) {
    const t0 = performance.now();
    const res = await fetchImpl(url);
    if (!res.ok) throw new Error(`fetch ${url}: HTTP ${res.status}`);
    const bytes = new Uint8Array(await res.arrayBuffer());
    const t1 = performance.now();
    const session = await ort.InferenceSession.create(bytes, {
      executionProviders: ['wasm'], graphOptimizationLevel: 'all', ...sessionOptions });
    const t2 = performance.now();
    return new FullModelRunner(ort, session,
      { url, bytes: bytes.byteLength, fetchMs: t1 - t0, createMs: t2 - t1, loadMs: t2 - t0 });
  }

  /** Classify a batch. Returns logits as array of [neg, pos] plus timing. */
  async classify(tokenizer, texts) {
    const enc = tokenizer.encodeBatch(texts);
    const t0 = performance.now();
    const out = await this.session.run({
      input_ids: new this.ort.Tensor('int64', enc.inputIds, enc.dims),
      attention_mask: new this.ort.Tensor('int64', enc.attentionMask, enc.dims),
    });
    const ms = performance.now() - t0;
    const d = out.logits.data, logits = [];
    for (let i = 0; i < texts.length; i++) logits.push([d[2 * i], d[2 * i + 1]]);
    return { logits, ms };
  }

  async release() { await this.session.release(); }
}
