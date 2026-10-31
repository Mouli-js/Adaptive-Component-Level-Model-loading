// Public-API tests that can run in Node (no Workers): option validation, error codes, export surface.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import * as pkg from '../src/index.js';
const { loadModel, AdaptiveLoaderError } = pkg;

const code = async (p) => { try { await p; return 'NO ERROR'; } catch (e) { assert.ok(e instanceof AdaptiveLoaderError, String(e)); return e.code; } };

test('loadModel requires manifestUrl', async () => {
  assert.equal(await code(loadModel()), 'BAD_OPTIONS');
  assert.equal(await code(loadModel({ manifestUrl: 42 })), 'BAD_OPTIONS');
});

test('refuses to run without cross-origin isolation (default)', async () => {
  assert.equal(await code(loadModel({ manifestUrl: '/m.json' })), 'NOT_ISOLATED');
});

test('reports missing Web Workers when isolation is not required', async () => {
  assert.equal(await code(loadModel({ manifestUrl: '/m.json', requireIsolation: false })), 'NO_WORKERS');
});

test('errors carry a code and a readable message', () => {
  const e = new AdaptiveLoaderError('NO_FEASIBLE_PLAN', 'nothing fits', { x: 1 });
  assert.equal(e.code, 'NO_FEASIBLE_PLAN'); assert.match(e.message, /^\[NO_FEASIBLE_PLAN\] nothing fits/); assert.deepEqual(e.details, { x: 1 });
});

test('every name documented in the README is exported', () => {
  const readme = fs.readFileSync(new URL('../README.md', import.meta.url), 'utf8');
  const adv = readme.split('## Advanced')[1].split('##')[0];
  const names = [...adv.matchAll(/`([A-Za-z]+)`/g)].map(m => m[1]);
  assert.ok(names.length >= 15);
  for (const n of [...names, 'loadModel', 'AdaptiveModel', 'AdaptiveLoaderError', 'PROFILES']) assert.ok(n in pkg, `missing export ${n}`);
});

test('type definitions declare the public API', () => {
  const dts = fs.readFileSync(new URL('../index.d.ts', import.meta.url), 'utf8');
  for (const s of ['function loadModel', 'class AdaptiveModel', 'explainPlan(', 'previewPlan(', 'getCacheStats()', 'replan(', 'dispose()', 'class AdaptiveLoaderError', 'path: string[]', 'alternatives: AlternativeFamily[]'])
    assert.ok(dts.includes(s), s);
});

test('infer() on a disposed model rejects (does not throw synchronously)', async () => {
  const { AdaptiveModel } = pkg;
  const m = new AdaptiveModel({}, { labels: ['N', 'P'] }, null, null, null); m.dispose();
  let p; assert.doesNotThrow(() => { p = m.infer('x'); });
  await assert.rejects(p, e => e.code === 'DISPOSED');
  const s = await m.getCacheStats(); assert.equal(s.disposed, true); assert.equal(s.runtime.liveWorkers, 0);
});

test('summarizeAlternatives: one row per family; high + early exit -> early-exit families rejected for accuracy', async () => {
  const { summarizeAlternatives } = await import('../src/api.js');
  const { decide } = pkg;
  const root = new URL('../../../', import.meta.url);
  const manifest = JSON.parse(fs.readFileSync(new URL('models/onnx/manifest.json', root)));
  const ee = JSON.parse(fs.readFileSync(new URL('models/onnx/early_exit.json', root))).plans;
  const d = decide({ manifest, signals: { storage: { quota: 1e10, usage: 0 }, cachedSha256: [] }, profile: 'high', overrides: { earlyExit: true }, earlyExitTable: ee, trace: true });
  const rows = summarizeAlternatives(d.trace);
  assert.equal(rows.length, 18);                                   // 3 precisions × 3 modes × 2
  assert.equal(rows[0].status, 'chosen'); assert.equal(rows[0].family, 'fp32 · resident · full');
  const eeRows = rows.filter(r => r.earlyExit);
  assert.ok(eeRows.every(r => r.status === 'rejected' && /accuracy/.test(r.detail)), JSON.stringify(eeRows.map(r => r.detail)));
  assert.equal(rows.reduce((s, r) => s + r.candidates, 0), d.candidates.total);
});
