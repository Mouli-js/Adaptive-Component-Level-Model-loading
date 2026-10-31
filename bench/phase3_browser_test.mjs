/**
 * Phase 3 automated browser test (Playwright + Chromium). Each experiment runs in a FRESH
 * browser process, because WASM heaps never shrink (F-4) and must not carry over.
 *   A mainChain   : 4 ChunkSessions in the page's own heap
 *   B resident    : 4 Workers alive, sentence-major
 *   C sequential  : one Worker at a time, chunk-major, terminate after each chunk
 *   D memoryProof : browser's own memory API: loaded → release() → terminate()
 *   E baseOverhead: heap of a Worker hosting the smallest graph
 * Gates: correctness vs same-kernel chain reference (int8: Δ = 0; fp32: Δ < 1e-4, and < 1e-4 vs PyTorch),
 *        resident/sequential hold 0 live heap after release, sequential never has >1 Worker alive,
 *        terminate() frees memory (D).
 * Usage: EXPS="A:int8,B:fp32,…" OUT_NAME=x.json node bench/phase3_browser_test.mjs [limit]
 */
import { createRequire } from 'node:module';
import fs from 'node:fs';
import { createServer } from '../demo/server.mjs';

const { chromium } = createRequire(import.meta.url)('playwright');
const ROOT = new URL('../', import.meta.url);
const LIMIT = Number(process.argv[2] || 872);
const EXPS = (process.env.EXPS || 'A:int8,A:fp32,B:int8,B:fp32,C:int8,C:fp32,D:int8,D:fp32,E:-').split(',').map(x => x.split(':'));
const THREADS = Number(process.env.THREADS || 1);
const REF_ACC = { fp32: 0.9105504587155964, int8: 0.9002293577981652 };

const server = createServer({ noCache: true });
await new Promise(r => server.listen(0, r));
const base = `http://localhost:${server.address().port}`;
const results = [], checks = [];
const check = (cfg, name, ok, detail) => checks.push({ config: cfg, name, ok: !!ok, detail });

for (const [exp, precision] of EXPS) {
  const browser = await chromium.launch({ channel: 'chromium', args: ['--enable-blink-features=ForceEagerMeasureMemory'] });
  const page = await browser.newPage();
  const errors = []; page.on('pageerror', e => errors.push(String(e)));
  await page.goto(`${base}/demo/phase3-chunks.html`);
  await page.waitForFunction(() => window.phase3?.ready, null, { timeout: 60000 });
  const arg = { precision, limit: LIMIT, threads: THREADS };
  const t0 = Date.now();
  const r = await page.evaluate(([e, a]) => {
    const p = window.phase3;
    return e === 'A' ? p.mainChain(a) : e === 'B' ? p.workers({ ...a, mode: 'resident' }) : e === 'C' ? p.workers({ ...a, mode: 'sequential' })
         : e === 'D' ? p.memoryProof(a) : p.baseOverhead(a);
  }, [exp, arg]);
  r.wallS = (Date.now() - t0) / 1000; r.pageErrors = errors; results.push(r);
  await browser.close();
  const cfg = `${exp}/${precision}/${THREADS}t`;
  check(cfg, 'no page errors', errors.length === 0, errors.join(' | ') || 'none');
  if ('ABC'.includes(exp)) {
    check(cfg, 'crossOriginIsolated', r.crossOriginIsolated, r.crossOriginIsolated);
    check(cfg, '100% agreement with chain reference', r.agreementWithChainRef === 1, r.agreementWithChainRef);
    if (precision === 'int8') check(cfg, 'int8 Δ vs chain reference = 0', r.maxAbsDiffVsChainRef === 0, r.maxAbsDiffVsChainRef);
    else { check(cfg, 'fp32 Δ vs chain reference < 1e-4', r.maxAbsDiffVsChainRef < 1e-4, r.maxAbsDiffVsChainRef);
           check(cfg, 'fp32 Δ vs PyTorch < 1e-4', r.maxAbsDiffVsPytorch < 1e-4, r.maxAbsDiffVsPytorch); }
    if (r.n === 872) check(cfg, 'accuracy = reference', Math.abs(r.accuracy - REF_ACC[precision]) < 1e-9, r.accuracy);
  }
  if ('BC'.includes(exp)) check(cfg, 'live heap after release = 0', r.liveHeapAfterReleaseMiB === 0, r.liveHeapAfterReleaseMiB);
  if (exp === 'C') check(cfg, 'never more than 1 Worker alive', Math.max(...r.timeline.map(e => e.liveWorkers)) <= 1, Math.max(...r.timeline.map(e => e.liveWorkers)));
  if (exp === 'D') {
    const [s0, s1, s2, s3] = r.steps;
    const ok = [s0, s1, s2, s3].every(s => s.uaMiB != null);
    check(cfg, 'UA memory API available', ok, r.steps.map(s => s.uaError).filter(Boolean).join(' | ') || 'ok');
    if (ok) {
      check(cfg, 'terminate() frees ≥ 90% of what loading added', (s1.uaMiB - s3.uaMiB) >= 0.9 * (s1.uaMiB - s0.uaMiB),
            `added ${(s1.uaMiB - s0.uaMiB).toFixed(1)} MiB, freed ${(s1.uaMiB - s3.uaMiB).toFixed(1)} MiB`);
      check(cfg, 'release() alone frees < 10% (heap retained, F-4)', (s1.uaMiB - s2.uaMiB) < 0.1 * (s1.uaMiB - s0.uaMiB),
            `freed ${(s1.uaMiB - s2.uaMiB).toFixed(1)} MiB`);
    }
  }
  const brief = { ...r }; delete brief.timeline; delete brief.loads; delete brief.userAgent;
  console.log(cfg, `${r.wallS}s`, JSON.stringify(brief).slice(0, 900));
}
server.close();
fs.mkdirSync(new URL('results/phase3/', ROOT), { recursive: true });
fs.writeFileSync(new URL(`results/phase3/${process.env.OUT_NAME || 'browser_phase3.json'}`, ROOT),
                 JSON.stringify({ date: new Date().toISOString(), limit: LIMIT, threads: THREADS, results, checks }, null, 2));
for (const c of checks) console.log(c.ok ? 'PASS' : 'FAIL', c.config, c.name, '-', typeof c.detail === 'object' ? JSON.stringify(c.detail) : c.detail);
process.exit(checks.every(c => c.ok) ? 0 : 1);
