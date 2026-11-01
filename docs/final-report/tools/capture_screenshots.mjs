// Documentation screenshots of the unchanged demo pages (CLOUD-HL, headless Chromium).
// These are illustrations, not measurements of record. Usage: node docs/final-report/tools/capture_screenshots.mjs
import { createRequire } from 'node:module';
const { chromium } = createRequire(import.meta.url)('playwright');
import { createServer } from '../../../demo/server.mjs';
import path from 'node:path'; import { fileURLToPath } from 'node:url';
const OUT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../figures/screenshots');
const srv = createServer(); await new Promise(r => srv.listen(8080, r));
const B = 'http://localhost:8080';
const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 1200, height: 900 }, deviceScaleFactor: 1.5, colorScheme: 'light' });
const shot = async (p, name) => { await p.waitForTimeout(400); await p.screenshot({ path: `${OUT}/${name}.png`, fullPage: true }); console.log('saved', name); };
const log = []; ctx.on('console', m => log.push(m.text()));
try {
  // S1 baseline: load int8, classify one sentence
  let p = await ctx.newPage(); await p.goto(B + '/demo/phase2-baseline.html');
  await p.selectOption('#thr', '1'); await p.click('#load');
  await p.waitForFunction(() => !document.getElementById('classify').disabled, null, { timeout: 120000 });
  await p.click('#classify'); await p.waitForFunction(() => document.getElementById('pred').textContent.length > 0, null, { timeout: 60000 });
  await shot(p, 'S1_phase2_baseline'); await p.close();
  // S2 chunks: B resident, int8, 100 sentences
  p = await ctx.newPage(); await p.goto(B + '/demo/phase3-chunks.html');
  await p.selectOption('#lim', '100'); await p.click('button[data-exp="resident"]');
  await p.waitForFunction(() => !document.getElementById('copy').disabled, null, { timeout: 300000 });
  await shot(p, 'S2_phase3_chunks_resident'); await p.close();
  // S3 cache: clear, then F1 one request twice (cold, then warm)
  p = await ctx.newPage(); await p.goto(B + '/demo/phase4-cache.html'); await p.waitForTimeout(800);
  const idle = () => p.waitForFunction(() => { const t = document.getElementById('out').textContent; return t !== 'running…' && !document.getElementById('clear').disabled; }, null, { timeout: 300000 });
  await p.click('#clear'); await idle();
  await p.click('button[data-exp="singleRequest"]'); await p.waitForTimeout(300); await idle();   // F1 runs a first and a second request
  await shot(p, 'S3_phase4_cache_F1'); await p.close();
  // S5 engine: profile mid, no calibration, Decide
  p = await ctx.newPage(); await p.goto(B + '/demo/phase5-engine.html');
  await p.uncheck('#cal'); await p.click('#decide');
  await p.waitForFunction(() => document.querySelectorAll('#why li').length > 1, null, { timeout: 120000 });
  await shot(p, 'S5_phase5_engine_mid'); await p.close();
  // S6 demo index: profile mid, load, classify
  p = await ctx.newPage(); await p.goto(B + '/demo/index.html');
  await p.selectOption('#profile', 'mid'); await p.click('#load');
  await p.waitForFunction(() => !document.getElementById('go').disabled, null, { timeout: 300000 });
  await p.click('#go'); await p.waitForFunction(() => document.getElementById('res').children.length > 0, null, { timeout: 120000 });
  await p.waitForTimeout(1500); await shot(p, 'S6_demo_index_mid'); await p.close();
  // S4 application-generated IndexedDB view (same origin, after S3 and S6 filled the store)
  p = await ctx.newPage(); await p.goto(B + '/docs/final-report/tools/idb_view.html');
  await p.waitForFunction(() => document.body.dataset.ready === '1', null, { timeout: 60000 });
  await shot(p, 'S4_indexeddb_application_view'); await p.close();
} finally { await browser.close(); srv.close(); console.log(log.filter(t => /error/i.test(t)).slice(0, 10).join('\n')); }
