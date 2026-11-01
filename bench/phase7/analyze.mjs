/**
 * Phase 7 analysis (cloud + offline results). node bench/phase7/analyze.mjs
 * Reads only the raw files under results/phase7/; writes results/phase7/summary/analysis.json.
 * Statistics: median, IQR, mean ± sd; bootstrap 95% percentile CI (10,000 resamples, seeded) of medians and of
 * differences of medians; exact two-sided McNemar on paired predictions. No p-values on n = 5 timings.
 * Nothing here changes the engine: the I-5.1 refit uses a COPY of the time formula with extra parameters,
 * first checked to reproduce the engine's own predictions exactly.
 */
import fs from 'node:fs'; import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chunkInfo, reachFractions, loadTime, predictTime } from '../../packages/adaptive-onnx-loader/src/engine/costModel.js';
import { generateCandidates, planId } from '../../packages/adaptive-onnx-loader/src/engine/planner.js';
import { PROFILES } from '../../packages/adaptive-onnx-loader/src/engine/profiles.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const R = p => path.join(ROOT, 'results/phase7', p);
const rows = b => fs.readFileSync(R(`${b}/runs.jsonl`), 'utf8').trim().split('\n').map(JSON.parse).filter(r => !r.failed);
const J = p => JSON.parse(fs.readFileSync(p));
const manifest = J(path.join(ROOT, 'models/onnx/manifest.json'));
const labels = J(path.join(ROOT, 'data/sst2/validation.json')).map(r => r.label);

// ---------- statistics ----------
let seed = 12345; const rnd = () => { seed += 0x6D2B79F5; let r = Math.imul(seed ^ seed >>> 15, 1 | seed); r ^= r + Math.imul(r ^ r >>> 7, 61 | r); return ((r ^ r >>> 14) >>> 0) / 4294967296; };
const sorted = a => [...a].sort((x, y) => x - y);
const q = (a, p) => { const s = sorted(a); if (!s.length) return null; const i = (s.length - 1) * p, lo = Math.floor(i); return s[lo] + (s[Math.min(lo + 1, s.length - 1)] - s[lo]) * (i - lo); };
const med = a => q(a, 0.5);
const mean = a => a.reduce((s, x) => s + x, 0) / a.length;
const sd = a => a.length > 1 ? Math.sqrt(a.reduce((s, x) => s + (x - mean(a)) ** 2, 0) / (a.length - 1)) : 0;
const resample = a => a.map(() => a[Math.floor(rnd() * a.length)]);
const B = 10000;
const ciMed = a => { const m = []; for (let k = 0; k < B; k++) m.push(med(resample(a))); return [q(m, 0.025), q(m, 0.975)]; };
const ciDiff = (a, b) => { const m = []; for (let k = 0; k < B; k++) m.push(med(resample(b)) - med(resample(a))); return [q(m, 0.025), q(m, 0.975)]; };   // b − a
const ciRatio = (a, b) => { const m = []; for (let k = 0; k < B; k++) m.push(med(resample(a)) / med(resample(b))); return [q(m, 0.025), q(m, 0.975)]; }; // a / b
const r2 = x => x == null ? null : Math.round(x * 100) / 100, r1 = x => x == null ? null : Math.round(x * 10) / 10, r0 = x => x == null ? null : Math.round(x);
const desc = a => ({ n: a.length, median: r2(med(a)), iqr: [r2(q(a, .25)), r2(q(a, .75))], mean: r2(mean(a)), sd: r2(sd(a)), ci95: ciMed(a).map(r2), min: r2(Math.min(...a)), max: r2(Math.max(...a)) });
const diff = (a, b) => ({ diffMedian: r2(med(b) - med(a)), ci95: ciDiff(a, b).map(r2), pct: r1(100 * (med(b) - med(a)) / med(a)), ciExcludes0: (() => { const c = ciDiff(a, b); return c[0] > 0 || c[1] < 0; })() });
function binomTail(k, n) { let s = 0, c = 1; for (let i = 0; i <= n; i++) { if (i <= k) s += c; c = c * (n - i) / (i + 1); } return s / 2 ** n; }
const mcnemar = (pa, pb) => { let b = 0, c = 0; pa.forEach((x, i) => { const ca = x === labels[i], cb = pb[i] === labels[i]; if (ca && !cb) b++; if (!ca && cb) c++; });
  return { aRightBWrong: b, aWrongBRight: c, p: b + c ? Math.min(1, 2 * binomTail(Math.min(b, c), b + c)) : 1 }; };
const predsOf = logits => logits.map(l => +(l[1] > l[0]));
const accOf = p => p.reduce((s, x, i) => s + (x === labels[i]), 0) / p.length;
const out = { generated: new Date().toISOString(), notes: 'n = 5 timing repetitions per configuration unless stated; CIs are bootstrap 95% percentile intervals' };

// ================= E1 (+ E3 latency) =================
{
  const E = rows('e1'), cfgs = {};
  for (const r of E) (cfgs[`${r.policy}|${r.precision}|ee${+r.earlyExit}`] ??= []).push(r);
  const t = {};
  for (const [k, rs] of Object.entries(cfgs)) {
    const sentenceMajor = rs[0].m4MedianMs != null;
    t[k] = { policy: rs[0].policy, precision: rs[0].precision, earlyExit: rs[0].earlyExit, reps: rs.length,
      peakWasmMiB: [...new Set(rs.map(r => r.memory.peakWasmMiB))], waitingHiddenMiB: [...new Set(rs.map(r => r.memory.waitingHiddenMiB))],
      peakTotalMiB: [...new Set(rs.map(r => r.memory.peakTotalMiB))], upperBoundMiB: [...new Set(rs.map(r => r.memory.lifetimeOverlapUpperMiB))],
      ttfiMs: desc(rs.map(r => r.ttfiMs)),
      m4: { kind: sentenceMajor ? 'median single-request latency (ms)' : 'amortised ms per sentence (chunk-major)', ...desc(rs.map(r => sentenceMajor ? r.m4MedianMs : r.m4AmortisedMs)) },
      computeMsPerSentence: desc(rs.map(r => med(r.trace.slice(1).map(x => x.computeMs).filter(x => x != null)) ?? NaN).filter(x => !isNaN(x))),
      spawns: [...new Set(rs.map(r => r.spawns))], ua: rs.find(r => r.ua?.uaMiB != null)?.ua ?? null,
      exits: rs[0].exits };
  }
  const memVs = (k, ref) => t[k] && t[ref] ? r1(100 * (t[k].peakTotalMiB[0] - t[ref].peakTotalMiB[0]) / t[ref].peakTotalMiB[0]) : null;
  for (const k of Object.keys(t)) { const p = t[k].precision; t[k].peakVsBaselinePct = p !== 'mixedC2' ? memVs(k, `baseline|${p}|ee0`) : null; t[k].peakVsChainPct = memVs(k, `chain|${p}|ee0`); }
  const h1 = {};
  for (const p of ['int8', 'mixedC2', 'fp32']) {
    const s = t[`sequential|${p}|ee0`].peakTotalMiB[0], c = t[`chain|${p}|ee0`].peakTotalMiB[0], b = t[`baseline|${p}|ee0`]?.peakTotalMiB[0] ?? null;
    h1[p] = { sequential: s, chain: c, baseline: b, sequentialBelowChain: s < c, chainBelowBaseline: b == null ? 'n/a (no single-file model)' : c < b,
              memoryIdenticalAcrossReps: Object.values(t).filter(x => x.precision === p).every(x => x.peakTotalMiB.length === 1),
              latencyCost: { sequentialVsResidentTtfi: diff(cfgs[`resident|${p}|ee0`].map(r => r.ttfiMs), cfgs[`sequential|${p}|ee0`].map(r => r.ttfiMs)) } };
  }
  // E3 latency: early exit ON vs OFF (same randomised block)
  const e3lat = {};
  for (const pol of ['resident', 'sequential']) for (const p of ['int8', 'mixedC2', 'fp32']) {
    const off = cfgs[`${pol}|${p}|ee0`], on = cfgs[`${pol}|${p}|ee1`], sm = pol === 'resident';
    const m = rs => rs.map(r => sm ? r.m4MedianMs : r.m4AmortisedMs);
    const comp = rs => rs.map(r => mean(r.trace.slice(1).map(x => x.computeMs)));
    let exitedVsFull = null;
    if (sm) { const ex = [], fu = []; for (const r of on) r.trace.slice(1).forEach((x, i) => { if (i < 5) return; (x.exitAt === 'full' ? fu : ex).push(r.requestMs[i]); }); exitedVsFull = { exitedMedianMs: r2(med(ex)), fullPathMedianMs: r2(med(fu)), nExited: ex.length, nFull: fu.length }; }
    e3lat[`${pol}|${p}`] = { latencyKind: sm ? 'single-request median' : 'amortised per sentence', off: desc(m(off)), on: desc(m(on)), onMinusOff: diff(m(off), m(on)),
      meanComputeMsPerSentence: { off: desc(comp(off)), on: desc(comp(on)), onMinusOff: diff(comp(off), comp(on)) },
      exitsOn: on[0].exits, exitedVsFull, peakOff: off[0].memory.peakTotalMiB, peakOn: on[0].memory.peakTotalMiB };
  }
  out.E1 = { table: t, H1: h1 }; out.E3latency = e3lat;
}

// ================= ACC + E3 accuracy =================
{
  const A = rows('acc'), acc = {};
  for (const r of A.filter(x => x.rep === 0)) acc[`${r.precision}|ee${+r.earlyExit}`] = { accuracy: r.accuracy.accuracy, hash: r.accuracy.logitsHash, exits: r.accuracy.exits, preds: r.accuracy.predictions };
  const determinism = Object.fromEntries(['int8', 'mixedC2', 'fp32'].flatMap(p => [0, 1].map(e => [`${p}|ee${e}`, new Set(A.filter(r => r.precision === p && +r.earlyExit === e).map(r => r.accuracy.logitsHash)).size === 1])));
  const ee = {};
  for (const p of ['int8', 'mixedC2', 'fp32']) { const a = acc[`${p}|ee0`], b = acc[`${p}|ee1`];
    ee[p] = { accOff: a.accuracy, accOn: b.accuracy, deltaPts: r2(100 * (b.accuracy - a.accuracy)), mcnemar: mcnemar(a.preds, b.preds), exitsOn: b.exits,
              exitFrac: r2(((b.exits.e1 ?? 0) + (b.exits.e2 ?? 0)) / 872) }; }
  const prec = { mixedVsInt8: mcnemar(acc['int8|ee0'].preds, acc['mixedC2|ee0'].preds), mixedVsFp32: mcnemar(acc['fp32|ee0'].preds, acc['mixedC2|ee0'].preds), int8VsFp32: mcnemar(acc['fp32|ee0'].preds, acc['int8|ee0'].preds) };
  out.ACC = { accuracy: Object.fromEntries(Object.entries(acc).map(([k, v]) => [k, { accuracy: v.accuracy, hash: v.hash.slice(0, 12), exits: v.exits }])), determinism, earlyExit: ee, precisionMcNemar: prec };
  const pol = J(path.join(ROOT, 'models/heads/early_exit_policy.json'));
  out.E3tauCurveDev = { split: pol.split, rule: pol.rule, chosen: pol.chosen, grid: pol.grid };
}

// ================= E3 bytes =================
{
  const X = rows('e3bytes'), t = {};
  for (const r of X) { const k = `${r.precision}|${r.expectExit}|${r.condition}`; (t[k] ??= []).push(r); }
  const bytes = {};
  for (const p of ['int8', 'mixedC2', 'fp32']) for (const c of ['e1', 'e2', 'full']) {
    const b = cond => [...new Set(t[`${p}|${c}|${cond}`].map(r => r.server.onnxBytes))];
    const off = b('ee0')[0];
    bytes[`${p}|${c}`] = Object.fromEntries(['ee0', 'ee1', 'ee1pw'].map(cond => [cond, { bytesMB: b(cond).map(x => r2(x / 1e6)), vsOffPct: b(cond).map(x => r1(100 * (x - off) / off)),
      requestMs: desc(t[`${p}|${c}|${cond}`].map(r => r.workloadMs)) }]));
  }
  // session level (runtime model, checked per request above): bytes of a session = the union of chunks ever fetched
  const ref = p => J(path.join(ROOT, `data/sst2/wasm_ee_${p}.json`));
  const session = {};
  for (const p of ['int8', 'mixedC2', 'fp32']) { const r = ref(p); const firstFull = r.findIndex(x => x.exitAt === 'full'), firstNotE1 = r.findIndex(x => x.exitAt !== 'e1');
    session[p] = { note: 'in dataset order, a G = 1 session fetches C2 at the first sentence that does not exit at E1 and C3 at the first full-path sentence; with a persistent cache nothing is fetched twice',
                   firstSentenceNeedingC2: firstNotE1, firstSentenceNeedingC3: firstFull, fracExitE1: r2(r.filter(x => x.exitAt === 'e1').length / r.length), fracFull: r2(r.filter(x => x.exitAt === 'full').length / r.length) }; }
  out.E3bytes = { perRequest: bytes, session };
}

// ================= E2 + E5 =================
{
  const N = rows('net'), X = rows('e5x');
  const e2 = {};
  for (const link of ['unthrottled', 20, 5]) for (const p of ['int8', 'mixedC2', 'fp32']) {
    if (p === 'fp32' && link === 5) { e2[`${link}|${p}`] = 'omitted (decision 4)'; continue; }
    const c = pw => N.filter(r => r.link === link && r.precision === p && r.prewarm === pw && r.visit === 0);
    const off = c(false), on = c(true);
    e2[`${link}|${p}`] = { ttfiOff: desc(off.map(r => r.ttfiMs)), ttfiOn: desc(on.map(r => r.ttfiMs)), ttfiOnMinusOff: diff(off.map(r => r.ttfiMs), on.map(r => r.ttfiMs)),
      workloadOff: desc(off.map(r => r.workloadMs)), workloadOn: desc(on.map(r => r.workloadMs)), workloadOnMinusOff: diff(off.map(r => r.workloadMs), on.map(r => r.workloadMs)),
      peakProbe: { off: [...new Set(off.map(r => r.memory.peakTotalMiB))], on: [...new Set(on.map(r => r.memory.peakTotalMiB))] },
      upperBound: { off: [...new Set(off.map(r => r.memory.lifetimeOverlapUpperMiB))], on: [...new Set(on.map(r => r.memory.lifetimeOverlapUpperMiB))] },
      bytesCold: [...new Set(off.map(r => r.server.onnxBytes))] };
  }
  const g1 = rows('g1').map(r => ({ prewarm: r.prewarm, workloadMs: r0(r.workloadMs), n: r.n, perSentenceMs: r0(r.workloadMs / r.n) }));
  const e5 = {};
  const all = [...N.filter(r => !r.prewarm), ...X];
  for (const link of ['unthrottled', 50, 20, 10, 5]) for (const p of ['int8', 'mixedC2', 'fp32']) {
    if (p === 'fp32' && link === 5) { e5[`${link}|${p}`] = 'omitted (decision 4)'; continue; }
    const rs = all.filter(r => r.link === link && r.precision === p); if (!rs.length) continue;
    const cold = rs.filter(r => r.visit === 0), warm = rs.filter(r => r.visit > 0);
    const lookups = warm.flatMap(r => r.loads), hits = lookups.filter(l => l.source === 'idb').length;
    const creationShare = warm.map(r => r.loads.reduce((s, l) => s + (l.createMs ?? 0) + (l.spawnInitMs ?? 0), 0) / r.ttfiMs);
    e5[`${link}|${p}`] = { coldTtfi: desc(cold.map(r => r.ttfiMs)), warmTtfi: desc(warm.map(r => r.ttfiMs)), speedup: r2(med(cold.map(r => r.ttfiMs)) / med(warm.map(r => r.ttfiMs))),
      speedupCI95: ciRatio(cold.map(r => r.ttfiMs), warm.map(r => r.ttfiMs)).map(r2), coldBytesMB: r2(med(cold.map(r => r.server.onnxBytes)) / 1e6), warmBytes: Math.max(...warm.map(r => r.server.onnxBytes)),
      M6hitRate: hits / lookups.length, creationShareOfWarmTtfi: desc(creationShare) };
  }
  out.E2 = { cells: e2, g1Indicative: g1 }; out.E5 = e5;
}

// ================= E4 =================
{
  const W = f => J(R(`wasm/${f}`));
  const fp = predsOf(W('chain_ffff_b1_order.json').logits), i8 = predsOf(W('chain_iiii_b1_order.json').logits);
  // per-chunk resident heap from the E1 resident timelines ('loaded' event deltas), int8 and fp32
  const heap = {};
  for (const p of ['int8', 'fp32']) { const r = rows('e1').find(x => x.policy === 'resident' && x.precision === p && !x.earlyExit); let prev = 0;
    for (const e of r.timeline) { if (e.event === 'loaded' && !heap[`${e.chunk}|${p}`]) heap[`${e.chunk}|${p}`] = r1(e.liveHeapMiB - prev); prev = e.liveHeapMiB; } }
  const combos = [];
  for (let k = 0; k < 16; k++) { const s = [0, 1, 2, 3].map(i => (k >> (3 - i)) & 1 ? 'f' : 'i').join(''); const d = W(`chain_${s}_b1_order.json`), pr = predsOf(d.logits);
    const prec = manifest.chain.map((c, i) => s[i] === 'f' ? 'fp32' : 'int8');
    combos.push({ spec: s, label: manifest.chain.map((c, i) => `${c.slice(0, 2)}:${s[i] === 'f' ? 'fp32' : 'int8'}`).join(' '), accuracy: d.accuracy,
      flipsVsFp32: pr.filter((x, i) => x !== fp[i]).length, flipsVsInt8: pr.filter((x, i) => x !== i8[i]).length,
      mcnemarVsInt8: mcnemar(i8, pr), mcnemarVsFp32: mcnemar(fp, pr),
      MB: r2(manifest.chain.reduce((t, c, i) => t + manifest.chunks[c][prec[i]].bytes, 0) / 1e6),
      residentHeapMiB: r1(manifest.chain.reduce((t, c, i) => t + heap[`${c}|${prec[i]}`], 0)), hash: d.logitsHash.slice(0, 12) }); }
  const pareto = key => combos.filter(a => !combos.some(b => b !== a && b.accuracy >= a.accuracy && b[key] <= a[key] && (b.accuracy > a.accuracy || b[key] < a[key]))).map(c => c.spec);
  const acc = rows('acc');
  const xcheck = { int8: acc.find(r => r.precision === 'int8' && !r.earlyExit).accuracy.logitsHash === W('chain_iiii_b1_order.json').logitsHash,
                   mixedC2: acc.find(r => r.precision === 'mixedC2' && !r.earlyExit).accuracy.logitsHash === W('chain_iifi_b1_order.json').logitsHash,
                   fp32: acc.find(r => r.precision === 'fp32' && !r.earlyExit).accuracy.logitsHash === W('chain_ffff_b1_order.json').logitsHash };
  const singles = ['fiii', 'ifii', 'iifi', 'iiif'].map(s => { const c = combos.find(x => x.spec === s), a8 = combos.find(x => x.spec === 'iiii'), a32 = combos.find(x => x.spec === 'ffff');
    return { spec: s, gapRecoveredPct: r1(100 * (c.accuracy - a8.accuracy) / (a32.accuracy - a8.accuracy)), extraMB: r2(c.MB - a8.MB), extraHeapMiB: r1(c.residentHeapMiB - a8.residentHeapMiB) }; });
  out.E4 = { perChunkHeapMiB: heap, combos, paretoAccuracyVsMB: pareto('MB'), paretoAccuracyVsHeap: pareto('residentHeapMiB'), singleFp32Chunk: singles, browserCrossCheck: xcheck };
}

// ================= E-B + F-5 =================
{
  const PL = { WASM: 'wasm', 'native x86-64 ORT 1.20.1': 'native-x86-ort1.20.1', 'native aarch64 ORT 1.20.1': 'native-arm64-ort1.20.1', 'native x86-64 ORT 1.29.0': 'native-x86-ort1.29.0' };
  const load = (d, f) => { const p = R(`${d}/${f}`); return fs.existsSync(p) ? J(p) : null; };
  const cmp = (a, b) => { let mx = 0, s = 0, fl = 0; a.forEach((l, i) => { const d = Math.max(Math.abs(l[0] - b[i][0]), Math.abs(l[1] - b[i][1])); mx = Math.max(mx, d); s += d; fl += (l[1] > l[0]) !== (b[i][1] > b[i][0]); }); return { flips: fl, meanAbsDelta: +(s / a.length).toExponential(3), maxAbsDelta: +mx.toExponential(3) }; };
  const eb = {};
  for (const [name, d] of Object.entries(PL)) for (const model of ['full', 'chain']) for (const prec of ['iiii', 'ffff']) {
    const b1 = load(d, `${model}_${prec}_b1_order.json`); if (!b1) continue;
    const rowsB = [];
    for (const b of [4, 8, 16, 32]) {
      const comps = prec === 'iiii' ? ['order', 'sorted', ...[0, 1, 2, 3, 4].map(s => `shuffled_s${s}`)] : ['order', 'shuffled_s0'];
      for (const c of comps) { const x = load(d, `${model}_${prec}_b${b}_${c}.json`); if (!x) continue; rowsB.push({ batch: b, composition: c, accuracy: x.accuracy, ...cmp(x.logits, b1.logits) }); }
    }
    const byB = Object.fromEntries([4, 8, 16, 32].map(b => { const rs = rowsB.filter(r => r.batch === b), sh = rs.filter(r => r.composition.startsWith('shuffled'));
      return [b, { order: rs.find(r => r.composition === 'order'), sorted: rs.find(r => r.composition === 'sorted') ?? null,
                   shuffled: sh.length ? { flipsMedian: med(sh.map(r => r.flips)), flipsRange: [Math.min(...sh.map(r => r.flips)), Math.max(...sh.map(r => r.flips))], accRange: [Math.min(...sh.map(r => r.accuracy)), Math.max(...sh.map(r => r.accuracy))], n: sh.length } : null }]; }));
    eb[`${name}|${model}|${prec}`] = { batch1Accuracy: b1.accuracy, batch1Hash: b1.logitsHash.slice(0, 12), byBatch: byB, all: rowsB };
  }
  // chain == full per platform and batch (bit-identical?)
  const chainEqFull = {};
  for (const [name, d] of Object.entries(PL)) { const eq = []; for (const f of fs.readdirSync(R(d)).filter(f => f.startsWith('full_'))) { const c = load(d, f.replace('full_', 'chain_')); if (c) eq.push(J(R(`${d}/${f}`)).logitsHash === c.logitsHash); } chainEqFull[name] = { pairs: eq.length, identical: eq.filter(Boolean).length }; }
  const f5 = {};
  for (const name of Object.keys(PL).filter(n => n !== 'WASM')) for (const [label, f] of [['full int8', 'full_iiii_b1_order.json'], ['chain int8', 'chain_iiii_b1_order.json'], ['mixedC2', 'chain_iifi_b1_order.json'], ['fp32 (full)', 'full_ffff_b1_order.json']]) {
    const n = load(PL[name], f), w = load('wasm', f); if (!n || !w) continue;
    f5[`${name}|${label}`] = { nativeAcc: n.accuracy, wasmAcc: w.accuracy, ...cmp(n.logits, w.logits), mcnemar: mcnemar(predsOf(w.logits), predsOf(n.logits)) };
  }
  out.EB = { perPlatform: Object.fromEntries(Object.entries(eb).map(([k, v]) => [k, { batch1Accuracy: v.batch1Accuracy, batch1Hash: v.batch1Hash, byBatch: v.byBatch }])), chainEqualsFull: chainEqFull,
             browserSpotCheck: rows('ebrowser').map(r => ({ batch: r.batch, accuracy: r.accuracy, hash: r.logitsHash.slice(0, 12) })) };
  out.F5 = f5;
}

// ================= E-F28 =================
{
  const F = rows('f28'), t = {};
  for (const st of ['a', 'b', 'c', 'd', 'e']) for (const p of ['int8', 'fp32']) t[`${st}|${p}`] = { createMs: desc(F.filter(r => r.state === st && r.precision === p).map(r => r.createMs)), totalMs: desc(F.filter(r => r.state === st && r.precision === p).map(r => r.totalMs)) };
  const contrast = {};
  for (const p of ['int8', 'fp32']) for (const st of ['b', 'c', 'd', 'e']) contrast[`${st}-a|${p}`] = diff(F.filter(r => r.state === 'a' && r.precision === p).map(r => r.createMs), F.filter(r => r.state === st && r.precision === p).map(r => r.createMs));
  out.EF28 = { byStatePrecision: t, contrastsVsA: contrast, n: F.length };
}

// ================= E-ENG =================
{
  const E = rows('eng'), traces = J(R('eng/decision_traces.json')), cal = J(R('eng/calibration_cloud.json'));
  const byId = Object.fromEntries([...generateCandidates({ earlyExit: false }), ...generateCandidates({ earlyExit: true })].map(p => [planId(p), p]));
  const shape = id => { const p = byId[id]; const mode = p.pinned.length === 4 ? 'resident' : p.pinned.length ? 'hybrid' : 'sequential'; return `${mode}${p.prewarm ? '+pre-start' : ''}`; };
  const resident = id => byId[id].pinned.length === 4;
  const measured = r => { const n = r.n, firsts = {}; for (const l of r.loads) firsts[l.chunk] ??= l.totalMs; const L = Object.values(firsts).reduce((s, x) => s + x, 0);
    return { total: r.workloadMs, L, T: resident(r.planId) ? (r.workloadMs - L) / n : r.workloadMs / n, M: Math.max(r.memory.peakTotalMiB, r.memory.lifetimeOverlapUpperMiB ?? 0) }; };
  const predTotal = r => (resident(r.planId) ? r.prediction.initialLoadMs : 0) + r.n * r.prediction.perSentenceMs;
  // time error per plan shape × cache state
  const err = {};
  for (const r of E) { const k = `${shape(r.planId)}|${r.cacheState}`; (err[k] ??= []).push(100 * (predTotal(r) - r.workloadMs) / r.workloadMs); }
  const timeError = Object.fromEntries(Object.entries(err).map(([k, v]) => [k, desc(v)]));
  const perPlan = {};
  for (const r of E) { const k = `${r.planId}|${r.cacheState}`; (perPlan[k] ??= []).push(r); }
  const planTable = Object.entries(perPlan).map(([k, rs]) => ({ plan: k.split('|').slice(0, -1).join('|'), cache: rs[0].cacheState, shape: shape(rs[0].planId),
    measuredMs: desc(rs.map(r => r.workloadMs)), predictedMs: r0(predTotal(rs[0])), errorPct: r1(med(rs.map(r => 100 * (predTotal(r) - r.workloadMs) / r.workloadMs))),
    peakMeasuredMiB: r2(Math.max(...rs.map(r => r.memory.peakWasmMiB))), upperBoundMiB: r2(Math.max(...rs.map(r => r.memory.lifetimeOverlapUpperMiB ?? 0))),
    predictedWasmMiBNoMargin: r2(rs[0].prediction.predictedWasmMiBNoMargin), predictedWasmMiBWithMargin: r2(rs[0].prediction.predictedWasmMiBWithMargin),
    memErrPctNoMargin: r1(100 * (rs[0].prediction.predictedWasmMiBNoMargin - Math.max(...rs.map(r => r.memory.peakWasmMiB))) / Math.max(...rs.map(r => r.memory.peakWasmMiB))),
    underestimated: rs.some(r => Math.max(r.memory.peakWasmMiB, r.memory.lifetimeOverlapUpperMiB ?? 0) > r.prediction.predictedWasmMiBWithMargin) }));
  // regret, rank, Spearman per decision, using the profile's own weights on MEASURED M, T, L (normalised by the best measured value)
  const dec = J(R('eng/decisions.json')).filter(d => d.link === 'localhost');
  const spearman = (a, b) => { const rk = x => { const s = x.map((v, i) => [v, i]).sort((p, q) => p[0] - q[0]); const r = []; s.forEach(([, i], k) => r[i] = k + 1); return r; };
    const ra = rk(a), rb = rk(b), n = a.length; return n > 2 ? 1 - 6 * ra.reduce((s, x, i) => s + (x - rb[i]) ** 2, 0) / (n * (n * n - 1)) : null; };
  const decisions = dec.map(d => {
    const tr = traces.find(t => t.cache === d.cache && t.profile === d.profile && t.earlyExit === d.earlyExit);
    const w = PROFILES[d.profile].weights, ids = d.measure;
    const m = Object.fromEntries(ids.map(id => { const rs = E.filter(r => r.planId === id && r.cacheState === d.cache).map(measured);
      return [id, { M: med(rs.map(x => x.M)), T: med(rs.map(x => x.T)), L: med(rs.map(x => x.L)) }]; }));
    const mn = k => Math.min(...ids.map(id => m[id][k]));
    const mc = Object.fromEntries(ids.map(id => [id, w.m * m[id].M / mn('M') + w.t * m[id].T / mn('T') + w.l * m[id].L / mn('L')]));
    const best = ids.reduce((a, b) => mc[a] <= mc[b] ? a : b);
    const order = [...ids].sort((a, b) => mc[a] - mc[b]);
    const pc = ids.map(id => tr.trace.find(t => t.id === id)?.cost);
    return { cache: d.cache, profile: d.profile, earlyExit: d.earlyExit, chosen: d.chosen, marginToSecondPct: r2(100 * d.margin), measuredPlans: ids.length,
             measuredBest: best, chosenRankMeasured: order.indexOf(d.chosen) + 1, regretPct: r1(100 * (mc[d.chosen] - mc[best]) / mc[best]),
             spearmanPredVsMeasured: r2(spearman(pc, ids.map(id => mc[id]))), measuredCost: Object.fromEntries(order.map(id => [id, r2(mc[id])])) };
  });
  // ---- I-5.1 refit (PROPOSAL ONLY). Parameterised copy of the engine's predictTime: alpha scales the pre-start overlap;
  //      bPw / bHy replace the "warm" create base for loads made warm by pre-start / by a pinned Worker. With
  //      alpha = 1, bPw = bHy = createBaseMs it must reproduce the engine's predictions (checked below).
  const ctxOf = r => ({ rttMs: 1, downlinkMbps: 1000, sentencesPerRequest: r.n, cachedSha256: r.cacheState === 'warm' ? chunkInfo(manifest, byId[r.planId]).map(c => c.sha256) : [], heapUncertainty: 1.1 });
  const eeMeta = J(path.join(ROOT, 'models/onnx/early_exit.json'));
  function predictParam(plan, ctx, { alpha = 1, bPw = cal.createBaseMs, bHy = cal.createBaseMs } = {}) {
    const chunks = chunkInfo(manifest, plan), pinned = new Set(plan.pinned), cachedNow = new Set(ctx.cachedSha256);
    const reach = reachFractions(plan, eeMeta.plans?.[plan.precision]);
    const infer = chunks.map((c, i) => reach[i] * (cal.inferMs[c.precision][c.name] + (c.hasExit ? cal.exitHeadMs : 0)));
    const transfer = reach.reduce((s, x) => s + x, 0) * cal.transferMs, compute = infer.reduce((s, x) => s + x, 0) + transfer;
    const lt = (c, cached, warmBy) => loadTime(c, warmBy === 'pin' ? { ...cal, createBaseMs: bHy } : warmBy === 'pw' ? { ...cal, createBaseMs: bPw } : cal, ctx, cached, !!warmBy);
    const anyPinnedBefore = i => chunks.slice(0, i).some(c => pinned.has(c.name));
    const first = chunks.map((c, i) => lt(c, cachedNow.has(c.sha256), i > 0 && anyPinnedBefore(i) ? 'pin' : i > 0 && plan.prewarm ? 'pw' : null));
    const steadyBy = pinned.size > 0 ? 'pin' : plan.prewarm ? 'pw' : null;
    const steady = chunks.map(c => lt(c, true, steadyBy));
    const G = Math.max(1, Math.min(plan.groupSize, ctx.sentencesPerRequest)), U = chunks.map((c, i) => i).filter(i => !pinned.has(chunks[i].name));
    let reload = 0; U.forEach((i, k) => { const ov = plan.prewarm && k > 0 ? alpha * G * infer[U[k - 1]] : 0; reload += Math.max(0, steady[i].total - ov); });
    let init = 0; chunks.forEach((c, i) => { init += plan.prewarm && i > 0 && !pinned.has(c.name) ? Math.max(0, first[i].total - alpha * infer[i - 1]) : first[i].total; });
    return (plan.pinned.length === 4 ? init : 0) + ctx.sentencesPerRequest * (compute + reload / G);
  }
  const replication = E.map(r => Math.abs(predictParam(byId[r.planId], ctxOf(r)) - predTotal(r)) / predTotal(r));
  // every plan the three parameters touch: pre-start plans, hybrid plans AND resident plans (the engine's
  // "warm because a pinned Worker is alive" rule also applies to a resident plan's 2nd–4th loads); only plain
  // sequential plans without pre-start are unaffected, and that is checked below
  const target = E.filter(r => byId[r.planId].prewarm || byId[r.planId].pinned.length > 0);
  const fitSet = target.filter(r => r.rep <= 1), evalSet = target.filter(r => r.rep >= 2);
  const loss = (set, prm) => mean(set.map(r => ((predictParam(byId[r.planId], ctxOf(r), prm) - r.workloadMs) / r.workloadMs) ** 2));
  let bestP = null, bestL = Infinity;
  for (let alpha = 0; alpha <= 1.0001; alpha += 0.05) for (let bPw = 100; bPw <= 1000; bPw += 10) for (let bHy = 100; bHy <= 1500; bHy += 20) {
    const L = loss(fitSet, { alpha, bPw, bHy }); if (L < bestL) { bestL = L; bestP = { alpha: r2(alpha), bPw, bHy }; } }
  const errs = (set, prm) => set.map(r => 100 * (predictParam(byId[r.planId], ctxOf(r), prm) - r.workloadMs) / r.workloadMs);
  const byShape = (set, prm) => Object.fromEntries([...new Set(set.map(r => `${shape(r.planId)}|${r.cacheState}`))].map(k => [k, desc(errs(set.filter(r => `${shape(r.planId)}|${r.cacheState}` === k), prm))]));
  const others = E.filter(r => !target.includes(r));
  // the narrower fit (pre-start + hybrid runs only, resident excluded) evaluated on EVERY shape, to show what it would do to resident plans
  const narrowSet = target.filter(r => r.rep <= 1 && byId[r.planId].pinned.length < 4);
  let narrowP = null, narrowL = Infinity;
  for (let alpha = 0; alpha <= 1.0001; alpha += 0.05) for (let bPw = 100; bPw <= 1000; bPw += 10) for (let bHy = 100; bHy <= 1500; bHy += 20) {
    const L = loss(narrowSet, { alpha, bPw, bHy }); if (L < narrowL) { narrowL = L; narrowP = { alpha: r2(alpha), bPw, bHy }; } }
  const evalAll = E.filter(r => r.rep >= 2);
  out.ENG = { calibration: { spawnMs: r1(cal.spawnMs), createBaseWarmMs: r1(cal.createBaseMs), createBaseColdMs: r1(cal.createBaseColdMs), createPerMiBMs: r2(cal.createPerMiBMs) },
    timeErrorByShapeAndCache: timeError, plans: planTable, memoryUnderestimates: planTable.filter(p => p.underestimated).length, decisions,
    refitProposal: { status: 'PROPOSAL ONLY — the engine is unchanged (condition 1)', replicationMaxRelDiff: Math.max(...replication),
      parameters: 'alpha = realised fraction of the pre-start overlap; bPw / bHy = create base (ms) for loads made warm by pre-start / by a pinned Worker; engine today: alpha 1, both = createBaseMs',
      fittedOn: `reps 1–2 of ${new Set(target.map(r => r.planId)).size} pre-start / hybrid / resident plans (${fitSet.length} runs)`, evaluatedOn: `reps 3–5 (${evalSet.length} runs)`,
      fitted: bestP, engineValues: { alpha: 1, bPw: r1(cal.createBaseMs), bHy: r1(cal.createBaseMs) },
      evalBefore: byShape(evalSet, {}), evalAfter: byShape(evalSet, bestP),
      narrowFit: { fittedOn: `reps 1–2 of pre-start / hybrid plans only (${narrowSet.length} runs)`, fitted: narrowP, evalAllShapes: byShape(evalAll, narrowP) },
      engineEvalAllShapes: byShape(evalAll, {}), sharedFitEvalAllShapes: byShape(evalAll, bestP), unaffectedShapesUnchanged: others.every(r => Math.abs(predictParam(byId[r.planId], ctxOf(r), bestP) - predictParam(byId[r.planId], ctxOf(r))) < 1e-6) } };
}

fs.mkdirSync(R('summary'), { recursive: true });
fs.writeFileSync(R('summary/analysis.json'), JSON.stringify(out, null, 1));
console.log('written results/phase7/summary/analysis.json');
