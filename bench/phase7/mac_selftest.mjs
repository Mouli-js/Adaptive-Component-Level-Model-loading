/** Automated self-test of bench/phase7-mac.html in the cloud (quick mode). Serves the page exactly as on the Mac
 *  (demo/server.mjs, NO_CACHE, port 8080, http://localhost), clicks Start, follows the self-reloads, downloads the JSON. */
import { createRequire } from 'node:module'; import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path';
import { createServer } from '../../demo/server.mjs';
const { chromium } = createRequire(import.meta.url)('playwright');
const OUT = process.argv[2] || '/home/claude/p1/results/phase7/_smoke/mac_selftest.json';
const server = createServer({ noCache: true }); await new Promise(r => server.listen(8080, r));
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'macself-'));
const ctx = await chromium.launchPersistentContext(dir, { channel: 'chromium', acceptDownloads: true });
const page = ctx.pages()[0] ?? await ctx.newPage(); const errors = []; page.on('pageerror', e => errors.push(String(e)));
await page.goto('http://localhost:8080/bench/phase7-mac.html?quick=1'); await page.waitForFunction(() => window.p7mac, null, { timeout: 120000 });
await page.click('#start');
const t0 = Date.now(); let last = '';
for (;;) {
  await new Promise(r => setTimeout(r, 3000));
  let st; try { st = await page.evaluate(async () => { const s = await window.p7mac?.kvGet('state'); return s ? { i: s.i, n: s.queue.length, step: s.queue[s.i]?.key } : null; }); } catch { continue; }   // mid-reload
  if (!st) continue;
  const line = `${st.i}/${st.n} ${st.step ?? ''}`; if (line !== last) { console.log(((Date.now() - t0) / 1000).toFixed(0) + 's', line); last = line; }
  if (st.i >= st.n) break;
  if (Date.now() - t0 > 520000) { console.log('TIMEOUT'); break; }
}
await page.waitForFunction(() => window.p7mac, null, { timeout: 60000 });
const [dl] = await Promise.all([page.waitForEvent('download'), page.click('#download')]);
await dl.saveAs(OUT); await ctx.close(); server.close(); fs.rmSync(dir, { recursive: true, force: true });
const j = JSON.parse(fs.readFileSync(OUT));
console.log('rows', j.rows.length, 'failed', j.rows.filter(r => r.failed).length, 'pageErrors', errors.length, errors.slice(0, 3));
for (const r of j.rows) console.log(r.key, r.failed ? 'FAILED ' + r.error.slice(0, 160) : `${r.configId} thr ${r.pageThreads ?? r.threads} ref ${r.refCheck?.pass} cache ${r.cacheBefore?.entries ?? '-'} ${r.cachePrep ? JSON.stringify(r.cachePrep) : ''} ${r.createMs ? 'create ' + Math.round(r.createMs) : ''}`);
