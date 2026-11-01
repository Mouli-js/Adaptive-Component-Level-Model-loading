/**
 * Offline passes (no browser): E4 (16 precision combinations), E-B (batch dependence), F-5 (native vs WASM).
 *   node bench/phase7/offline.mjs <runtime> [--list]
 * runtime:
 *   wasm          onnxruntime-web 1.20.1 WASM in Node (= browser kernels; hash-checked against Chromium)   → results/phase7/wasm/
 *   native-x86    Python onnxruntime 1.20.1 (pinned), x86-64, venv /home/claude/venv-ort120                 → results/phase7/native-x86-ort1.20.1/
 *   native-x86-129  Python onnxruntime 1.29.0, x86-64 (supplementary version-sensitivity row)               → results/phase7/native-x86-ort1.29.0/
 *   native-arm64  Python onnxruntime 1.20.1, aarch64 = your Mac's Linux sandbox (the Phase 1 venv) → results/phase7/native-arm64-ort1.20.1/
 * Each pass writes one JSON; existing files are skipped (resumable); TIME_BUDGET_S stops between passes.
 */
import fs from 'node:fs'; import path from 'node:path'; import os from 'node:os'; import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');     // no Playwright needed (also runs in the Mac's Linux sandbox)
const rt = process.argv[2], LIST = process.argv.includes('--list');
const BUDGET = Number(process.env.TIME_BUDGET_S || 540) * 1000, T0 = Date.now();
const RT = {
  'wasm':           { dir: 'wasm', cmd: ['node', [path.join(ROOT, 'bench/phase7/node_wasm.mjs')]] },
  'native-x86':     { dir: 'native-x86-ort1.20.1', cmd: ['/home/claude/venv-ort120/bin/python', [path.join(ROOT, 'bench/phase7/native_eb.py')]] },
  'native-x86-129': { dir: 'native-x86-ort1.29.0', cmd: ['python3', [path.join(ROOT, 'bench/phase7/native_eb.py')]] },
  'native-arm64':   { dir: 'native-arm64-ort1.20.1', cmd: [path.join(os.homedir(), 'venv/bin/python'), [path.join(ROOT, 'bench/phase7/native_eb.py')]] },   // your Mac's Linux sandbox (Phase 1 venv)
}[rt];
if (!RT) throw new Error('runtime: wasm | native-x86 | native-x86-129 | native-arm64');

export function passes(runtime) {
  const P = [];
  const add = (model, prec, b, comp, seed) => P.push({ model, prec, b, comp, seed });
  if (runtime === 'native-x86-129') {            // supplementary: version sensitivity only
    for (const m of ['full', 'chain']) { add(m, 'iiii', 1, 'order'); add(m, 'iiii', 32, 'order'); }
    add('chain', 'iifi', 1, 'order'); return P;
  }
  // E-B int8: batch 1 once (order is irrelevant at batch 1), batch 4/8/16/32 × {order, sorted, shuffled seeds 0–4}
  for (const m of ['full', 'chain']) { add(m, 'iiii', 1, 'order');
    for (const b of [4, 8, 16, 32]) { add(m, 'iiii', b, 'order'); add(m, 'iiii', b, 'sorted'); for (let s = 0; s < 5; s++) add(m, 'iiii', b, 'shuffled', s); } }
  // E-B fp32 control: batch 1, and batch 4/8/16/32 × {order, shuffled seed 0}
  for (const m of ['full', 'chain']) { add(m, 'ffff', 1, 'order'); for (const b of [4, 8, 16, 32]) { add(m, 'ffff', b, 'order'); add(m, 'ffff', b, 'shuffled', 0); } }
  // F-5 mixedC2 at batch 1 (every runtime) and E4: all 16 per-chunk combinations, chain, batch 1 (WASM only)
  add('chain', 'iifi', 1, 'order');
  if (runtime === 'wasm') for (let k = 0; k < 16; k++) add('chain', [0, 1, 2, 3].map(i => (k >> (3 - i)) & 1 ? 'f' : 'i').join(''), 1, 'order');
  const seen = new Set(); return P.filter(p => { const id = fileOf(p); if (seen.has(id)) return false; seen.add(id); return true; });
}
export const fileOf = p => `${p.model}_${p.prec}_b${p.b}_${p.comp}${p.comp === 'shuffled' ? '_s' + p.seed : ''}.json`;

if (process.argv[1].endsWith('offline.mjs')) {
  const list = passes(rt), dir = path.join(ROOT, 'results/phase7', RT.dir); fs.mkdirSync(dir, { recursive: true });
  if (LIST) { console.log(list.length, 'passes'); process.exit(0); }
  let done = 0, ran = 0;
  for (const p of list) {
    if (fs.existsSync(path.join(dir, fileOf(p)))) { done++; continue; }
    if (Date.now() - T0 > BUDGET) break;
    const t = Date.now();
    try { execFileSync(RT.cmd[0], [...RT.cmd[1], p.model, p.prec, String(p.b), p.comp, String(p.seed ?? 0)], { env: { ...process.env, OUT_DIR: RT.dir }, stdio: ['ignore', 'ignore', 'inherit'], timeout: 600000 }); ran++; done++;
      console.log(rt, fileOf(p), ((Date.now() - t) / 1000).toFixed(1) + 's'); }
    catch (e) { fs.appendFileSync(path.join(dir, 'failures.log'), `${new Date().toISOString()} ${fileOf(p)} ${String(e).slice(0, 300)}\n`); console.log('FAILED', fileOf(p)); }
  }
  console.log(`[${rt}] ${done}/${list.length} passes present (${ran} run now); elapsed ${((Date.now() - T0) / 1000).toFixed(0)} s`);
}
