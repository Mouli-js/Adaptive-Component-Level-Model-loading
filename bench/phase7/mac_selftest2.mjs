/** Self-test of the 1 Nov Mac-page changes (?only=, foreground guard, archive-on-start). Cloud headless Chromium,
 *  served exactly as on the Mac. Quick mode only: NOT results. */
import { createRequire } from 'node:module'; import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path';
import { createServer } from '../../demo/server.mjs';
const { chromium } = createRequire(import.meta.url)('playwright');
const OUT = '/home/claude/p1/results/phase7/_smoke/mac_selftest2.json';
const server = createServer({ noCache: true }); await new Promise(r => server.listen(8080, r));
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'macself2-'));
const ctx = await chromium.launchPersistentContext(dir, { channel: 'chromium', acceptDownloads: true, headless: !process.env.HEADED });
const page = ctx.pages()[0] ?? await ctx.newPage(); const errors = [];
// TEST-ONLY visibility simulation (headless / Xvfb windows never become hidden): document.visibilityState reads a
// sessionStorage flag, so the simulated state survives the page's self-reloads; the real 'visibilitychange' event is fired.
if (process.env.SIMULATE_HIDDEN) await page.addInitScript(() => {
  Object.defineProperty(Document.prototype, 'visibilityState', { configurable: true, get() { return sessionStorage.getItem('fakeHidden') ? 'hidden' : 'visible'; } });
  Object.defineProperty(Document.prototype, 'hidden', { configurable: true, get() { return !!sessionStorage.getItem('fakeHidden'); } }); });
const setHidden = h => page.evaluate(h => { if (h) sessionStorage.setItem('fakeHidden', '1'); else sessionStorage.removeItem('fakeHidden'); document.dispatchEvent(new Event('visibilitychange')); }, h).catch(() => 'reloading'); page.on('pageerror', e => errors.push(String(e)));
const state = async () => { try { return await page.evaluate(async () => { const s = await window.p7mac?.kvGet('state'); return s ? { i: s.i, n: s.queue.length, step: s.queue[s.i]?.key, only: s.only, guardPauses: s.guardPauses ?? 0, inProgress: s.inProgress } : null; }); } catch { return null; } };
const waitDone = async (label, onTick) => { const t0 = Date.now(); for (;;) { await new Promise(r => setTimeout(r, 2000)); const s = await state(); if (s) fs.appendFileSync('/tmp/claude-0/st2.log', `${label} ${s.i}/${s.n} inProgress=${s.inProgress} pauses=${s.guardPauses}\n`); if (onTick) await onTick(s, Date.now() - t0); if (s && s.i >= s.n) return s; if (Date.now() - t0 > 400000) throw new Error('timeout ' + label); } };
// run 1: quick full run (stands in for your earlier run)
await page.goto('http://localhost:8080/bench/phase7-mac.html?quick=1'); await page.waitForFunction(() => window.p7mac, null, { timeout: 120000 });
await page.click('#start'); const s1 = await waitDone('run1'); console.log('run 1 finished', s1.i, 'steps');
// run 2: ?only=MAC-2,MAC-3,MAC-4, with a hidden period in the middle
await page.goto('http://localhost:8080/bench/phase7-mac.html?quick=1&only=MAC-2,MAC-3,MAC-4'); await page.waitForFunction(() => window.p7mac, null, { timeout: 120000 });
await page.click('#start');
let hid = false, hid2 = false, other = null, visLog = [];
// scenario 2: hide for 1 s WHILE a step is running (poll every 50 ms for a step in progress), from step 9 on
const midStep = (async () => { while (!hid2) { await new Promise(r => setTimeout(r, 50)); const s = await state(); if (s && s.inProgress != null) fs.appendFileSync('/tmp/claude-0/st2.log', `poll i=${s.i} inProgress=${s.inProgress} hid=${hid}\n`);
  if (hid && s && s.i >= 9 && s.inProgress === s.i && s.i < s.n) { hid2 = true; await setHidden(true); await new Promise(r => setTimeout(r, 1000)); await unhide(); visLog.push(`mid-step hide during step ${s.i + 1} (${s.step})`); } } })();
async function unhide() { for (let k = 0; k < 100; k++) { const r = await setHidden(false); let v = null; try { v = await page.evaluate(() => document.visibilityState); } catch {} if (r !== 'reloading' && v === 'visible') return; await new Promise(r => setTimeout(r, 200)); } throw new Error('could not un-hide'); }
await waitDone('run2', async (s, t) => {
  if (!hid && s && s.i >= 4) { hid = true;
    for (let k = 0; k < 10 && (await setHidden(true)) === 'reloading'; k++) await new Promise(r => setTimeout(r, 200));
    await new Promise(r => setTimeout(r, 300)); try { visLog.push('after hide: ' + await page.evaluate(() => document.visibilityState)); } catch { visLog.push('after hide: n/a (reloading)'); }
    await new Promise(r => setTimeout(r, 8000)); const s2 = await state(); visLog.push(`8 s hidden: step ${s2?.i}, guardPauses ${s2?.guardPauses}`);
    try { visLog.push('status text: ' + await page.textContent('#status')); } catch {}
    await unhide();
    await new Promise(r => setTimeout(r, 1500)); const s3 = await state(); visLog.push(`after unhide: step ${s3?.i}`); }
});
hid2 = true; await midStep.catch(() => {});
await page.waitForFunction(() => window.p7mac, null, { timeout: 60000 });
const [dl] = await Promise.all([page.waitForEvent('download'), page.click('#download')]); await dl.saveAs(OUT);
const archives = await page.evaluate(async () => (await window.p7mac.kvGet('archives')) ?? []);
await ctx.close(); server.close(); fs.rmSync(dir, { recursive: true, force: true });
const j = JSON.parse(fs.readFileSync(OUT));
const blocks = [...new Set(j.rows.map(r => r.block))];
console.log('visibility while hidden:', visLog.join(' | '));
console.log('only:', j.only, '| blocks in rows:', blocks.join(','), '| archived earlier runs:', archives.length, j.archivedEarlierRuns.length, '| guardPauses:', j.guardPauses);
console.log('rows', j.rows.length, 'failed', j.rows.filter(r => r.failed).length, 'anomalous (hidden) rows', j.rows.filter(r => r.anomaly).length, 'pageErrors', errors.length, errors.slice(0, 2));
for (const r of j.rows.filter(r => r.anomaly || r.retryOf)) console.log('  ', r.key, r.anomaly ?? '', 'retryOf', r.retryOf ?? '-', JSON.stringify(r.visibility && { atStart: r.visibility.atStart, atEnd: r.visibility.atEnd, changes: r.visibility.changes, hiddenMs: r.visibility.hiddenMs }));
const keys = j.rows.filter(r => !r.failed && !r.anomaly).map(r => r.key); const dup = keys.filter((k, i) => keys.indexOf(k) !== i);
console.log('every clean row has visibility recorded:', j.rows.filter(r => !r.failed && !r.anomaly && r.visibility).length === j.rows.filter(r => !r.failed && !r.anomaly).length, '| duplicate clean keys:', dup.length, '| steps', j.completed + '/' + j.steps);
