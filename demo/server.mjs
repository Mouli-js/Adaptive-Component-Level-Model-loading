/**
 * Minimal static server with cross-origin isolation.
 *
 *   Cross-Origin-Opener-Policy: same-origin     \  together => self.crossOriginIsolated === true
 *   Cross-Origin-Embedder-Policy: require-corp  /
 *
 * Cross-origin isolation unlocks (a) SharedArrayBuffer -> multi-threaded WASM in
 * onnxruntime-web, and (b) performance.measureUserAgentSpecificMemory().
 * Serves the project root so pages can reach /models, /node_modules, /packages, /data.
 * Usage: node demo/server.mjs [port]      (env NO_CACHE=1 adds Cache-Control: no-store)
 */
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = Number(process.argv[2] || process.env.PORT || 8080);
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.mjs': 'text/javascript',
  '.json': 'application/json', '.wasm': 'application/wasm', '.onnx': 'application/octet-stream',
  '.txt': 'text/plain; charset=utf-8', '.css': 'text/css', '.md': 'text/markdown; charset=utf-8' };

export function createServer({ root = ROOT, noCache = process.env.NO_CACHE === '1' } = {}) {
  return http.createServer((req, res) => {
    const urlPath = decodeURIComponent(new URL(req.url, 'http://x').pathname);
    const file = path.normalize(path.join(root, urlPath === '/' ? '/demo/index.html' : urlPath));
    if (!file.startsWith(root + path.sep)) { res.writeHead(403).end('forbidden'); return; }  // block ../ traversal
    fs.stat(file, (err, st) => {
      if (err || !st.isFile()) { res.writeHead(404).end('not found'); return; }
      res.writeHead(200, {
        'Content-Type': MIME[path.extname(file)] || 'application/octet-stream',
        'Content-Length': st.size,
        'Cross-Origin-Opener-Policy': 'same-origin',
        'Cross-Origin-Embedder-Policy': 'require-corp',
        'Cross-Origin-Resource-Policy': 'same-origin',
        ...(noCache ? { 'Cache-Control': 'no-store' } : {}),
      });
      fs.createReadStream(file).pipe(res);
    });
  });
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  createServer().listen(PORT, () => console.log(`serving ${ROOT}\n  http://localhost:${PORT}/demo/phase2-baseline.html`));
}
