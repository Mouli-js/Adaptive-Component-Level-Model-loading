// Decision-engine tests: profiles -> plans, hard constraints, determinism, early-exit opt-in.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { decide, generateCandidates } from '../src/engine/planner.js';
import { applyProfile, usableBudget } from '../src/engine/monitor.js';
import { predictMemory, chunkInfo } from '../src/engine/costModel.js';

const root = new URL('../../../', import.meta.url);
const manifest = JSON.parse(fs.readFileSync(new URL('models/onnx/manifest.json', root)));
const eePath = new URL('results/phase5/early_exit_wasm.json', root);
const eeTable = fs.existsSync(eePath) ? JSON.parse(fs.readFileSync(eePath)) : null;
const signals = { storage: { quota: 10e9, usage: 0 }, cachedSha256: [], crossOriginIsolated: true };
const run = (profile, overrides = {}) => decide({ manifest, signals, profile, overrides, earlyExitTable: eeTable });

test('usable budget keeps the reserve (never 100% of the allowance)', () => {
  const b = usableBudget(applyProfile(signals, 'mid'));
  assert.equal(b.allowanceMiB, 512); assert.equal(b.usableMiB, 512 * 0.85); assert.ok(b.reserveMiB > 0);
});

test('profile values override browser signals and record their source', () => {
  const ctx = applyProfile({ ...signals, deviceMemoryGiB: 16, cores: 8 }, 'low');
  assert.equal(ctx.deviceMemoryGiB, 1); assert.equal(ctx.sources.deviceMemoryGiB, 'profile:low');
  const b = applyProfile({ ...signals, deviceMemoryGiB: 16 }, null);
  assert.equal(b.sources.deviceMemoryGiB, 'browser'); assert.equal(b.allowanceMiB, 2048);   // 16 GiB × 12.5% capped at 2048
});

test('candidate generation: 237 plans, early-exit variants only on opt-in', () => {
  assert.equal(generateCandidates().length, 237);
  assert.equal(generateCandidates().filter(p => p.earlyExit).length, 0);
  assert.equal(generateCandidates({ earlyExit: true }).length, 474);
});

test('memory prediction reports every component and they sum to the peak', () => {
  const plan = { precision: 'int8', pinned: [], groupSize: 8, prewarm: true, earlyExit: false };
  const m = predictMemory(plan, chunkInfo(manifest, plan), applyProfile(signals, 'mid'));
  for (const k of ['workerWasmMiB', 'pageTensorsMiB', 'cachedBytesMiB', 'browserOverheadMiB']) assert.ok(k in m, k);
  assert.ok(Math.abs(m.workerWasmMiB + m.pageTensorsMiB + m.cachedBytesMiB + m.browserOverheadMiB - m.peakMiB) < 1e-9);
  assert.equal(m.maxLiveWorkers, 2);                       // prewarm: current + next
});

const EXPECTED = [   // profile, sentencesPerRequest, expected plan id   (derivations in the Phase 5 report §5)
  ['low', 1, 'int8|sequential|pin=-|G=1|pw=0|ee=0'],
  ['low', 64, 'int8|sequential|pin=-|G=32|pw=0|ee=0'],
  ['mid', 1, 'mixedC2|resident|pin=c0+c1+c2+c3|G=1|pw=0|ee=0'],
  ['high', 1, 'fp32|resident|pin=c0+c1+c2+c3|G=1|pw=0|ee=0'],
];
for (const [p, spr, id] of EXPECTED)
  test(`profile ${p}, ${spr} sentence(s)/request -> ${id}`, () => assert.equal(run(p, { sentencesPerRequest: spr }).plan.id, id));

test('deterministic: identical inputs give byte-identical decisions', () => {
  for (const p of ['low', 'mid', 'high']) assert.equal(JSON.stringify(run(p)), JSON.stringify(run(p)));
});

test('hard constraints are never violated across a sweep of budgets and accuracy floors', () => {
  let feasibleCount = 0;
  for (const allowanceMiB of [60, 100, 128, 150, 200, 260, 300, 400, 512, 700, 1000, 1536, 2048])
    for (const minAccuracy of [0.85, 0.90, 0.905, 0.91, 0.92])
      for (const sentencesPerRequest of [1, 64]) {
        const d = run('mid', { allowanceMiB, minAccuracy, sentencesPerRequest });
        if (!d.feasible) { assert.equal(d.plan, null); assert.ok(d.explanation.length >= 2); continue; }
        feasibleCount++;
        assert.ok(d.predicted.memory.peakMiB <= d.budget.usableMiB + 1e-9, `memory ${allowanceMiB}`);
        assert.ok(d.predicted.accuracy >= minAccuracy, `accuracy ${minAccuracy}`);
      }
  assert.ok(feasibleCount > 0);
});

test('a larger budget never shrinks the feasible set', () => {
  let prev = -1;
  for (const a of [60, 100, 150, 300, 600, 1200, 2400]) { const n = run('mid', { allowanceMiB: a }).candidates.feasible; assert.ok(n >= prev); prev = n; }
});

test('infeasible: tiny budget or impossible accuracy returns no plan, with reasons', () => {
  const d1 = run('low', { allowanceMiB: 60 }); assert.equal(d1.feasible, false); assert.match(d1.explanation.join(' '), /No plan/);
  const d2 = run('high', { minAccuracy: 0.95 }); assert.equal(d2.feasible, false); assert.ok(d2.candidates.rejected.accuracy > 0);
});

test('early exit: off by default; on opt-in it is still subject to the accuracy floor', { skip: !eeTable && 'no measured early-exit table' }, () => {
  assert.equal(run('low').plan.earlyExit, false);
  const d = run('low', { earlyExit: true });
  assert.equal(d.plan.earlyExit, false);                    // int8 + early exit = 89.91% < 90.0% floor -> rejected
  assert.ok(d.candidates.rejected.accuracy > 0);
  const d2 = run('low', { earlyExit: true, minAccuracy: 0.895 });
  assert.equal(d2.plan.earlyExit, true);                    // allowed once the floor admits its measured accuracy
  const noTable = decide({ manifest, signals, profile: 'low', overrides: { earlyExit: true } });
  assert.ok(noTable.candidates.rejected.unverified > 0);    // unmeasured accuracy is never accepted
});

test('explanation names the budget, constraints, predicted costs and the runner-up', () => {
  const e = run('mid').explanation.join('\n');
  for (const s of ['usable', 'reserve', 'rejected', 'Predicted peak memory', 'per sentence', 'weighted cost', 'next best']) assert.ok(e.includes(s), s);
});
