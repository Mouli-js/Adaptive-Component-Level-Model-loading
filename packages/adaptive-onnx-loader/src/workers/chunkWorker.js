/**
 * chunkWorker.js — a dedicated module Worker that hosts exactly ONE ChunkSession.
 *
 * Why a Worker per chunk: a Worker has its own WebAssembly instance and therefore its own
 * WASM heap. A heap can never shrink (F-4), but terminating the Worker destroys the whole
 * heap. So `worker.terminate()` is the only reliable way to give a chunk's memory back.
 *
 * Protocol (request/response, matched by `id`):
 *   → { id, type:'init', ortUrl, wasmPaths, numThreads }      ← { id, ok, heapBytes }
 *   → { id, type:'load', entry, sessionOptions, cache? }       ← { id, ok, stats, heapBytes }
 *        cache (optional, Phase 4): { dbName, budgetBytes, verifyOnRead } — the Worker gets the
 *        chunk's bytes from IndexedDB itself (or downloads, verifies and stores them), so bytes
 *        never pass through the page. Without `cache` the behaviour is exactly Phase 3's.
 *   → { id, type:'run',  feeds }  (feeds' buffers TRANSFERRED) ← { id, ok, outputs, runMs, heapBytes } (outputs transferred back)
 *   → { id, type:'release' }                                   ← { id, ok, heapBytes }
 * Errors: ← { id, ok:false, error }
 * Import maps don't apply inside Workers, so ORT's URL is passed in `init` (dependency injection).
 */
import { installWasmMemoryProbe, wasmHeapBytes } from '../metrics/memory.js';
import { ChunkSession } from '../chunks/chunkSession.js';
import { transferList } from '../tensors.js';
import { ChunkStore } from '../cache/chunkStore.js';
import { ChunkLoader } from '../cache/chunkLoader.js';

installWasmMemoryProbe();                         // before ORT creates this Worker's heap
let ort = null, chunk = null, store = null;

const handlers = {
  async init({ ortUrl, wasmPaths, numThreads = 1 }) {
    ort = await import(ortUrl);
    ort.env.wasm.wasmPaths = wasmPaths;
    ort.env.wasm.numThreads = numThreads;
    return {};
  },
  async load({ entry, sessionOptions = {}, cache = null }) {
    if (chunk) throw new Error('this worker already hosts a chunk');
    let bytes = null, cacheInfo = null;
    if (cache) {
      const t0 = performance.now();
      store ??= await ChunkStore.open({ dbName: cache.dbName, budgetBytes: cache.budgetBytes ?? Infinity });
      const r = await new ChunkLoader({ store, verifyOnRead: cache.verifyOnRead ?? true }).getBytes(entry);
      bytes = r.bytes;
      cacheInfo = { source: r.source, corruptEvicted: r.corruptEvicted, ...r.timings, getBytesMs: performance.now() - t0 };
    }
    chunk = await ChunkSession.create(ort, entry, { sessionOptions, bytes });
    if (cacheInfo) chunk.stats.fetchMs = cacheInfo.getBytesMs;     // "time to obtain bytes", whichever tier answered
    return { stats: { ...chunk.stats, cache: cacheInfo }, inputNames: chunk.inputNames, outputNames: chunk.outputNames };
  },
  async run({ feeds }) {
    const t0 = performance.now();
    const outputs = await chunk.run(feeds);
    return { outputs, runMs: performance.now() - t0, _transfer: transferList(outputs) };
  },
  async release() { if (chunk) await chunk.release(); chunk = null; return {}; },
};

self.onmessage = async ({ data: msg }) => {
  try {
    const { _transfer = [], ...res } = await handlers[msg.type](msg);
    self.postMessage({ id: msg.id, ok: true, heapBytes: wasmHeapBytes(), ...res }, _transfer);
  } catch (e) {
    self.postMessage({ id: msg.id, ok: false, error: String(e?.stack || e), heapBytes: wasmHeapBytes() });
  }
};
