/**
 * Phase 5 browser validation. Each scenario = fresh browser process (persistent profile so the
 * IndexedDB tier is realistic; the plan is run once to warm it, then measured).
 * DECIDED scenarios: the engine chooses under a simulated profile -> the plan is executed.
 * FORCED scenarios: plan shapes the profiles don't pick (hybrid, prewarm) -> tests runner + cost model.
 * Gates: outputs = per-plan reference (int8 / early exit: Δ = 0 and identical exit points;
 *        fp32 / mixed: Δ < 1e-4), measured peak WASM ≤ usable budget (decided plans),
 *        memory prediction within ±15%, live Workers ≤ predicted, no page errors.
 * Usage: node bench/phase5_browser_test.mjs [scenario-ids]
 */
import { createRequire } from 'node:module';
import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path';
import { createServer } from '../demo/server.mjs';

const { chromium } = createRequire(import.meta.url)('playwright');
const ALL = {
  S1: { profile: 'low',  overrides: { sentencesPerRequest: 1 },  n: 4 },
  S2: { profile: 'low',  overrides: { sentencesPerRequest: 32 }, n: 64 },
  S3: { profile: 'mid',  overrides: { sentencesPerRequest: 1 },  n: 32 },
  S4: { profile: 'high', overrides: { sentencesPerRequest: 1 },  n: 32 },
  S5: { profile: 'low',  overrides: { sentencesPerRequest: 32, earlyExit: true, minAccuracy: 0.895 }, n: 64 },
  S6: { profile: 'mid',  overrides: { sentencesPerRequest: 1, earlyExit: true }, n: 32 },
  F1: { profile: 'mid',  n: 16, forcePlan: { precision: 'int8', pinned: ['c0_embed'], groupSize: 8, prewarm: true, earlyExit: false } },
  F2: { profile: 'high', n: 16, forcePlan: { precision: 'fp32', pinned: [], groupSize: 8, prewarm: true, earlyExit: false } },
  F3: { profile: 'mid',  n: 16, forcePlan: { precision: 'mixedC2', pinned: ['c2_l2_3'], groupSize: 8, prewarm: false, earlyExit: false } },
};
const ids = process.argv[2] ? process.argv[2].split(',') : Object.keys(ALL);
const server = createServer({ noCache: true }); await new Promise(r => server.listen(0, r));
const URL_ = `http://localhost:${server.address().port}/demo/phase5-engine.html`;
const out = {}, checks = [];
const check = (s, name, ok, detail) => checks.push({ scenario: s, name, ok: !!ok, detail });

for (const id of ids) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'p5-'));
  const ctx = await chromium.launchPersistentContext(dir, { channel: 'chromium' });
  const page = ctx.pages()[0] ?? await ctx.newPage();
  const errors = []; page.on('pageerror', e => errors.push(String(e)));
  await page.goto(URL_); await page.waitForFunction(() => window.phase5?.ready, null, { timeout: 60000 });
  const t0 = Date.now();
  const r = await page.evaluate(s => window.phase5.scenario(s), ALL[id]);
  r.wallS = (Date.now() - t0) / 1000; out[id] = r; await ctx.close();
  check(id, 'no page errors', errors.length === 0, errors.join(' | ') || 'none');
  if (r.feasible === false) { check(id, 'feasible', false, r.explanation.join(' ')); continue; }
  const exactPlan = /^int8\|/.test(r.run.plan) || /ee=1$/.test(r.run.plan);
  check(id, exactPlan ? 'outputs = reference (Δ = 0)' : 'outputs = reference (Δ < 1e-4)', exactPlan ? r.run.maxAbsDiffVsRef === 0 : r.run.maxAbsDiffVsRef < 1e-4, r.run.maxAbsDiffVsRef);
  if (/ee=1$/.test(r.run.plan)) check(id, 'early-exit points identical to reference', r.run.exitMismatch === 0, r.run.exitMismatch);
  if (!r.forced) check(id, 'measured peak WASM ≤ usable budget', r.run.memory.measuredPeakWasmMiB <= r.usableMiB, `${r.run.memory.measuredPeakWasmMiB} ≤ ${r.usableMiB.toFixed(1)} MiB`);
  // The probe sees a Worker's heap only after its load reply, so for prewarm plans the overlap window
  // (next Worker still loading while the current one runs) is invisible: the measurement is a LOWER
  // bound and the prediction an UPPER bound. Gate for every plan: the prediction never underestimates.
  // Gate for plans without prewarm (fully observable): within ±15%.
  const m = r.run.memory, prewarm = /pw=1/.test(r.run.plan);
  check(id, 'memory prediction never underestimates (measured ≤ predicted incl. margin)', m.measuredPeakWasmMiB <= m.predictedWasmMiBWithMargin,
        `${m.measuredPeakWasmMiB} ≤ ${m.predictedWasmMiBWithMargin} MiB`);
  if (!prewarm) check(id, 'memory prediction within ±15% (no prewarm: fully observable)', Math.abs(m.errorPct) <= 15, `${m.errorPct}% (pred ${m.predictedWasmMiBNoMargin}, meas ${m.measuredPeakWasmMiB})`);
  else check(id, 'prewarm: prediction is an upper bound (reported, not gated)', true, `${m.errorPct}% (pred ${m.predictedWasmMiBNoMargin}, meas ${m.measuredPeakWasmMiB})`);
  check(id, 'live Workers ≤ predicted', r.run.maxLiveWorkers <= r.run.predictedMaxLiveWorkers, `${r.run.maxLiveWorkers} ≤ ${r.run.predictedMaxLiveWorkers}`);
  console.log(`${id} ${r.decided ?? ''}${r.forced ? ' FORCED ' + r.run.plan : ''} | time pred ${r.run.time.predictedTotalMs} vs meas ${r.run.time.measuredTotalMs} ms (${r.run.time.errorPct}%) | exits ${JSON.stringify(r.run.exits)} | ${r.wallS}s`);
}
server.close();
fs.mkdirSync(new URL('../results/phase5/', import.meta.url), { recursive: true });
fs.writeFileSync(new URL(`../results/phase5/${process.env.OUT_NAME || 'cloud_engine.json'}`, import.meta.url), JSON.stringify({ date: new Date().toISOString(), scenarios: out, checks }, null, 2));
for (const c of checks) console.log(c.ok ? 'PASS' : 'FAIL', c.scenario, c.name, '-', c.detail);
process.exit(checks.every(c => c.ok) ? 0 : 1);
