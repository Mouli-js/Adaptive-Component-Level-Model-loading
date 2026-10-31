/**
 * Phase 6 — browser test of the INSTALLED package (not the source tree):
 * builds a clean consumer project from the tarball, copies model artifacts + reference fixtures,
 * serves it with cross-origin isolation (the unchanged demo/server.mjs, root = consumer project)
 * and drives bench/phase6_consumer/app.js through the public API only.
 * Usage: node bench/phase6_browser_test.mjs <tarball> [projectRoot]
 */
import { createRequire } from 'node:module';
import { execSync } from 'node:child_process';
import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from '../demo/server.mjs';

const { chromium } = createRequire(import.meta.url)('playwright');
const ROOT = process.argv[3] || fileURLToPath(new URL('..', import.meta.url));
const tarball = path.resolve(process.argv[2]);
const app = fs.mkdtempSync(path.join(os.tmpdir(), 'p6app-'));
fs.writeFileSync(path.join(app, 'package.json'), JSON.stringify({ name: 'consumer-app', private: true, type: 'module' }));
execSync(`npm install --silent --no-audit --no-fund "${tarball}" onnxruntime-web@1.20.1`, { cwd: app, stdio: 'inherit' });
for (const f of ['index.html', 'app.js']) fs.copyFileSync(path.join(ROOT, 'bench/phase6_consumer', f), path.join(app, f));
fs.cpSync(path.join(ROOT, 'models/onnx'), path.join(app, 'models/onnx'), { recursive: true, filter: s => !s.endsWith('full.onnx') });
fs.mkdirSync(path.join(app, 'fixtures'));
for (const f of ['validation.json', 'wasm_chain_int8_logits.json', 'wasm_chain_fp32_logits.json', 'wasm_ee_int8.json'])
  fs.copyFileSync(path.join(ROOT, 'data/sst2', f), path.join(app, 'fixtures', f));

const server = createServer({ root: app, noCache: true }); await new Promise(r => server.listen(0, r));
const ctx = await chromium.launchPersistentContext(fs.mkdtempSync(path.join(os.tmpdir(), 'p6prof-')), { channel: 'chromium' });
const page = ctx.pages()[0] ?? await ctx.newPage();
const errors = []; page.on('pageerror', e => errors.push(String(e)));
await page.goto(`http://localhost:${server.address().port}/index.html`);
await page.waitForFunction(() => window.app?.ready, null, { timeout: 60000 });
const t0 = Date.now(); const r = await page.evaluate(() => window.app.run()); r.wallS = (Date.now() - t0) / 1000;
await ctx.close(); server.close();

const checks = []; const c = (n, ok, d) => checks.push({ name: n, ok: !!ok, detail: d });
c('no page errors', errors.length === 0, errors.join(' | ') || 'none');
c('low: engine chose int8 sequential', r.low.plan === 'int8|sequential|pin=-|G=1|pw=0|ee=0', r.low.plan);
c('low: outputs = reference (Δ = 0)', r.low.maxDiff === 0, r.low.maxDiff);
c('low: labels/scores consistent; single string -> object', r.low.labelsConsistent && r.low.singleIsObject, r.low.labelsConsistent);
c('low: 4 int8 chunks cached in IndexedDB', r.low.stats.persistent.entries.length === 4 && r.low.stats.persistent.entries.every(e => e.precision === 'int8'), r.low.stats.persistent.entries.map(e => e.name));
c('low: sequential leaves 0 live Workers between calls', r.low.stats.runtime.liveWorkers === 0, r.low.stats.runtime);
c('replan high: fp32 resident', r.high.explain.planId === 'fp32|resident|pin=c0+c1+c2+c3|G=1|pw=0|ee=0', r.high.explain.planId);
c('high: outputs = reference (Δ < 1e-4)', r.high.maxDiff < 1e-4, r.high.maxDiff);
c('high: 4 resident Workers, live WASM ≈ 813 MiB', r.high.stats.runtime.liveWorkers === 4 && Math.abs(r.high.stats.runtime.liveWasmMiB - 813.31) < 1, r.high.stats.runtime.liveWasmMiB);
c('replan(earlyExit) without metadata -> EARLY_EXIT_UNAVAILABLE', r.earlyExitWithoutMeta === 'EARLY_EXIT_UNAVAILABLE', r.earlyExitWithoutMeta);
c('dispose: 0 live Workers; infer -> DISPOSED', r.afterDispose.stats.liveWorkers === 0 && r.afterDispose.inferCode === 'DISPOSED', r.afterDispose);
c('early exit opt-in: plan ee=1', /ee=1$/.test(r.earlyExit.plan), r.earlyExit.plan);
c('early exit: outputs and exit points = reference', r.earlyExit.maxDiff === 0 && r.earlyExit.exitMismatch === 0, r.earlyExit);
c('clearCache empties IndexedDB', r.earlyExit.entriesAfterClear === 0, r.earlyExit.entriesAfterClear);
c('infeasible budget -> NO_FEASIBLE_PLAN with explanation', r.infeasible.code === 'NO_FEASIBLE_PLAN' && r.infeasible.hasExplanation && r.infeasible.feasible === false, r.infeasible);
c('cache: false -> nothing stored', r.noCache.enabled === false && r.noCache.entries.length === 0, r.noCache.enabled);
c('loadModel({}) -> BAD_OPTIONS', r.badOptions === 'BAD_OPTIONS', r.badOptions);
c('infer results carry the execution path (4 chunks, full model)', r.low.paths.every(x => x === 'c0_embed>c1_l0_1>c2_l2_3>c3_l4_5_cls') && r.low.timesOk, r.low.paths[0]);
c('explainPlan: one alternatives row per family, covering every candidate', r.low.alternatives === 9 && r.low.altCandidates === 237, `${r.low.alternatives} rows / ${r.low.altCandidates}`);
c('explainPlan: early exit status (off) and signal sources present', r.low.eeStatus.requested === false && r.low.ctxSources > 0, r.low.eeStatus.reason);
c('previewPlan returns a plan without changing the running one', r.low.preview.previewId === 'fp32|resident|pin=c0+c1+c2+c3|G=1|pw=0|ee=0' && r.low.preview.unchanged, r.low.preview);
c('early exit: τ reported; path ends at the exit head or C3', r.earlyExit.tau === 0.95 && r.earlyExit.pathsConsistent, `τ ${r.earlyExit.tau}`);
const outDir = path.join(ROOT, 'results/phase6'); fs.mkdirSync(outDir, { recursive: true });
fs.writeFileSync(path.join(outDir, process.env.OUT_NAME || 'consumer_browser_test.json'), JSON.stringify({ date: new Date().toISOString(), tarball: path.basename(tarball), result: r, checks }, null, 2));
for (const x of checks) console.log(x.ok ? 'PASS' : 'FAIL', x.name, '-', typeof x.detail === 'object' ? JSON.stringify(x.detail).slice(0, 160) : x.detail);
console.log(`wall ${r.wallS}s`);
process.exit(checks.every(x => x.ok) ? 0 : 1);
