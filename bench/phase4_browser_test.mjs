/**
 * Phase 4 automated browser test. Uses Playwright PERSISTENT contexts (a real on-disk browser
 * profile), so IndexedDB survives closing and relaunching the browser: each "visit" is a new
 * browser process on the same profile, exactly like a user coming back later.
 *
 * Scenarios
 *   NOCACHE  : 1 request, sequential mode, no cache            (Phase 3 behaviour, reference)
 *   REVISIT  : visit 1 = cold + immediate repeat, visits 2–3 = warm   (H5, M6)
 *   BUDGET   : 3 visits with a disk budget below / above the model size (LRU behaviour)
 *   CORRUPT  : tamper with one stored chunk -> must be detected, re-fetched, repaired
 *   POOL     : WorkerPool hot tier, unlimited and under a heap budget
 *   COST     : per-chunk fetch / SHA-256 / IndexedDB put / read cost
 * Usage: PRECISION=int8|fp32 node bench/phase4_browser_test.mjs
 */
import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createServer } from '../demo/server.mjs';

const { chromium } = createRequire(import.meta.url)('playwright');
const ROOT = new URL('../', import.meta.url);
const P = process.env.PRECISION || 'int8';
const TOTAL_MIB = { int8: 64.2, fp32: 255.5 }[P];
const BUDGETS = { int8: [45, 70], fp32: [150, 270] }[P];     // below / above the model size
const POOL_BUDGET = { int8: 120, fp32: 450 }[P];
const TOL = P === 'int8' ? 0 : 1e-4;

const server = createServer({ noCache: true });
await new Promise(r => server.listen(0, r));
const URL_ = `http://localhost:${server.address().port}/demo/phase4-cache.html`;
const results = {}, checks = [];
const check = (s, name, ok, detail) => { checks.push({ scenario: s, name, ok: !!ok, detail }); };

async function visit(profileDir, fn) {
  const ctx = await chromium.launchPersistentContext(profileDir, { channel: 'chromium', args: ['--enable-blink-features=ForceEagerMeasureMemory'] });
  const page = ctx.pages()[0] ?? await ctx.newPage();
  const errors = []; page.on('pageerror', e => errors.push(String(e)));
  await page.goto(URL_); await page.waitForFunction(() => window.phase4?.ready, null, { timeout: 60000 });
  try { return { ...(await page.evaluate(fn.toString().startsWith('async') ? `(${fn})()` : fn)), pageErrors: errors }; }
  finally { await ctx.close(); }
}
const newProfile = () => fs.mkdtempSync(path.join(os.tmpdir(), 'p4-profile-'));
const call = (expr) => `(async () => { const p = window.phase4; return ${expr}; })()`;
const block = (body) => `(async () => { const p = window.phase4; ${body} })()`;   // several statements
const srcs = r => r.loads.map(l => l.source).join(',');

// NOCACHE
results.NOCACHE = await visit(newProfile(), call(`p.singleRequest({ precision: '${P}', useCache: false })`));
check('NOCACHE', 'output = reference', results.NOCACHE.maxAbsDiffVsRef <= TOL, results.NOCACHE.maxAbsDiffVsRef);

// REVISIT
{
  const dir = newProfile();
  const v1 = await visit(dir, block(`const a = await p.storageInfo(); await p.clearCache(); const cold = await p.singleRequest({ precision: '${P}' });
                                      const repeat = await p.singleRequest({ precision: '${P}' }); return { storage: a, cold, repeat };`));
  const v2 = await visit(dir, call(`{ warm: await p.singleRequest({ precision: '${P}' }) }`));
  const v3 = await visit(dir, call(`{ warm: await p.singleRequest({ precision: '${P}' }), storage: await p.storageInfo() }`));
  results.REVISIT = { v1, v2, v3 };
  const all = [v1.cold, v1.repeat, v2.warm, v3.warm];
  check('REVISIT', 'every request = reference', all.every(r => r.maxAbsDiffVsRef <= TOL), all.map(r => r.maxAbsDiffVsRef));
  check('REVISIT', 'cold: all 4 chunks from network and stored', v1.cold.loads.every(l => l.source === 'network' && l.stored), srcs(v1.cold));
  for (const [k, r] of [['visit1 repeat', v1.repeat], ['visit2', v2.warm], ['visit3', v3.warm]])
    check('REVISIT', `${k}: all 4 chunks from IndexedDB (hit rate 1)`, r.hitRate === 1, srcs(r));
  check('REVISIT', 'warm request faster than cold', v2.warm.totalMs < v1.cold.totalMs, `${v1.cold.totalMs} → ${v2.warm.totalMs} ms`);
  check('REVISIT', 'no page errors', [v1, v2, v3].every(v => v.pageErrors.length === 0), [v1, v2, v3].flatMap(v => v.pageErrors).join(' | ') || 'none');
}

// BUDGET
for (const b of BUDGETS) {
  const dir = newProfile(); const visits = [];
  for (let i = 0; i < 3; i++) visits.push(await visit(dir, call(`p.singleRequest({ precision: '${P}', cacheBudgetMiB: ${b} })`)));
  results[`BUDGET_${b}`] = visits;
  const maxStored = Math.max(...visits.map(v => v.storeAfter.reduce((s, x) => s + x.sizeMiB, 0)));
  check(`BUDGET_${b}`, 'stored bytes never exceed the budget', maxStored <= b, `${maxStored.toFixed(1)} ≤ ${b} MiB`);
  check(`BUDGET_${b}`, 'outputs = reference', visits.every(v => v.maxAbsDiffVsRef <= TOL), visits.map(v => v.maxAbsDiffVsRef));
  check(`BUDGET_${b}`, `hit rate on visits 2–3 recorded (${b < TOTAL_MIB ? 'budget < model' : 'budget ≥ model'})`, true,
        visits.map(v => v.hitRate).join(', ') + ' | ' + visits.map(srcs).join(' / '));
  if (b >= TOTAL_MIB) check(`BUDGET_${b}`, 'budget ≥ model: visits 2–3 hit rate 1', visits[1].hitRate === 1 && visits[2].hitRate === 1, visits.map(v => v.hitRate));
}

// CORRUPT
results.CORRUPT = await visit(newProfile(), call(`p.corruptionTest({ precision: '${P}' })`));
{ const c = results.CORRUPT;
  check('CORRUPT', 'tampered bytes have a different hash', c.tamperedHashDiffers, c.tamperedHashDiffers);
  check('CORRUPT', 'corruption detected and entry evicted', c.detected, c.detected);
  check('CORRUPT', 'chunk re-fetched from network', c.refetchedFrom === 'network', c.refetchedFrom);
  check('CORRUPT', 'other chunks still served from IndexedDB', c.others.every(s => s === 'idb'), c.others.join(','));
  check('CORRUPT', 'output = reference', c.maxAbsDiffVsRef <= TOL, c.maxAbsDiffVsRef);
  check('CORRUPT', 'store repaired with the good copy', c.storeRepaired, c.storeRepaired); }

// POOL
results.POOL = await visit(newProfile(), call(`{ unlimited: await p.poolTest({ precision: '${P}', limit: 30 }),
                                                 budget: await p.poolTest({ precision: '${P}', budgetMiB: ${POOL_BUDGET}, limit: 10 }) }`));
{ const u = results.POOL.unlimited, b = results.POOL.budget;
  check('POOL', 'unlimited: outputs = reference', u.maxAbsDiffVsRef <= TOL, u.maxAbsDiffVsRef);
  check('POOL', 'unlimited: 4 misses then all hits', u.poolStats.misses === 4 && u.poolStats.hits === 4 * 30 - 4, JSON.stringify(u.poolStats));
  check('POOL', `budget ${POOL_BUDGET} MiB: outputs = reference`, b.maxAbsDiffVsRef <= TOL, b.maxAbsDiffVsRef);
  check('POOL', `budget ${POOL_BUDGET} MiB: peak live heap within budget`, b.withinBudget && b.poolStats.overBudget === 0, `${b.peakLiveHeapMiB} MiB, ${JSON.stringify(b.poolStats)}`); }

// COST
results.COST = await visit(newProfile(), call(`p.verifyCost({ precision: '${P}' })`));
check('COST', 'all hashes match the manifest', results.COST.chunks.every(c => c.hashOk && c.readBackOk), results.COST.chunks.map(c => c.hashOk));

server.close();
fs.mkdirSync(new URL('results/phase4/', ROOT), { recursive: true });
fs.writeFileSync(new URL(`results/phase4/cloud_${P}.json`, ROOT), JSON.stringify({ date: new Date().toISOString(), precision: P, results, checks }, null, 2));
for (const c of checks) console.log(c.ok ? 'PASS' : 'FAIL', c.scenario, c.name, '-', typeof c.detail === 'object' ? JSON.stringify(c.detail) : c.detail);
process.exit(checks.every(c => c.ok) ? 0 : 1);
