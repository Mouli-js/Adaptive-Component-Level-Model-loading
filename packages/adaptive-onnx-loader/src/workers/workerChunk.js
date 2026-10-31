/**
 * WorkerChunk — main-thread handle for one chunkWorker (promise-based RPC).
 * Tracks the Worker's last reported WASM heap so the runner can account for live memory.
 */
import { transferList } from '../tensors.js';

export class WorkerChunk {
  constructor(entry, worker) {
    this.entry = entry; this.worker = worker; this.nextId = 1; this.pending = new Map();
    this.heapBytes = 0; this.alive = true;
    worker.onmessage = ({ data }) => {
      const p = this.pending.get(data.id); if (!p) return;
      this.pending.delete(data.id); this.heapBytes = data.heapBytes ?? this.heapBytes;
      data.ok ? p.resolve(data) : p.reject(new Error(`[${entry.name}] ${data.error}`));
    };
    worker.onerror = e => { for (const p of this.pending.values()) p.reject(new Error(`[${entry.name}] worker error: ${e.message}`)); this.pending.clear(); };
  }

  call(type, payload = {}, transfer = []) {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.worker.postMessage({ id, type, ...payload }, transfer);
    });
  }

  /** Spawn the Worker, start ORT in it, load the chunk. */
  static async spawn(entry, { workerUrl, ortUrl, wasmPaths, numThreads = 1, sessionOptions = {}, cache = null, exitEntry = null }) {
    const t0 = performance.now();
    const wc = new WorkerChunk(entry, new Worker(workerUrl, { type: 'module', name: entry.name }));
    await wc.call('init', { ortUrl, wasmPaths, numThreads });
    const t1 = performance.now();
    const r = await wc.call('load', { entry, sessionOptions, cache, exitEntry });
    wc.stats = { ...r.stats, spawnInitMs: t1 - t0, totalMs: performance.now() - t0, heapBytes: r.heapBytes };
    wc.inputNames = r.inputNames; wc.outputNames = r.outputNames;
    return wc;
  }

  /** Run once. `feeds` buffers are transferred (caller must not reuse them). */
  async run(feeds, { withExit = false } = {}) {
    const t0 = performance.now();
    const r = await this.call('run', { feeds, withExit }, transferList(feeds));
    const roundTripMs = performance.now() - t0;
    return { outputs: r.outputs, runMs: r.runMs, overheadMs: roundTripMs - r.runMs };
  }

  async release() { await this.call('release'); }

  /** Destroy the Worker — and with it its entire WASM heap. */
  terminate() { this.worker.terminate(); this.alive = false; this.heapBytes = 0; }
}
