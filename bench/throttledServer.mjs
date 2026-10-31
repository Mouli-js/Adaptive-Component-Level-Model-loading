/**
 * Bandwidth-limited static server for experiments (the baseline demo/server.mjs is untouched).
 * Same COOP/COEP/CORP headers, plus:
 *   - a shared token-bucket bandwidth limit (bytes/s) across ALL concurrent responses, which is
 *     what a real access link does (also Workers' fetches, unlike DevTools page-level throttling)
 *   - a fixed per-request latency (RTT/2 before the first byte)
 * Only *.onnx files are throttled; page code and data load at full speed so that only
 * model-transfer time is affected.
 */
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.mjs': 'text/javascript', '.json': 'application/json',
  '.wasm': 'application/wasm', '.onnx': 'application/octet-stream', '.txt': 'text/plain; charset=utf-8' };
const sleep = ms => new Promise(r => setTimeout(r, ms));

export function createThrottledServer({ bytesPerSec, latencyMs = 0, root = ROOT }) {
  let available = 0, last = Date.now();
  const take = async n => {                         // shared token bucket, refilled continuously
    for (;;) {
      const now = Date.now(); available = Math.min(bytesPerSec * 0.1, available + (now - last) / 1000 * bytesPerSec); last = now;
      if (available >= n) { available -= n; return; }
      await sleep(Math.max(1, ((n - available) / bytesPerSec) * 1000));
    }
  };
  const stats = { onnxBytes: 0, onnxRequests: 0 };
  const server = http.createServer(async (req, res) => {
    const urlPath = decodeURIComponent(new URL(req.url, 'http://x').pathname);
    const file = path.normalize(path.join(root, urlPath));
    if (!file.startsWith(root + path.sep) || !fs.existsSync(file) || !fs.statSync(file).isFile()) { res.writeHead(404).end(); return; }
    const size = fs.statSync(file).size, throttle = file.endsWith('.onnx');
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream', 'Content-Length': size,
      'Cross-Origin-Opener-Policy': 'same-origin', 'Cross-Origin-Embedder-Policy': 'require-corp',
      'Cross-Origin-Resource-Policy': 'same-origin', 'Cache-Control': 'no-store' });
    if (!throttle) { fs.createReadStream(file).pipe(res); return; }
    stats.onnxRequests++; stats.onnxBytes += size;
    if (latencyMs) await sleep(latencyMs);
    const fd = fs.openSync(file, 'r'), CH = 64 * 1024, buf = Buffer.alloc(CH);
    try {
      for (let off = 0; off < size; off += CH) {
        const n = fs.readSync(fd, buf, 0, Math.min(CH, size - off), off);
        await take(n);
        if (!res.write(Buffer.from(buf.subarray(0, n)))) await new Promise(r => res.once('drain', r));
      }
    } finally { fs.closeSync(fd); res.end(); }
  });
  server.stats = stats;
  return server;
}
