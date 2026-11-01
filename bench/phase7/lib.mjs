/**
 * Phase 7 harness library (Node side).
 * - one browser PROCESS per run (fresh profile dir = cold; reused dir = warm), so runs never share heap state
 * - throttled static server (bench/throttledServer.mjs) for every run; "unthrottled" = a 1e12 B/s cap
 * - append-only JSONL results, resumable: a run whose key is already in the file is skipped
 * - optional CDP CPU throttling (page target, and optionally every dedicated Worker target)
 */
import { createRequire } from 'node:module';
import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createThrottledServer } from '../throttledServer.mjs';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const { chromium } = createRequire(import.meta.url)('playwright');
export const UNTHROTTLED = 1e12;

// FIXED port per link speed: IndexedDB is per ORIGIN (scheme + host + port). With random ports, a profile primed in
// one invocation looked EMPTY in the next one (found by the validator in the suite smoke test), so warm runs would
// silently have become cold. port: 0 keeps the old random-port behaviour (pilot only).
export const PORTS = { 0: 8790, 50: 8750, 20: 8720, 10: 8710, 5: 8705 };
export async function startServer({ mbps = null, rttMs = 0, port = PORTS[mbps || 0] }) {
  const server = createThrottledServer({ bytesPerSec: mbps ? mbps * 1e6 / 8 : UNTHROTTLED, latencyMs: mbps ? rttMs / 2 : 0, root: ROOT });
  await new Promise((r, j) => { server.once('error', j); server.listen(port, '127.0.0.1', r); });
  server.base = `http://localhost:${server.address().port}`;              // always 'localhost' (127.0.0.1 would be another origin)
  return server;
}

export const newProfile = (tag = 'p7') => fs.mkdtempSync(path.join(os.tmpdir(), `${tag}-`));

export async function openRunner(profileDir, base, { uaMemory = false } = {}) {
  const ctx = await chromium.launchPersistentContext(profileDir, { channel: 'chromium',
    args: uaMemory ? ['--enable-blink-features=ForceEagerMeasureMemory'] : [] });
  const page = ctx.pages()[0] ?? await ctx.newPage();
  const errors = []; page.on('pageerror', e => errors.push(String(e))); page.on('crash', () => errors.push('page crashed'));
  await page.goto(`${base}/bench/phase7/runner.html`);
  await page.waitForFunction(() => window.p7?.ready, null, { timeout: 120000 });
  return { ctx, page, errors, browserVersion: ctx.browser()?.version() ?? null };
}

/** Run one config in a fresh browser process. Returns the page's result + server-side byte counts. */
export async function runOnce({ server, profileDir, cfg, uaMemory = false, timeoutMs = 600000 }) {
  const { ctx, page, errors } = await openRunner(profileDir, server.base, { uaMemory });
  const before = { ...server.stats }; const t0 = Date.now();
  try {
    const cacheBefore = await page.evaluate(() => window.p7.cacheState());
    const r = await page.evaluate(c => window.p7.run(c), cfg);
    const cacheAfter = await page.evaluate(() => window.p7.cacheState());
    r.server = { onnxBytes: server.stats.onnxBytes - before.onnxBytes, onnxRequests: server.stats.onnxRequests - before.onnxRequests };
    r.cacheBefore = { entries: cacheBefore.entries, bytes: cacheBefore.bytes }; r.cacheAfter = { entries: cacheAfter.entries, bytes: cacheAfter.bytes };
    r.wallS = (Date.now() - t0) / 1000; r.errors = errors; r.env = await page.evaluate(() => window.p7.env());
    return r;
  } finally { await ctx.close(); }
}

export function jsonl(file) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  // done = keys with a SUCCESSFUL row. A failed row stays in the file (never deleted) and its key is retried;
  // the retry row carries retryOf = number of earlier failures, so every re-run is visible in the data.
  const done = new Set(), failures = new Map();
  if (fs.existsSync(file)) for (const l of fs.readFileSync(file, 'utf8').split('\n')) if (l.trim()) {
    const r = JSON.parse(l); if (r.failed) failures.set(r.key, (failures.get(r.key) || 0) + 1); else done.add(r.key); }
  return { done, failures, append: row => fs.appendFileSync(file, JSON.stringify(failures.has(row.key) && !row.failed ? { ...row, retryOf: failures.get(row.key) } : row) + '\n') };
}

export function envSnapshot() {
  return { date: new Date().toISOString(), node: process.version, platform: `${os.type()} ${os.release()} ${os.arch()}`,
           cpus: os.cpus().length, cpuModel: os.cpus()[0]?.model, totalMemGiB: +(os.totalmem() / 2 ** 30).toFixed(1) };
}

/** Seeded shuffle (mulberry32) for randomised run order. */
export function shuffle(a, seed) {
  let t = seed >>> 0; const rnd = () => { t += 0x6D2B79F5; let r = Math.imul(t ^ t >>> 15, 1 | t); r ^= r + Math.imul(r ^ r >>> 7, 61 | r); return ((r ^ r >>> 14) >>> 0) / 4294967296; };
  const b = [...a]; for (let i = b.length - 1; i > 0; i--) { const j = Math.floor(rnd() * (i + 1)); [b[i], b[j]] = [b[j], b[i]]; } return b;
}
