/**
 * Phase 7 validation — run after each block, BEFORE the next block starts (your condition 4).
 *   node bench/phase7/validate.mjs <block> [--smoke]
 * Checks that the block was CONDUCTED correctly (counts, errors, outputs vs reference, cache state, bytes,
 * origin, determinism). It never fails a block because a hypothesis was not supported: outcomes such as
 * "memory under-predicted" or "bytes differ from the model of the runtime" are REPORTED as observations.
 * Writes results/phase7/<block>/validation.json; exit code 1 if any check fails.
 */
import fs from 'node:fs'; import path from 'node:path';
import { ROOT } from './lib.mjs';
const block = process.argv[2], SMOKE = process.argv.includes('--smoke');
const DIR = path.join(ROOT, 'results/phase7', SMOKE ? `_smoke/${block}` : block);
const all = fs.readFileSync(path.join(DIR, 'runs.jsonl'), 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse);
const ok = all.filter(r => !r.failed), failed = all.filter(r => r.failed);
const latest = Object.values(ok.reduce((a, r) => (a[r.key] = r, a), {}));       // one successful row per key
const checks = [], notes = [];
const check = (name, pass, detail = '') => checks.push({ name, pass: !!pass, detail });
const note = (name, detail) => notes.push({ name, detail });
const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, 'models/onnx/manifest.json')));
const PP = { fp32: { c0_embed: 'fp32', c1_l0_1: 'fp32', c2_l2_3: 'fp32', c3_l4_5_cls: 'fp32' }, int8: { c0_embed: 'int8', c1_l0_1: 'int8', c2_l2_3: 'int8', c3_l4_5_cls: 'int8' },
             mixedC2: { c0_embed: 'int8', c1_l0_1: 'int8', c2_l2_3: 'fp32', c3_l4_5_cls: 'int8' } };
const bytesOf = (chunk, prec) => (manifest.chunks[chunk]?.[prec] ?? manifest.exits[chunk]?.[prec]).bytes;
const spread = a => a.length ? Math.max(...a) - Math.min(...a) : 0;

// ---------- expected counts (must match suite.mjs; smoke mode skips the count check) ----------
// net: 8 link × precision cells × {pre-start off, on} × 5 cold visits = 80, + 3 revisits per pre-start-OFF cold visit (8 × 5 × 3 = 120)
// e5x: 2 links × 3 precisions × 5 reps × (1 cold + 3 revisits) = 120
const EXPECTED = { acc: 12, e1: 20 * 5, f28: 5 * 4 * 2 * 10, e3bytes: 3 * 30 * 3, netcheck: 4, net: 80 + 120, e5x: 120, g1: 2, ebrowser: 2 };
if (!SMOKE && EXPECTED[block] != null) check(`row count = ${EXPECTED[block]}`, latest.length === EXPECTED[block], `${latest.length} successful keys`);
if (block === 'eng' && !SMOKE) { const ids = new Set(JSON.parse(fs.readFileSync(path.join(DIR, 'decisions.json'))).flatMap(d => d.measure));
  check(`row count = ${ids.size} plans × 2 cache states × 5`, latest.length === ids.size * 10, `${latest.length}`); }

// ---------- generic ----------
check('no page errors in any successful run', latest.every(r => !r.errors?.length), latest.filter(r => r.errors?.length).map(r => r.key).join(', ') || 'none');
const withRef = latest.filter(r => r.refCheck);
check('every run: outputs = reference (int8 Δ = 0, fp32/mixed Δ < 1e-4, identical exit points)', withRef.every(r => r.refCheck.pass),
      withRef.filter(r => !r.refCheck.pass).map(r => `${r.key}: Δ ${r.refCheck.maxAbsDiffVsRef}, exits ${r.refCheck.exitMismatch}`).join('; ') || `${withRef.length} runs checked`);
note('failed attempts (kept in the file; each was retried as a new row with retryOf)', failed.length ? failed.map(r => `${r.key}: ${r.error.slice(0, 120)}`) : 'none');
const byState = s => latest.filter(r => r.cacheState === s);
if (byState('off').length) check('cache OFF runs: IndexedDB empty before and after, every chunk from the server', byState('off').every(r => r.cacheBefore?.entries === 0 && r.cacheAfter?.entries === 0 && r.loads.every(l => l.source === 'network')));
if (byState('cold').length) check('cold runs: IndexedDB empty before the run, bytes came from the server', byState('cold').every(r => r.cacheBefore?.entries === 0 && r.server.onnxBytes > 0),
                                  byState('cold').filter(r => !(r.cacheBefore?.entries === 0 && r.server.onnxBytes > 0)).map(r => r.key).join(', ') || '');
const warmCopy = latest.filter(r => /primed copy|^warm$/.test(r.cacheState ?? '') && r.server);   // E-F28 rows (no server log) are checked in their own block below
if (warmCopy.length) check('warm runs: identical primed cache before the run (same entry count as the master), 0 bytes from the server',
  warmCopy.every(r => (r.masterEntries != null && r.cacheBefore?.entries === r.masterEntries) && r.server.onnxBytes === 0),
  warmCopy.filter(r => !((r.masterEntries != null && r.cacheBefore?.entries === r.masterEntries) && r.server.onnxBytes === 0)).map(r => `${r.key} entries ${r.cacheBefore?.entries} bytes ${r.server.onnxBytes}`).join('; ') || `${warmCopy.length} runs`);

// ---------- per block ----------
if (block === 'acc') {
  for (const p of ['int8', 'mixedC2', 'fp32']) for (const ee of [0, 1]) {
    const rs = latest.filter(r => r.precision === p && +r.earlyExit === ee);
    if (rs.length >= 2) check(`determinism ${p} ee${ee}: identical logits hash across 2 browser processes`, new Set(rs.map(r => r.accuracy.logitsHash)).size === 1, rs.map(r => r.accuracy.logitsHash.slice(0, 12)).join(' / '));
    if (rs.length) { check(`${p} ee${ee}: 872 outputs = reference (Δ = 0, exit points identical)`, rs.every(r => r.accuracy.maxAbsDiffVsRef === 0 && r.accuracy.exitMismatch === 0));
      note(`${p} ee${ee} accuracy`, rs[0].accuracy.accuracy); }
  }
}
if (block === 'e1') {
  const cfgs = [...new Set(latest.map(r => r.key.replace(/\|rep\d+$/, '')))];
  for (const c of cfgs) { const rs = latest.filter(r => r.key.startsWith(c + '|'));
    const sp = spread(rs.map(r => r.memory.peakWasmMiB)); if (sp) note(`peak WASM varies across reps: ${c}`, `${sp.toFixed(2)} MiB`); }
  const uaRows = latest.filter(r => r.ua?.uaMiB != null);
  check('UA spot checks taken (rep 1 of baseline / chain / resident)', SMOKE || uaRows.length === 2 + 3 + 6, `${uaRows.length} (expected 11: baseline 2 + chain 3 + resident 6)`);
  note('UA vs probe (UA includes JS heaps; probe > UA would be suspicious)', uaRows.map(r => `${r.key.split('|').slice(1, 4).join('|')}: UA ${r.ua.uaMiB} vs probe ${r.ua.liveWorkerProbeMiB ?? r.ua.pageWasmMiB}`));
  check('no probe reading above the browser measurement by > 2 MiB', uaRows.every(r => (r.ua.liveWorkerProbeMiB ?? r.ua.pageWasmMiB) <= r.ua.uaMiB + 2));
}
if (block === 'f28') {
  check('every creation started from the identical primed cache (entry count = master)', latest.every(r => r.cacheBefore?.entries === r.masterEntries),
        latest.filter(r => r.cacheBefore?.entries !== r.masterEntries).map(r => r.key).join(', '));
  check('every creation read its bytes from IndexedDB (only creation differs between states)', latest.every(r => r.source === 'idb'), latest.filter(r => r.source !== 'idb').map(r => r.key).join(', '));
}
if (block === 'eng') {
  const dec = JSON.parse(fs.readFileSync(path.join(DIR, 'decisions.json')));
  check('one fixed calibration file used (D-7.4)', fs.existsSync(path.join(DIR, 'calibration_cloud.json')));
  check('warm decisions saw the full primed cache; cold decisions an empty one', dec.every(d => d.cache === 'warm' ? d.cacheEntries > 0 : d.cacheEntries === 0));
  for (const d of dec.filter(x => x.link === 'localhost')) note(`decision ${d.cache} ${d.profile} ee${+d.earlyExit}`, `${d.chosen} (margin to #2: ${d.margin != null ? (100 * d.margin).toFixed(2) + '%' : 'n/a'})`);
  const under = latest.filter(r => r.memory.peakWasmMiB > r.prediction.predictedWasmMiBWithMargin || (r.memory.lifetimeOverlapUpperMiB ?? 0) > r.prediction.predictedWasmMiBWithMargin);
  note('OUTCOME (not a validity check): runs whose measured memory (probe or upper bound) exceeded the prediction', under.map(r => r.key));
}
if (block === 'e3bytes') {
  check('every run took the expected exit path for its sentence', latest.filter(r => r.condition !== 'ee0').every(r => r.trace[0].exitAt === r.expectExit));
  // model of the runtime (planRunner.js): chunks spawned up to the exit chunk; exit heads load WITH their chunk (ee on);
  // pre-start also spawns the chunk after every computed one
  const chain = manifest.chain, headAfter = { c1_l0_1: 'e1_after_c1', c2_l2_3: 'e2_after_c2' };
  const mism = [];
  for (const r of latest) {
    const last = r.condition === 'ee0' || r.expectExit === 'full' ? 3 : r.expectExit === 'e1' ? 1 : 2;
    const spawned = chain.slice(0, Math.min(4, last + 1 + (r.condition === 'ee1pw' ? 1 : 0)));
    let exp = spawned.reduce((s, c) => s + bytesOf(c, PP[r.precision][c]), 0);
    if (r.condition !== 'ee0') exp += spawned.filter(c => headAfter[c]).reduce((s, c) => s + bytesOf(headAfter[c], 'fp32'), 0);
    r._expectedBytes = exp; if (exp !== r.server.onnxBytes) mism.push(`${r.key}: expected ${exp}, served ${r.server.onnxBytes}`);
  }
  note('OUTCOME: served bytes vs the runtime model (a mismatch is a finding about the runtime, not a harness failure)', mism.length ? mism : 'all equal');
}
if (block === 'netcheck') check('throttle within ±5% at every rate (gate before the network blocks)', latest.every(r => r.within5pct), latest.map(r => `${r.mbps}: ${r.errorPct.toFixed(2)}%`).join(', '));
if (block === 'net' || block === 'e5x') {
  const v0 = latest.filter(r => r.visit === 0), rv = latest.filter(r => r.visit > 0);
  check('visit 0 is cold: empty IndexedDB, full model bytes from the server', v0.every(r => r.cacheBefore.entries === 0 && r.server.onnxBytes > 0));
  check('revisits: 0 bytes from the server, every chunk from IndexedDB', rv.every(r => r.server.onnxBytes === 0 && r.loads.every(l => l.source === 'idb')),
        rv.filter(r => !(r.server.onnxBytes === 0)).map(r => r.key).join(', '));
  check('revisits used the SAME origin as their cold visit', rv.every(r => { const c = latest.find(x => x.key === r.key.replace(/v\d$/, 'v0')); return c && c.origin === r.origin; }));
  check('fp32 at 5 Mbit/s absent (omitted by decision 4)', !latest.some(r => r.precision === 'fp32' && r.link === 5));
}
if (block === 'ebrowser') {
  for (const r of latest) { const f = path.join(ROOT, `results/phase7/wasm/chain_iiii_b${r.batch}_order.json`);
    if (fs.existsSync(f)) check(`browser batch ${r.batch} = Node WASM batch ${r.batch} (same logits hash)`, JSON.parse(fs.readFileSync(f)).logitsHash === r.logitsHash);
    else note(`Node WASM file for batch ${r.batch} not produced yet`, 'compare after the offline block'); }
}

const pass = checks.every(c => c.pass);
fs.writeFileSync(path.join(DIR, 'validation.json'), JSON.stringify({ block, smoke: SMOKE, date: new Date().toISOString(), pass, rows: all.length, successfulKeys: latest.length, failedAttempts: failed.length, checks, notes }, null, 1));
for (const c of checks) console.log(c.pass ? 'PASS' : 'FAIL', c.name, c.detail ? '— ' + String(c.detail).slice(0, 300) : '');
for (const n of notes) console.log('NOTE', n.name, '—', JSON.stringify(n.detail).slice(0, 400));
console.log(pass ? `\n${block}: VALID` : `\n${block}: NOT VALID — do not start the next block`);
process.exit(pass ? 0 : 1);
