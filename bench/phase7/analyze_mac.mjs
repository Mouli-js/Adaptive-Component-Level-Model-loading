/**
 * Phase 7 Step 14 — validation + analysis of the Mac results (MAC-CHROME-*). Kept separate from the cloud analysis.
 *   node bench/phase7/analyze_mac.mjs results/phase7/mac/<file>.json
 * CONFOUND (introduced by the harness operator, not by you): the aarch64 native passes of Step 2 ran in your Mac's Linux
 * sandbox from ~03:46:00 to 04:10:21 UTC, overlapping the Mac page run (03:36–04:40). Every row is flagged
 * `overlap` if it falls in that window; timing effects of the overlap are TESTED (clean vs overlapped reps of the same
 * configuration), not assumed. Memory, accuracy and output checks are deterministic and unaffected.
 */
import fs from 'node:fs'; import path from 'node:path'; import { fileURLToPath } from 'node:url';
import { generateCandidates, planId } from '../../packages/adaptive-onnx-loader/src/engine/planner.js';
import { PROFILES } from '../../packages/adaptive-onnx-loader/src/engine/profiles.js';
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
// Two modes:  analyze_mac.mjs <original.json>                       (the 1 Nov 03:36 run on its own)
//             analyze_mac.mjs <original.json> --rerun <rerun.json>   (MAC-1 from the original; MAC-2/3/4 from the re-run)
const file = process.argv[2]; const J0 = JSON.parse(fs.readFileSync(file));
const rerunFile = process.argv.includes('--rerun') ? process.argv[process.argv.indexOf('--rerun') + 1] : null;
const JR = rerunFile ? JSON.parse(fs.readFileSync(rerunFile)) : null;
const J = JR ?? J0;                                  // calibration / decisions / step counts of the run that produced MAC-2
const cloud = JSON.parse(fs.readFileSync(path.join(ROOT, 'results/phase7/summary/analysis.json')));
const W0 = Date.parse('2026-11-01T03:46:00Z'), W1 = Date.parse('2026-11-01T04:10:30Z');
const tag = (rs, runSource) => rs.map(r => ({ ...r, runSource, overlap: runSource === 'original' && Date.parse(r.date) >= W0 && Date.parse(r.date) <= W1 }));
const allRows = JR ? [...tag(J0.rows.filter(r => r.block === 'MAC-1'), 'original'), ...tag(JR.rows, 'rerun')] : tag(J0.rows, 'original');
const anomalous = allRows.filter(r => r.anomaly);                 // page hidden during the run: KEPT in the raw data, excluded from analysis
const rows = allRows.filter(r => !r.anomaly);
const ok = rows.filter(r => !r.failed);

let seed = 777; const rnd = () => { seed += 0x6D2B79F5; let r = Math.imul(seed ^ seed >>> 15, 1 | seed); r ^= r + Math.imul(r ^ r >>> 7, 61 | r); return ((r ^ r >>> 14) >>> 0) / 4294967296; };
const sorted = a => [...a].sort((x, y) => x - y);
const q = (a, p) => { const s = sorted(a); if (!s.length) return null; const i = (s.length - 1) * p, lo = Math.floor(i); return s[lo] + (s[Math.min(lo + 1, s.length - 1)] - s[lo]) * (i - lo); };
const med = a => q(a, 0.5), mean = a => a.reduce((s, x) => s + x, 0) / a.length;
const resample = a => a.map(() => a[Math.floor(rnd() * a.length)]);
const ciMed = a => { const m = []; for (let k = 0; k < 10000; k++) m.push(med(resample(a))); return [q(m, .025), q(m, .975)]; };
const ciDiff = (a, b) => { const m = []; for (let k = 0; k < 10000; k++) m.push(med(resample(b)) - med(resample(a))); return [q(m, .025), q(m, .975)]; };
const r2 = x => x == null ? null : Math.round(x * 100) / 100, r1 = x => x == null ? null : Math.round(x * 10) / 10;
const desc = a => a.length ? { n: a.length, median: r2(med(a)), iqr: [r2(q(a, .25)), r2(q(a, .75))], ci95: ciMed(a).map(r2) } : { n: 0 };
const diff = (a, b) => (a.length && b.length) ? { diffMedian: r2(med(b) - med(a)), pct: r1(100 * (med(b) - med(a)) / med(a)), ci95: ciDiff(a, b).map(r2), ciExcludes0: (() => { const c = ciDiff(a, b); return c[0] > 0 || c[1] < 0; })() } : null;
const checks = [], notes = [];
const check = (name, pass, detail = '') => checks.push({ name, pass: !!pass, detail });

// ---------------- validation (conduct, not outcomes) ----------------
check('original run: full, all steps completed (MAC-1 taken from it)', !J0.quickSelfTest && J0.completed === J0.steps, `${J0.completed}/${J0.steps}`);
if (JR) {
  check('re-run: full (not quick), ?only=MAC-2,MAC-3,MAC-4, all steps completed', !JR.quickSelfTest && JSON.stringify(JR.only) === JSON.stringify(['MAC-2', 'MAC-3', 'MAC-4']) && JR.completed === JR.steps, `${JR.completed}/${JR.steps}, only ${JSON.stringify(JR.only)}`);
  check('re-run contains no MAC-1 rows (MAC-1 preserved from the original)', !JR.rows.some(r => r.block === 'MAC-1'));
  const kept = ok.filter(r => r.runSource === 'rerun' && r.block);
  check('re-run: every kept row ran with the page visible the whole time (foreground guard)', kept.every(r => r.visibility && r.visibility.atStart === 'visible' && r.visibility.atEnd === 'visible' && r.visibility.changes === 0),
        `${kept.filter(r => !(r.visibility && r.visibility.changes === 0)).length} not clean`);
  check('re-run: every hidden-page (anomalous) row was repeated by a clean row with the same key', anomalous.every(a => ok.some(r => r.key === a.key && r.runSource === 'rerun')), `${anomalous.length} anomalous rows`);
  notes.push({ name: 're-run foreground guard', detail: { guardPauses: JR.guardPauses ?? 0, anomalousRows: anomalous.map(r => r.key), archivedEarlierRunsInBrowser: JR.archivedEarlierRuns ?? [] } });
}
check('no failed or interrupted steps', !rows.some(r => r.failed), `${rows.filter(r => r.failed).length}`);
check('one origin (http://localhost:8080) for every row', new Set(ok.map(r => r.origin)).size === 1 && ok[0].origin === 'http://localhost:8080');
const withRef = ok.filter(r => r.refCheck);
check('every run: outputs = reference (int8 Δ = 0, fp32/mixed Δ < 1e-4, identical exit points)', withRef.every(r => r.refCheck.pass), `${withRef.length} runs`);
const m1 = ok.filter(r => r.block === 'MAC-1');
check('MAC-1: page ORT ran with the intended thread count', m1.every(r => r.pageThreads === r.threads), [...new Set(m1.map(r => `${r.threads}→${r.pageThreads}`))].join(', '));
// Criterion as defined in the plan ("off = no IndexedDB tier"): the store is not used. The first version of this check
// demanded an EMPTY store, which only holds in the cloud's fresh profiles; on the Mac the origin already held 8 entries
// from the Phase 4–6 demos. That first check FAILED (88/88 rows: 8 → 8); this is recorded in the notes and the report.
const offRows = ok.filter(r => r.block === 'MAC-1' || r.block === 'MAC-3');
check('MAC-1 / MAC-3: IndexedDB tier not used (cache off, entry count unchanged, every load from the network)',
  offRows.every(r => r.cfg.cache === false && r.cacheBefore.entries === r.cacheAfter.entries && (r.allLoads ?? []).every(l => l.source === 'network')),
  `entries before→after: ${[...new Set(offRows.map(r => r.cacheBefore.entries + '→' + r.cacheAfter.entries))].join(', ')}`);
notes.push({ name: 'Validator change (disclosed): the original "entries 0" check failed on all 88 cache-off rows because the origin held 8 pre-existing entries; replaced by the plan\'s criterion (store unused)', detail: { preExistingEntries: [...new Set(offRows.map(r => r.cacheBefore.entries))] } });
const m4 = ok.filter(r => r.block === 'MAC-4');
check('MAC-4: every creation from the primed cache (10 entries), bytes from IndexedDB', m4.every(r => r.cacheBefore.entries === 10 && r.source === 'idb'));
const eng = ok.filter(r => r.block === 'MAC-2' && r.prediction);
check('MAC-2 warm runs: 10 entries before, every chunk from IndexedDB', eng.filter(r => r.cacheState === 'warm').every(r => r.cacheBefore.entries === 10 && r.allLoads.every(l => l.source === 'idb')));
check('MAC-2 cold runs: 0 entries before, every first load from the network', eng.filter(r => r.cacheState === 'cold').every(r => r.cacheBefore.entries === 0 && r.firstLoads.every(l => l.source === 'network')));
check('MAC-2: one calibration for every decision and prediction', !!J.calibration && rows.filter(r => r.key === 'mac2|calibrate' && !r.failed).length === 1);
const expected = { 'MAC-1': 8 * 5 + 8, 'MAC-3': 8 * 5, 'MAC-4': 2 * 5 };
for (const [b, n] of Object.entries(expected)) check(`${b}: ${n} rows`, ok.filter(r => r.block === b).length === n, `${ok.filter(r => r.block === b).length}`);
const engIds = [...new Set(Object.values(J.decisions).flat().flatMap(d => d.top.map(t => t.id)))];
check(`MAC-2: ${engIds.length} plans × 5 × 2 runs`, eng.length === engIds.length * 10, `${eng.length}`);
// CPU-stability check (added after this run exposed the problem): median compute per sentence INSIDE the Workers must stay
// within 2× of the median of the first 20 MAC-2 runs. A run above that was not measured under normal foreground conditions.
const medC = r => { const c = (r.trace ?? []).slice(1).map(x => x.computeMs).filter(x => x != null).sort((a, b) => a - b); return c.length ? c[c.length >> 1] : null; };
const engSorted = [...eng].sort((a, b) => Date.parse(a.date) - Date.parse(b.date)), ref20 = engSorted.slice(0, 20).map(medC).sort((a, b) => a - b)[10];
for (const r of rows) r.cpuSlow = r.block === 'MAC-2' && r.prediction ? medC(r) > 2 * ref20 : false;
const slow = eng.filter(r => r.cpuSlow), firstSlow = slow.map(r => r.date).sort()[0];
check('MAC-2 timing: Worker compute per sentence stable (≤ 2× the first 20 runs)', slow.length === 0,
  `${slow.length}/${eng.length} runs > ${(2 * ref20).toFixed(0)} ms${slow.length ? `; first at ${firstSlow}` : ''}`);
{ const cf = [...new Set(m1.filter(r => r.key.includes('|rep')).map(r => r.key.replace(/\|rep\d+$/, '')))];
  const spreads = cf.map(c => { const v = m1.filter(r => r.key.startsWith(c + '|rep')).map(r => r.m4MedianMs); return Math.max(...v) / Math.min(...v); });
  check('MAC-1: request latency consistent across the 5 reps of each thread/precision (max/min ≤ 1.5)', spreads.every(x => x <= 1.5), `max ratio ${Math.max(...spreads).toFixed(2)}`); }
for (const b of ['MAC-3', 'MAC-4']) { const rs = ok.filter(r => r.block === b && r.trace?.length > 1);
  if (rs.length) check(`${b}: compute per sentence within the normal range (no run > 150 ms median)`, rs.every(r => medC(r) <= 150), `max ${Math.max(...rs.map(medC)).toFixed(1)} ms`); }
if (JR) check('MAC-2: compute per sentence within the normal range (no run > 150 ms median; absolute, in addition to the relative check)', eng.every(r => medC(r) <= 150), `max ${Math.max(...eng.map(medC)).toFixed(1)} ms`);
const calRow = rows.find(r => r.key === 'mac2|calibrate');
notes.push({ name: 'CONFOUND: rows inside the aarch64-native overlap window (03:46:00–04:10:30 UTC)', detail: Object.fromEntries(['MAC-1', 'MAC-3', 'MAC-4', 'MAC-2'].map(b => [b, `${ok.filter(r => r.block === b && r.overlap).length}/${ok.filter(r => r.block === b).length}`])), calibrationInWindow: calRow?.overlap ?? null, calibrationDate: calRow?.date });

// ---------------- MAC-1: thread sweep (clean: before the window) ----------------
const out = { file: path.basename(file), rerunFile: rerunFile ? path.basename(rerunFile) : null, env: J.env, startedAt: J.startedAt, rerunStartedAt: JR?.startedAt ?? null, checks, notes,
              anomalousRowsKept: anomalous.map(r => ({ key: r.key, anomaly: r.anomaly, visibility: r.visibility })) };
{
  const t = {};
  for (const th of [1, 2, 4, 8]) for (const p of ['int8', 'fp32']) {
    const rs = m1.filter(r => r.threads === th && r.cfg.precision === p && r.key.includes('|rep')), acc = m1.find(r => r.threads === th && r.cfg.precision === p && r.key.endsWith('|acc'));
    t[`${p}|T${th}`] = { overlapRows: rs.filter(r => r.overlap).length, ttfiMs: desc(rs.map(r => r.ttfiMs)), m4: desc(rs.map(r => r.m4MedianMs)), peakMiB: [...new Set(rs.map(r => r.memory.peakWasmMiB))],
      accuracy: acc?.accuracy?.accuracy ?? null, hash: acc?.accuracy?.logitsHash?.slice(0, 12) ?? null };
  }
  const f13 = Object.fromEntries([1, 2, 4, 8].map(th => [`T${th}`, diff(m1.filter(r => r.threads === th && r.cfg.precision === 'fp32' && r.key.includes('|rep')).map(r => r.m4MedianMs), m1.filter(r => r.threads === th && r.cfg.precision === 'int8' && r.key.includes('|rep')).map(r => r.m4MedianMs))]));
  const hashes = { int8: [...new Set(m1.filter(r => r.key.endsWith('|acc') && r.cfg.precision === 'int8').map(r => r.accuracy.logitsHash))], fp32: [...new Set(m1.filter(r => r.key.endsWith('|acc') && r.cfg.precision === 'fp32').map(r => r.accuracy.logitsHash))] };
  out.MAC1 = { table: t, int8MinusFp32_M4: f13, accuracyHashesAcrossThreads: hashes,
    cloudHashes: { int8: '1b4238164e7c (cloud WASM, 1 thread)', fp32: 'c4b44bfd4fd8' } };
}
// ---------------- MAC-3: E1/E3 subset ----------------
{
  const m3 = ok.filter(r => r.block === 'MAC-3'), t = {};
  for (const p of ['int8', 'mixedC2']) for (const pol of ['resident', 'sequential']) for (const ee of [0, 1]) {
    const rs = m3.filter(r => r.cfg.precision === p && (r.cfg.plan.pinned.length === 4) === (pol === 'resident') && +r.cfg.plan.earlyExit === ee);
    const val = r => pol === 'resident' ? r.m4MedianMs : r.m4AmortisedMs;
    t[`${pol}|${p}|ee${ee}`] = { peakTotalMiB: [...new Set(rs.map(r => r.memory.peakTotalMiB))], peakWasmMiB: [...new Set(rs.map(r => r.memory.peakWasmMiB))],
      ttfiMs: desc(rs.map(r => r.ttfiMs)), m4: desc(rs.map(val)), m4Clean: desc(rs.filter(r => !r.overlap).map(val)), m4Overlap: desc(rs.filter(r => r.overlap).map(val)), overlapRows: rs.filter(r => r.overlap).length,
      cloudPeakTotalMiB: cloud.E1.table[`${pol}|${p}|ee${ee}`]?.peakTotalMiB ?? null, cloudM4: cloud.E1.table[`${pol}|${p}|ee${ee}`]?.m4.median ?? null };
  }
  const eeEffect = {};
  for (const p of ['int8', 'mixedC2']) for (const pol of ['resident', 'sequential']) {
    const g = ee => m3.filter(r => r.cfg.precision === p && (r.cfg.plan.pinned.length === 4) === (pol === 'resident') && +r.cfg.plan.earlyExit === ee).map(r => pol === 'resident' ? r.m4MedianMs : r.m4AmortisedMs);
    eeEffect[`${pol}|${p}`] = diff(g(0), g(1)); }
  out.MAC3 = { table: t, earlyExitEffect: eeEffect, F27_identicalToCloud: Object.values(t).every(x => x.peakTotalMiB.length === 1 && x.cloudPeakTotalMiB && x.peakTotalMiB[0] === x.cloudPeakTotalMiB[0]) };
}
// ---------------- MAC-4 ----------------
{ const g = s => m4.filter(r => r.state === s).map(r => r.createMs);
  out.MAC4 = { a: desc(g('a')), b: desc(g('b')), bMinusA: diff(g('a'), g('b')), note: 'same-tab protocol (page reload per run, F-37); all 10 rows inside the overlap window; not comparable with the cloud E-F28 (fresh process per run)' }; }
// ---------------- MAC-2: engine on the Mac ----------------
{
  const byId = Object.fromEntries([...generateCandidates({ earlyExit: false }), ...generateCandidates({ earlyExit: true })].map(p => [planId(p), p]));
  const shape = id => { const p = byId[id]; return `${p.pinned.length === 4 ? 'resident' : p.pinned.length ? 'hybrid' : 'sequential'}${p.prewarm ? '+pre-start' : ''}`; };
  const resident = id => byId[id].pinned.length === 4;
  const predTotal = r => (resident(r.planId) ? r.prediction.initialLoadMs : 0) + r.n * r.prediction.perSentenceMs;
  const errOf = r => 100 * (predTotal(r) - r.workloadMs) / r.workloadMs;
  // overlap effect on measured time, per plan × cache: clean reps vs overlapped reps
  const overlapTest = {};
  for (const id of engIds) for (const c of ['warm', 'cold']) { const rs = eng.filter(r => r.planId === id && r.cacheState === c);
    overlapTest[`${id}|${c}`] = { clean: rs.filter(r => !r.overlap).map(r => Math.round(r.workloadMs)), overlap: rs.filter(r => r.overlap).map(r => Math.round(r.workloadMs)) }; }
  const ratios = Object.values(overlapTest).filter(x => x.clean.length && x.overlap.length).map(x => med(x.overlap) / med(x.clean));
  const errByShape = {};
  for (const r of eng) { const k = `${shape(r.planId)}|${r.cacheState}|${r.overlap ? 'overlap' : 'clean'}`; (errByShape[k] ??= []).push(errOf(r)); }
  const errAll = {}; for (const r of eng) { const k = `${shape(r.planId)}|${r.cacheState}`; (errAll[k] ??= []).push(errOf(r)); }
  const plans = engIds.flatMap(id => ['warm', 'cold'].map(c => [id, c, eng.filter(r => r.planId === id && r.cacheState === c)])).filter(([, , rs]) => rs.length).map(([id, c, rs]) => {
    return { plan: id, cache: c, shape: shape(id), measuredAll: desc(rs.map(r => r.workloadMs)), measuredClean: desc(rs.filter(r => !r.overlap).map(r => r.workloadMs)), predictedMs: Math.round(predTotal(rs[0])),
      errPctAll: r1(med(rs.map(errOf))), errPctClean: rs.some(r => !r.overlap) ? r1(med(rs.filter(r => !r.overlap).map(errOf))) : null,
      peakMiB: r2(Math.max(...rs.map(r => r.memory.peakWasmMiB))), upperMiB: r2(Math.max(...rs.map(r => r.memory.lifetimeOverlapUpperMiB ?? 0))), predWithMarginMiB: r2(rs[0].prediction.predictedWasmMiBWithMargin),
      underestimated: rs.some(r => Math.max(r.memory.peakWasmMiB, r.memory.lifetimeOverlapUpperMiB ?? 0) > r.prediction.predictedWasmMiBWithMargin) }; });
  // regret (profile weights, measured M/T/L, normalised by best measured), on CLEAN reps and on all reps
  const measured = r => { const firsts = {}; for (const l of r.allLoads) firsts[l.chunk] ??= l.totalMs; const L = Object.values(firsts).reduce((s, x) => s + x, 0);
    return { L, T: resident(r.planId) ? (r.workloadMs - L) / r.n : r.workloadMs / r.n, M: Math.max(r.memory.peakTotalMiB, r.memory.lifetimeOverlapUpperMiB ?? 0) }; };
  const spearman = (a, b) => { const rk = x => { const s = x.map((v, i) => [v, i]).sort((p, q) => p[0] - q[0]); const r = []; s.forEach(([, i], k) => r[i] = k + 1); return r; }; const ra = rk(a), rb = rk(b), n = a.length;
    return n > 2 ? 1 - 6 * ra.reduce((s, x, i) => s + (x - rb[i]) ** 2, 0) / (n * (n * n - 1)) : null; };
  const decisions = [];
  for (const cache of ['warm', 'cold']) for (const d of J.decisions[cache]) for (const subset of ['clean', 'all']) {
    const ids = d.top.map(t => t.id), w = PROFILES[d.profile].weights;
    const m = Object.fromEntries(ids.map(id => { const rs = eng.filter(r => r.planId === id && r.cacheState === cache && (subset === 'all' || !r.overlap)).map(measured);
      return [id, rs.length ? { M: med(rs.map(x => x.M)), T: med(rs.map(x => x.T)), L: med(rs.map(x => x.L)), n: rs.length } : null]; }));
    const have = ids.filter(id => m[id]); if (have.length < 2) { decisions.push({ cache, profile: d.profile, earlyExit: d.earlyExit, subset, note: 'too few clean reps' }); continue; }
    const mn = k => Math.min(...have.map(id => m[id][k]));
    const mc = Object.fromEntries(have.map(id => [id, w.m * m[id].M / mn('M') + w.t * m[id].T / mn('T') + w.l * m[id].L / mn('L')]));
    const order = [...have].sort((a, b) => mc[a] - mc[b]);
    decisions.push({ cache, profile: d.profile, earlyExit: d.earlyExit, subset, chosen: d.chosen, marginPct: r2(100 * d.margin), measuredPlans: have.length, repsPerPlan: [...new Set(have.map(id => m[id].n))],
      measuredBest: order[0], chosenRank: order.indexOf(d.chosen) + 1, regretPct: have.includes(d.chosen) ? r1(100 * (mc[d.chosen] - mc[order[0]]) / mc[order[0]]) : null,
      spearman: r2(spearman(have.map(id => d.top.find(t => t.id === id).cost), have.map(id => mc[id]))) });
  }
  const sameAsCloud = ['warm', 'cold'].flatMap(c => J.decisions[c].map(d => { const cd = cloud.ENG.decisions.find(x => x.cache === c && x.profile === d.profile && x.earlyExit === d.earlyExit);
    return { cache: c, profile: d.profile, earlyExit: d.earlyExit, mac: d.chosen, cloud: cd?.chosen, same: d.chosen === cd?.chosen }; }));
  out.MAC2 = { calibration: { spawnMs: r1(J.calibration.spawnMs), createBaseWarmMs: r1(J.calibration.createBaseMs), createBaseColdMs: r1(J.calibration.createBaseColdMs), createPerMiBMs: r2(J.calibration.createPerMiBMs),
      inferMsC1: { int8: r2(J.calibration.inferMs.int8.c1_l0_1), fp32: r2(J.calibration.inferMs.fp32.c1_l0_1) }, measuredInOverlapWindow: calRow?.overlap ?? null },
    decisionsVsCloud: sameAsCloud,
    overlapEffect: { pairs: ratios.length, medianRatioOverlapOverClean: r2(med(ratios)), range: [r2(Math.min(...ratios)), r2(Math.max(...ratios))], perPlan: overlapTest },
    timeErrorByShape: Object.fromEntries(Object.entries(errAll).map(([k, v]) => [k, desc(v)])), timeErrorByShapeCleanVsOverlap: Object.fromEntries(Object.entries(errByShape).map(([k, v]) => [k, desc(v)])),
    plans, memoryUnderestimates: plans.filter(p => p.underestimated).length, decisions };
}
const pass = checks.every(c => c.pass);
out.valid = pass;
fs.mkdirSync(path.join(ROOT, 'results/phase7/summary'), { recursive: true });
fs.writeFileSync(path.join(ROOT, `results/phase7/summary/${JR ? 'analysis_mac_final.json' : 'analysis_mac.json'}`), JSON.stringify(out, null, 1));
for (const c of checks) console.log(c.pass ? 'PASS' : 'FAIL', c.name, c.detail ? '— ' + c.detail : '');
for (const n of notes) console.log('NOTE', n.name, JSON.stringify(n.detail), n.calibrationInWindow != null ? `calibration in window: ${n.calibrationInWindow} (${n.calibrationDate})` : '');
console.log(pass ? 'MAC: VALID' : 'MAC: NOT VALID');
