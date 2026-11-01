// Fixed amount of pure-JS work inside a dedicated Worker (no I/O), timed inside the Worker.
const busy = n => { let x = 0; for (let i = 0; i < n; i++) x = (x + Math.sqrt(i * 1.0001)) % 1e9; return x; };
self.onmessage = e => { const t = performance.now(); const x = busy(e.data.n); self.postMessage({ ms: performance.now() - t, x }); };
