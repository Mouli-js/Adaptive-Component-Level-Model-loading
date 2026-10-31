/**
 * Phase 2 automated browser test (Playwright + headless Chromium).
 * For each (precision, threads): FRESH browser process (WASM heaps never shrink, so
 * runs must not share a page), open the baseline page, run all 872 sentences, check:
 *   - crossOriginIsolated === true
 *   - tokenizer mismatches === 0
 *   - accuracy equals the same-precision Python reference (|Δ| <= 0.1 pt)
 *   - fp32: max |Δlogit| vs PyTorch < 1e-3
 * Writes results/phase2/browser_baseline.json
 * Usage: node bench/phase2_browser_test.mjs [limit]
 */
import { createRequire } from 'node:module';
import fs from 'node:fs';
import { createServer } from '../demo/server.mjs';

const { chromium } = createRequire(import.meta.url)('playwright');
const ROOT = new URL('../', import.meta.url);
const LIMIT = Number(process.argv[2] || Infinity);
// Batch-1 references. fp32: PyTorch. int8: onnxruntime-web WASM kernels in Node (same kernels
// as the browser). Native Python int8 (0.9014) uses different kernels -> informational only.
const REF_ACC = { fp32: 0.9105504587155964, int8: 0.9002293577981652 };
const CONFIGS = (process.env.CONFIGS || 'int8:1,int8:2,fp32:1,fp32:2').split(',').map(c => c.split(':'));

const server = createServer({ noCache: true });
await new Promise(r => server.listen(0, r));
const base = `http://localhost:${server.address().port}`;
const results = [], checks = [];

for (const [precision, threads] of CONFIGS) {
  // channel 'chromium' = full Chromium in new-headless mode. The default headless *shell*
  // does not implement measureUserAgentSpecificMemory. ForceEagerMeasureMemory makes the
  // measurement immediate instead of waiting for the next GC (~16 s observed).
  const browser = await chromium.launch({ channel: 'chromium', args: ['--enable-blink-features=ForceEagerMeasureMemory'] });
  const page = await browser.newPage();
  page.on('console', m => m.type() === 'error' && console.log('  [console]', m.text()));
  await page.goto(`${base}/demo/phase2-baseline.html`);
  await page.waitForFunction(() => window.phase2?.ready, null, { timeout: 60000 });
  const t0 = Date.now();
  const r = await page.evaluate(o => window.phase2.benchmark(o),
                                { precision, threads: Number(threads), uaMemory: true, limit: LIMIT === Infinity ? 1e9 : LIMIT });
  r.wallS = (Date.now() - t0) / 1000; results.push(r);
  await browser.close();
  const c = (name, ok, detail) => { checks.push({ config: `${precision}/${threads}t`, name, ok, detail }); };
  c('crossOriginIsolated', r.crossOriginIsolated === true, r.crossOriginIsolated);
  c('tokenizer parity', r.tokenizerMismatches === 0, `${r.tokenizerMismatches} mismatches`);
  if (r.n === 872) c('accuracy = same-kernel reference (±0.1 pt)', Math.abs(r.accuracy - REF_ACC[precision]) <= 0.001,
                     `${(r.accuracy * 100).toFixed(2)}% vs ${(REF_ACC[precision] * 100).toFixed(2)}%`);
  c(`|Δlogit| vs ${r.reference} < 1e-3`, r.maxAbsLogitDiffVsReference < 1e-3, r.maxAbsLogitDiffVsReference.toExponential(2));
  if (r.n === 872) c('100% prediction agreement with reference', r.agreementWithReference === 1, `${(r.agreementWithReference * 100).toFixed(2)}%`);
  console.log(`${precision}/${threads}t: acc ${(r.accuracy * 100).toFixed(2)}%  agreeRef ${(r.agreementWithReference * 100).toFixed(2)}%  ` +
    `maxΔ ${r.maxAbsLogitDiffVsReference.toExponential(2)}  load ${r.load.loadMs.toFixed(0)}ms (session ${r.load.createMs.toFixed(0)}ms)  ` +
    `p50 ${r.latencyMs.p50.toFixed(1)}ms  wasm ${(r.memLoaded.wasmHeapBytes / 1048576).toFixed(0)}MB→${(r.memReleased.wasmHeapBytes / 1048576).toFixed(0)}MB  ` +
    `ua ${r.memLoaded.uaBytes ? (r.memLoaded.uaBytes / 1048576).toFixed(0) + 'MB' : 'n/a'}  ${r.wallS.toFixed(0)}s`);
}
server.close();
const out = new URL('results/phase2/', ROOT); fs.mkdirSync(out, { recursive: true });
fs.writeFileSync(new URL(process.env.OUT_NAME || 'browser_baseline.json', out), JSON.stringify({ date: new Date().toISOString(), results, checks }, null, 2));
for (const c of checks) console.log(c.ok ? 'PASS' : 'FAIL', c.config, c.name, '-', c.detail);
process.exit(checks.every(c => c.ok) ? 0 : 1);
