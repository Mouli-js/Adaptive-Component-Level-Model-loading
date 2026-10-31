/**
 * Phase 6 — package as a consumer would get it:
 *   1. npm pack -> tarball; check contents (only src/, index.d.ts, README, LICENSE, package.json)
 *   2. install the tarball + onnxruntime-web@1.20.1 into an EMPTY temp project
 *   3. Node smoke: import by package name, tokenizer + decision engine work on the real manifest
 *   4. TypeScript: a consumer .ts file type-checks against index.d.ts (tsc --noEmit, strict)
 * Writes results/phase6/pack_test.json; prints the tarball path for the browser test.
 */
import { execSync } from 'node:child_process';
import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path';
import { fileURLToPath } from 'node:url';

const R = fileURLToPath(new URL('..', import.meta.url));   // decodes %20 (folder name has spaces)
const PKG = path.join(R, 'packages/adaptive-onnx-loader');
const work = process.env.WORK_DIR || fs.mkdtempSync(path.join(os.tmpdir(), 'p6-'));
fs.mkdirSync(work, { recursive: true });
const sh = (c, cwd) => execSync(c, { cwd, stdio: ['ignore', 'pipe', 'pipe'] }).toString();
const out = { work, checks: [] }; const check = (name, ok, detail) => out.checks.push({ name, ok: !!ok, detail });

const packed = JSON.parse(sh(`npm pack --json --pack-destination "${work}"`, PKG))[0];
out.tarball = path.join(work, packed.filename); out.size = packed.size; out.unpackedSize = packed.unpackedSize;
out.files = packed.files.map(f => f.path).sort();
check('tarball contains only src/, index.d.ts, README.md, LICENSE, package.json',
  out.files.every(f => f.startsWith('src/') || ['index.d.ts', 'README.md', 'LICENSE', 'package.json'].includes(f)), out.files.filter(f => !f.startsWith('src/')));
check('no tests, fixtures or node_modules in the tarball', !out.files.some(f => /test|node_modules|fixtures/.test(f)), out.files.length + ' files');
check('Worker script is included', out.files.includes('src/workers/chunkWorker.js'), 'src/workers/chunkWorker.js');

const app = path.join(work, 'consumer'); fs.mkdirSync(app, { recursive: true });
fs.writeFileSync(path.join(app, 'package.json'), JSON.stringify({ name: 'consumer', private: true, type: 'module' }));
sh(`npm install --silent --no-audit --no-fund "${out.tarball}" onnxruntime-web@1.20.1 typescript@5.6.3`, app);
const installed = JSON.parse(fs.readFileSync(path.join(app, 'node_modules/adaptive-onnx-loader/package.json')));
check('installed by package name', installed.name === 'adaptive-onnx-loader' && installed.version === '0.1.0', installed.version);

fs.writeFileSync(path.join(app, 'smoke.mjs'), `
import fs from 'node:fs';
import { loadModel, decide, PROFILES, WordPieceTokenizer, AdaptiveLoaderError } from 'adaptive-onnx-loader';
const manifest = JSON.parse(fs.readFileSync(${JSON.stringify(path.join(R, 'models/onnx/manifest.json'))}));
const tok = WordPieceTokenizer.fromVocabText(fs.readFileSync(${JSON.stringify(path.join(R, 'models/onnx/vocab.txt'))}, 'utf8'));
const d = decide({ manifest, signals: { storage: { quota: 1e10, usage: 0 }, cachedSha256: [] }, profile: 'low' });
let code = null; try { await loadModel({ manifestUrl: '/x' }); } catch (e) { code = e instanceof AdaptiveLoaderError ? e.code : String(e); }
console.log(JSON.stringify({ ids: tok.encode('Hello, World!'), plan: d.plan.id, profiles: Object.keys(PROFILES), errorInNode: code }));`);
const smoke = JSON.parse(sh('node smoke.mjs', app).trim());
out.smoke = smoke;
check('Node import + tokenizer', JSON.stringify(smoke.ids) === '[101,7592,1010,2088,999,102]', smoke.ids);
check('Node decision engine via package', smoke.plan === 'int8|sequential|pin=-|G=1|pw=0|ee=0', smoke.plan);
check('loadModel throws a typed error outside a browser', smoke.errorInNode === 'NOT_ISOLATED', smoke.errorInNode);

fs.writeFileSync(path.join(app, 'consumer.ts'), `
import { loadModel, AdaptiveLoaderError, type Prediction, type PlanExplanation, type CacheStats } from 'adaptive-onnx-loader';
async function main(): Promise<void> {
  const model = await loadModel({ manifestUrl: '/models/onnx/manifest.json', profile: 'low', overrides: { minAccuracy: 0.9 }, earlyExit: false });
  const why: PlanExplanation = model.explainPlan();
  const one: Prediction = await model.infer('great');
  const many: Prediction[] = await model.infer(['a', 'b']);
  const s: CacheStats = await model.getCacheStats();
  await model.replan({ profile: 'high' });
  console.log(why.explanation[0], one.label, many.length, s.runtime.liveWorkers, model.plan?.id);
  model.dispose();
}
main().catch((e: unknown) => { if (e instanceof AdaptiveLoaderError) console.error(e.code); });`);
fs.writeFileSync(path.join(app, 'tsconfig.json'), JSON.stringify({ compilerOptions: { strict: true, noEmit: true, target: 'es2022', module: 'nodenext', moduleResolution: 'nodenext', lib: ['es2022', 'dom'] }, files: ['consumer.ts'] }));
let tscOk = true, tscOut = '';
try { tscOut = sh('npx tsc -p tsconfig.json', app); } catch (e) { tscOk = false; tscOut = e.stdout?.toString() + e.stderr?.toString(); }
check('TypeScript consumer type-checks (strict)', tscOk, tscOut.trim() || 'no errors');

fs.mkdirSync(path.join(R, 'results/phase6'), { recursive: true });
fs.writeFileSync(path.join(R, 'results/phase6/pack_test.json'), JSON.stringify(out, null, 2));
for (const c of out.checks) console.log(c.ok ? 'PASS' : 'FAIL', c.name, '-', typeof c.detail === 'object' ? JSON.stringify(c.detail) : c.detail);
console.log(`tarball ${out.tarball} (${(out.size / 1024).toFixed(1)} KiB packed, ${(out.unpackedSize / 1024).toFixed(1)} KiB unpacked, ${out.files.length} files)`);
process.exit(out.checks.every(c => c.ok) ? 0 : 1);
