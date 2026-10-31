/**
 * Memory measurement in the browser — three sources, from most to least complete:
 *
 * 1. performance.measureUserAgentSpecificMemory()  (Chromium, needs crossOriginIsolated)
 *    Whole-page estimate incl. JS heap, DOM, and WebAssembly memory. Asynchronous: the
 *    browser may wait for the next GC (up to ~20 s) unless started with
 *    --enable-blink-features=ForceEagerMeasureMemory.
 * 2. WASM linear memory (this module's probe). onnxruntime-web's threaded build creates
 *    its heap with `new WebAssembly.Memory({shared:true,…})` from JS, so wrapping the
 *    constructor lets us read buffer.byteLength. Key fact: WASM memory can GROW but
 *    never SHRINK — releasing a session frees space *inside* the heap, not the heap.
 * 3. performance.memory.usedJSHeapSize (Chromium, non-standard). JS heap only; model
 *    weights living in WASM memory are NOT included.
 */
const probed = [];

/** Must run BEFORE onnxruntime-web initialises its WASM module. Idempotent. */
export function installWasmMemoryProbe() {
  if (globalThis.__wasmMemoryProbe) return;
  const Native = WebAssembly.Memory;
  function ProbedMemory(desc) { const m = new Native(desc); probed.push(m); return m; }
  ProbedMemory.prototype = Native.prototype;
  WebAssembly.Memory = ProbedMemory;
  globalThis.__wasmMemoryProbe = true;
}

export function wasmHeapBytes() {
  return probed.reduce((s, m) => s + m.buffer.byteLength, 0);
}

export async function measureMemory({ withUA = true } = {}) {
  const r = { t: performance.now(), crossOriginIsolated: !!globalThis.crossOriginIsolated,
              wasmHeapBytes: wasmHeapBytes(), wasmMemories: probed.length };
  if (performance.memory) r.jsHeapUsedBytes = performance.memory.usedJSHeapSize;
  if (withUA && r.crossOriginIsolated && performance.measureUserAgentSpecificMemory) {
    try {
      const m = await performance.measureUserAgentSpecificMemory();
      r.uaBytes = m.bytes;
      r.uaByType = {};
      for (const b of m.breakdown) for (const t of b.types) r.uaByType[t] = (r.uaByType[t] || 0) + b.bytes;
    } catch (e) { r.uaError = String(e); }
  }
  return r;
}
