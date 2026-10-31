/**
 * Phase 4 — H5 under a realistic link: cold vs warm single request (sequential mode, int8 or fp32)
 * through a bandwidth-limited server. Each visit = new browser process on the same profile.
 * Usage: PRECISION=int8 MBPS=20 RTT=40 node bench/phase4_throttled_test.mjs
 */
import { createRequire } from 'node:module';
import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path';
import { createThrottledServer } from './throttledServer.mjs';

const { chromium } = createRequire(import.meta.url)('playwright');
const P = process.env.PRECISION || 'int8', MBPS = Number(process.env.MBPS || 20), RTT = Number(process.env.RTT || 40);
const TOL = P === 'int8' ? 0 : 1e-4;
const server = createThrottledServer({ bytesPerSec: MBPS * 1e6 / 8, latencyMs: RTT / 2 });
await new Promise(r => server.listen(0, r));
const URL_ = `http://localhost:${server.address().port}/demo/phase4-cache.html`;

async function visit(dir, expr) {
  const ctx = await chromium.launchPersistentContext(dir, { channel: 'chromium' });
  const page = ctx.pages()[0] ?? await ctx.newPage();
  await page.goto(URL_); await page.waitForFunction(() => window.phase4?.ready, null, { timeout: 60000 });
  const before = server.stats.onnxBytes;
  try { const r = await page.evaluate(`(async () => { const p = window.phase4; ${expr} })()`); r.onnxBytesServed = server.stats.onnxBytes - before; return r; }
  finally { await ctx.close(); }
}
const prof = () => fs.mkdtempSync(path.join(os.tmpdir(), 'p4t-'));
const out = { precision: P, link: { mbps: MBPS, rttMs: RTT }, date: new Date().toISOString() };
out.noCache = await visit(prof(), `return p.singleRequest({ precision: '${P}', useCache: false });`);
const dir = prof();
out.cold = await visit(dir, `await p.clearCache(); return p.singleRequest({ precision: '${P}' });`);
out.warm = await visit(dir, `return p.singleRequest({ precision: '${P}' });`);
server.close();
const checks = [
  ['outputs = reference', [out.noCache, out.cold, out.warm].every(r => r.maxAbsDiffVsRef <= TOL)],
  ['warm request served 0 model bytes', out.warm.onnxBytesServed === 0],
  ['warm faster than cold', out.warm.totalMs < out.cold.totalMs],
];
out.checks = checks.map(([name, ok]) => ({ name, ok }));
const f = `results/phase4/throttled_${P}_${MBPS}mbps.json`;
fs.writeFileSync(new URL(`../${f}`, import.meta.url), JSON.stringify(out, null, 2));
const s = r => `${(r.totalMs / 1000).toFixed(2)} s, ${(r.onnxBytesServed / 1048576).toFixed(1)} MiB served, sources ${r.loads.map(l => l.source).join(',')}`;
console.log(`link ${MBPS} Mbit/s, RTT ${RTT} ms, ${P}\n  no cache : ${s(out.noCache)}\n  cold     : ${s(out.cold)}\n  warm     : ${s(out.warm)}`);
for (const c of out.checks) console.log(c.ok ? 'PASS' : 'FAIL', c.name);
process.exit(out.checks.every(c => c.ok) ? 0 : 1);
