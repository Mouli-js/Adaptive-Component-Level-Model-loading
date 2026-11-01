/**
 * Phase 7 pilot (P-0). Usage: node bench/phase7/pilot.mjs <step>
 * Steps: cpu, net, det, probe, e1, e2, e3, e5, eng, f28   (each writes results/phase7/pilot/<step>.json)
 * Reduced workload: the 20-sentence 'pilot20' subset of the fixed 100-sentence workload.
 */
import fs from 'node:fs'; import path from 'node:path';
import { createRequire } from 'node:module';
import { ROOT, startServer, newProfile, openRunner, runOnce, envSnapshot } from './lib.mjs';
import { connectCDP, throttleCPU } from './cdp.mjs';
const { chromium } = createRequire(import.meta.url)('playwright');
const OUT = path.join(ROOT, 'results/phase7/pilot'); fs.mkdirSync(OUT, { recursive: true });
const W = JSON.parse(fs.readFileSync(path.join(ROOT, 'results/phase7/workload_100.json')));
const ALL4 = ['c0_embed', 'c1_l0_1', 'c2_l2_3', 'c3_l4_5_cls'];
const save = (step, obj) => fs.writeFileSync(path.join(OUT, `${step}.json`), JSON.stringify({ step, env: envSnapshot(), ...obj }, null, 1));
const median = a => { const s = [...a].sort((x, y) => x - y), m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };
const step = process.argv[2]; const T0 = Date.now();

async function launchWithCDP(dir) {
  const ctx = await chromium.launchPersistentContext(dir, { channel: 'chromium', args: ['--remote-debugging-port=0'] });
  return { ctx, page: ctx.pages()[0] ?? await ctx.newPage(), cdp: await connectCDP(dir) };
}

if (step === 'cpu') {
  // (1) micro-benchmark: fixed JS loop on the main thread and in a dedicated Worker, rate 4
  const server = await startServer({}); const N = 2e7, REPS = 5, RATE = 4, res = {};
  for (const scope of ['none', 'page', 'workers', 'both']) {
    const { ctx, page, cdp } = await launchWithCDP(newProfile('cpu'));
    await page.goto(`${server.base}/bench/phase7/cpu.html`); await page.waitForFunction(() => window.cpu?.ready);
    const log = scope === 'none' ? [] : await throttleCPU(cdp, 'cpu.html', RATE, scope);
    const main = await page.evaluate(([n, r]) => window.cpu.main(n, r), [N, REPS]);
    const worker = await page.evaluate(([n, r]) => window.cpu.worker(n, r, true), [N, REPS]);   // fresh Worker per rep (created after throttling)
    res[scope] = { mainMs: main.median, workerMs: worker.median, mainAll: main.all, workerAll: worker.all, cdpLog: log };
    console.log(scope, 'main', main.median.toFixed(1), 'worker', worker.median.toFixed(1), JSON.stringify(log));
    cdp.close(); await ctx.close();
  }
  // (2) real inference: resident int8 plan, compute time measured INSIDE the chunk Workers (Phase 6 trace)
  const inf = {};
  for (const scope of ['none', 'page', 'both']) {
    const dir = newProfile('cpuinf');
    const { ctx, page, cdp } = await launchWithCDP(dir);
    await page.goto(`${server.base}/bench/phase7/runner.html`); await page.waitForFunction(() => window.p7?.ready, null, { timeout: 120000 });
    const log = scope === 'none' ? [] : await throttleCPU(cdp, 'runner.html', RATE, scope);
    const r = await page.evaluate(c => window.p7.run(c), { policy: 'plan', precision: 'int8', plan: { pinned: ALL4, groupSize: 1, prewarm: false, earlyExit: false },
                                                         workload: W.pilot20, requestMode: 'single', discard: 5, cache: false });
    const comp = r.trace.slice(5).map(t => t.computeMs);
    inf[scope] = { workerComputeMedianMs: median(comp), requestMedianMs: r.m4MedianMs, ttfiMs: r.ttfiMs, cdpWorkerTargets: log.filter(l => l.target === 'worker').length, cdpLog: log };
    console.log('inference', scope, 'compute(worker)', median(comp).toFixed(1), 'request', r.m4MedianMs.toFixed(1), 'ttfi', r.ttfiMs.toFixed(0), 'workers throttled', inf[scope].cdpWorkerTargets);
    cdp.close(); await ctx.close();
  }
  server.close();
  const ratio = (a, b) => +(a / b).toFixed(2);
  const summary = { rate: RATE,
    micro: { mainSlowdown: { page: ratio(res.page.mainMs, res.none.mainMs), workers: ratio(res.workers.mainMs, res.none.mainMs), both: ratio(res.both.mainMs, res.none.mainMs) },
             workerSlowdown: { page: ratio(res.page.workerMs, res.none.workerMs), workers: ratio(res.workers.workerMs, res.none.workerMs), both: ratio(res.both.workerMs, res.none.workerMs) } },
    inference: { workerComputeSlowdown: { page: ratio(inf.page.workerComputeMedianMs, inf.none.workerComputeMedianMs), both: ratio(inf.both.workerComputeMedianMs, inf.none.workerComputeMedianMs) },
                 requestSlowdown: { page: ratio(inf.page.requestMedianMs, inf.none.requestMedianMs), both: ratio(inf.both.requestMedianMs, inf.none.requestMedianMs) } } };
  console.log(JSON.stringify(summary));
  save('cpu', { micro: res, inference: inf, summary, wallS: (Date.now() - T0) / 1000 });
}

if (step === 'net') {
  // Throttle accuracy: fetch a 14.28 MB chunk at each configured rate; rate = bytes / (last byte − first byte).
  // Also 2 concurrent fetches at 20 Mbit/s (the bucket is shared, like a real link), and one fetch from a Worker.
  const file = '/models/onnx/int8/c1_l0_1.onnx', rows = [];
  const measure = async (page, conc) => page.evaluate(async ([u, conc]) => {
    const one = async () => { const t0 = performance.now(); const r = await fetch(u, { cache: 'no-store' }); const t1 = performance.now();
      const b = await r.arrayBuffer(); const t2 = performance.now(); return { bytes: b.byteLength, ttfbMs: t1 - t0, bodyMs: t2 - t1, totalMs: t2 - t0 }; };
    const t = performance.now(); const parts = await Promise.all([...Array(conc)].map(one)); return { parts, wallMs: performance.now() - t };
  }, [file, conc]);
  const measureWorker = async page => page.evaluate(async u => new Promise(res => {
    const src = `onmessage = async e => { const t0 = performance.now(); const r = await fetch(e.data, { cache: 'no-store' }); const t1 = performance.now(); const b = await r.arrayBuffer(); postMessage({ bytes: b.byteLength, ttfbMs: t1 - t0, bodyMs: performance.now() - t1 }); }`;
    const w = new Worker(URL.createObjectURL(new Blob([src], { type: 'text/javascript' }))); w.onmessage = e => { res(e.data); w.terminate(); }; w.postMessage(new URL(u, location.href).href);
  }), file);
  for (const [mbps, conc, where] of [[50, 1, 'page'], [20, 1, 'page'], [10, 1, 'page'], [5, 1, 'page'], [20, 2, 'page'], [20, 1, 'worker']]) {
    const server = await startServer({ mbps, rttMs: 40 });
    const { ctx, page } = await openRunner(newProfile('net'), server.base);
    const m = where === 'worker' ? { parts: [await measureWorker(page)] } : await measure(page, conc);
    await ctx.close(); server.close();
    const totalBytes = m.parts.reduce((s, p) => s + p.bytes, 0);
    const spanMs = where === 'worker' ? m.parts[0].bodyMs : Math.max(...m.parts.map(p => p.ttfbMs + p.bodyMs)) - Math.min(...m.parts.map(p => p.ttfbMs));
    const measuredMbps = totalBytes * 8 / 1e6 / (spanMs / 1000);
    const row = { mbps, concurrent: conc, where, bytes: totalBytes, bodySpanMs: +spanMs.toFixed(0), ttfbMs: m.parts.map(p => +p.ttfbMs.toFixed(1)),
                  measuredMbps: +measuredMbps.toFixed(3), errorPct: +(100 * (measuredMbps - mbps) / mbps).toFixed(2) };
    row.within5pct = Math.abs(row.errorPct) <= 5; rows.push(row);
    console.log(JSON.stringify(row));
  }
  save('net', { file, rttTargetMs: 40, rows, allWithin5pct: rows.every(r => r.within5pct), wallS: (Date.now() - T0) / 1000 });
}

if (step === 'det') {
  // Determinism: the same 872-sentence run twice, each in a NEW browser process, per precision (resident plan,
  // no cache so both runs load identically). Gate: identical SHA-256 of all logits; int8 also Δ = 0 vs the
  // Phase 3 WASM reference; early exit: identical exit points. Appends to det.jsonl (resumable), then summarises.
  const { jsonl } = await import('./lib.mjs');
  const J = jsonl(path.join(OUT, 'det.jsonl'));
  const server = await startServer({});
  const todo = (process.env.ONLY || 'int8:0,int8:1,mixedC2:0,mixedC2:1,fp32:0,fp32:1,int8ee:0').split(',');
  for (const k of todo) {
    if (J.done.has(k)) continue;
    const [p] = k.split(':'), ee = p.endsWith('ee'), precision = ee ? p.slice(0, -2) : p;
    const r = await runOnce({ server, profileDir: newProfile('det'), cfg: { policy: 'plan', precision, plan: { pinned: ALL4, groupSize: 1, prewarm: false, earlyExit: ee },
      workload: W.pilot20.slice(0, 1), requestMode: 'single', discard: 0, accuracy: true, cache: false } });
    const a = r.accuracy;
    J.append({ key: k, precision, earlyExit: ee, accuracy: a.accuracy, logitsHash: a.logitsHash, maxAbsDiffVsRef: a.maxAbsDiffVsRef, exitMismatch: a.exitMismatch,
               exits: a.exits, accuracyRunMs: a.ms, wallS: r.wallS, errors: r.errors, predictions: a.predictions });
    console.log(k, a.accuracy.toFixed(4), a.logitsHash.slice(0, 16), 'maxΔref', a.maxAbsDiffVsRef, 'exitMismatch', a.exitMismatch, (a.ms / 1000).toFixed(1) + 's', 'wall', r.wallS);
  }
  server.close();
}

if (step === 'probe') {
  // Worker memory-probe verification against the browser's own measurement (measureUserAgentSpecificMemory,
  // ForceEagerMeasureMemory): 4 resident Workers alive → UA must see ≥ the probe sum (it also counts JS/DOM),
  // and after terminate the UA total must drop by ≈ the probe sum (D-3). Also: every live Worker reported a heap.
  const server = await startServer({}); const rows = {};
  for (const precision of ['int8', 'fp32']) {
    const { ctx, page, errors } = await openRunner(newProfile('probe'), server.base, { uaMemory: true });
    const t = Date.now(); const r = await page.evaluate(p => window.p7.probeCheck({ precision: p }), precision); r.wallS = (Date.now() - t) / 1000; r.errors = errors;
    await ctx.close();
    const wasmUA = m => m.uaByType ? Object.entries(m.uaByType).filter(([k]) => /wasm|WebAssembly/i.test(k)).reduce((s, [, v]) => s + v, 0) / 1048576 : null;
    r.check = { allWorkersReported: r.perWorker.length === 4 && r.perWorker.every(w => w.heapMiB > 0),
                uaDuringMinusBeforeMiB: r.during.uaMiB != null ? +(r.during.uaMiB - r.before.uaMiB).toFixed(2) : null,
                uaDropAfterTerminateMiB: r.during.uaMiB != null ? +(r.during.uaMiB - r.after.uaMiB).toFixed(2) : null,
                uaWasmTypeDuringMiB: wasmUA(r.during) != null ? +wasmUA(r.during).toFixed(2) : null };
    r.check.probeVsUaIncreasePct = r.check.uaDuringMinusBeforeMiB ? +(100 * (r.probeSumMiB - r.check.uaDuringMinusBeforeMiB) / r.check.uaDuringMinusBeforeMiB).toFixed(1) : null;
    rows[precision] = r; console.log(precision, JSON.stringify({ perWorker: r.perWorker, probeSumMiB: r.probeSumMiB, before: r.before.uaMiB, during: r.during.uaMiB, after: r.after.uaMiB, check: r.check, wallS: r.wallS, uaError: r.during.uaError }));
  }
  server.close();
  save('probe', { rows, wallS: (Date.now() - T0) / 1000 });
}

// ---------- experiment pilots: 1 repetition, reduced workload (pilot20), wall time recorded per run ----------
const POLICIES = {
  baseline:   { policy: 'baseline', requestMode: 'single' },
  chain:      { policy: 'chain', requestMode: 'single' },
  resident:   { policy: 'plan', plan: { pinned: ALL4, groupSize: 1, prewarm: false, earlyExit: false }, requestMode: 'single' },
  sequential: { policy: 'plan', plan: { pinned: [], groupSize: 32, prewarm: false, earlyExit: false }, requestMode: 'batch' },
  hybrid:     { policy: 'plan', plan: { pinned: ['c0_embed'], groupSize: 8, prewarm: false, earlyExit: false }, requestMode: 'batch' },
};
const brief = r => ({ planId: r.planId, ttfiMs: r.ttfiMs != null ? +r.ttfiMs.toFixed(0) : null, m4MedianMs: r.m4MedianMs != null ? +r.m4MedianMs.toFixed(1) : null, m4AmortisedMs: +r.m4AmortisedMs.toFixed(1),
  workloadMs: +r.workloadMs.toFixed(0), memory: r.memory, maxLiveWorkers: r.maxLiveWorkers, spawns: r.spawns, serverBytes: r.server.onnxBytes, serverRequests: r.server.onnxRequests,
  sources: (r.allLoads || []).map(l => l.source), firstLoads: (r.firstLoads || []).map(l => ({ chunk: l.chunk, source: l.source, bytesMs: Math.round(l.bytesMs ?? 0), createMs: Math.round(l.createMs ?? 0), totalMs: l.totalMs != null ? Math.round(l.totalMs) : null })), cacheBefore: r.cacheBefore, cacheAfter: r.cacheAfter, exits: r.trace.reduce((a, x) => (a[x.exitAt] = (a[x.exitAt] || 0) + 1, a), {}),
  hash: r.workloadLogitsHash.slice(0, 16), wallS: r.wallS, errors: r.errors });

if (step === 'e1') {
  // E1 cache state: OFF for every policy (bytes come from the unthrottled localhost server), so the baseline and
  // chain (which have no IndexedDB tier) and the Worker policies load under the same conditions.
  const server = await startServer({}); const rows = [];
  for (const precision of ['int8', 'mixedC2', 'fp32']) for (const [name, p] of Object.entries(POLICIES)) {
    if (name === 'baseline' && precision === 'mixedC2') { rows.push({ precision, policy: name, skipped: 'no single-file mixed model (by design)' }); continue; }
    const r = await runOnce({ server, profileDir: newProfile('e1'), cfg: { ...p, precision, workload: W.pilot20, discard: 5, cache: false } });
    const b = { precision, policy: name, ...brief(r) }; rows.push(b);
    console.log(precision, name, 'peak', r.memory.peakTotalMiB, 'MiB ttfi', b.ttfiMs, 'm4', b.m4MedianMs ?? b.m4AmortisedMs, 'wall', r.wallS);
  }
  server.close(); save('e1', { workload: 'pilot20', cacheState: 'off (localhost network, 1e12 B/s)', rows, wallS: (Date.now() - T0) / 1000 });
}

if (step === 'e2') {
  // E2 pilot: COLD (new profile, empty IndexedDB, cache ON so the cold request also fills it), int8, 20 Mbit/s, RTT 40.
  const server = await startServer({ mbps: 20, rttMs: 40 }); const rows = [];
  for (const G of [1, 32]) for (const prewarm of [false, true]) {
    const r = await runOnce({ server, profileDir: newProfile('e2'), cfg: { policy: 'plan', precision: 'int8', plan: { pinned: [], groupSize: G, prewarm, earlyExit: false },
      workload: W.pilot20, requestMode: 'batch', cache: true } });
    const b = { G, prewarm, cacheState: 'cold', ...brief(r) }; rows.push(b);
    console.log('G', G, 'pw', prewarm, 'ttfi', b.ttfiMs, 'workload', b.workloadMs, 'peak', r.memory.peakWasmMiB, 'upper', r.memory.lifetimeOverlapUpperMiB, 'bytes', b.serverBytes, 'wall', r.wallS);
  }
  server.close(); save('e2', { link: '20 Mbit/s, RTT 40 ms', workload: 'pilot20', rows, wallS: (Date.now() - T0) / 1000 });
}

if (step === 'e3') {
  const server = await startServer({}); const rows = [];
  // (a) H3 bytes: ONE cold single-sentence request, sequential G=1, nothing pinned, cache ON, empty profile.
  //     Sentences chosen from the int8 early-exit reference: #0 exits at e1, #1 at e2, #3 runs the full chain.
  for (const [idx, expect] of [[0, 'e1'], [1, 'e2'], [3, 'full']]) for (const ee of [false, true]) for (const prewarm of [false, true]) {
    if (!ee && prewarm) continue;
    const r = await runOnce({ server, profileDir: newProfile('e3'), cfg: { policy: 'plan', precision: 'int8', plan: { pinned: [], groupSize: 1, prewarm, earlyExit: ee },
      workload: [idx], requestMode: 'batch', cache: true } });
    const b = { part: 'bytes', sentence: idx, expectExit: expect, earlyExit: ee, prewarm, cacheState: 'cold', ...brief(r), path: r.trace[0]?.path };
    rows.push(b); console.log('bytes', idx, expect, 'ee', ee, 'pw', prewarm, 'served MB', (b.serverBytes / 1e6).toFixed(2), 'requests', b.serverRequests, 'ttfi', b.ttfiMs, 'path', (r.trace[0]?.path || []).join('>'));
  }
  // (b) latency: resident int8, early exit off/on, pilot20 single requests, cache off
  for (const ee of [false, true]) {
    const r = await runOnce({ server, profileDir: newProfile('e3'), cfg: { policy: 'plan', precision: 'int8', plan: { pinned: ALL4, groupSize: 1, prewarm: false, earlyExit: ee },
      workload: W.pilot20, requestMode: 'single', discard: 5, cache: false } });
    const b = { part: 'latency', earlyExit: ee, ...brief(r) }; rows.push(b);
    console.log('latency ee', ee, 'm4', b.m4MedianMs, 'exits', JSON.stringify(b.exits), 'wall', r.wallS);
  }
  server.close(); save('e3', { rows, wallS: (Date.now() - T0) / 1000 });
}

if (step === 'e5') {
  // E5 pilot: int8, 50 Mbit/s, RTT 40; visit 0 = cold (empty profile), visits 1–3 = revisits (same profile,
  // new browser process each). Sequential G=32 as in F-23. M6 = IndexedDB hits / lookups over the revisits.
  const server = await startServer({ mbps: 50, rttMs: 40 }); const dir = newProfile('e5'); const rows = [];
  for (let v = 0; v < 4; v++) {
    const r = await runOnce({ server, profileDir: dir, cfg: { policy: 'plan', precision: 'int8', plan: { pinned: [], groupSize: 32, prewarm: false, earlyExit: false },
      workload: W.pilot20, requestMode: 'batch', cache: true } });
    const b = { visit: v, cacheState: v ? 'warm' : 'cold', ...brief(r) }; rows.push(b);
    console.log('visit', v, 'ttfi', b.ttfiMs, 'bytes', b.serverBytes, 'sources', b.sources.join(','), 'cacheBefore', JSON.stringify(b.cacheBefore), 'wall', r.wallS);
  }
  const rev = rows.slice(1).flatMap(r => r.sources); const m6 = rev.filter(s => s === 'idb').length / rev.length;
  server.close(); save('e5', { link: '50 Mbit/s, RTT 40 ms', rows, m6HitRateRevisits: m6, speedup: +(rows[0].ttfiMs / (rows.slice(1).reduce((s, r) => s + r.ttfiMs, 0) / 3)).toFixed(2), wallS: (Date.now() - T0) / 1000 });
  console.log('M6', m6);
}

if (step === 'eng') {
  // E-ENG pilot. Cache-state control (your fairness rule): WARM runs start from an identical copy of a master
  // profile that holds EVERY chunk of every precision + both exit heads; COLD runs start from an empty profile.
  // The cache state is recorded per run. Decisions are made under both states (they can differ: the engine
  // reads which chunks are cached).
  const server = await startServer({});
  const master = newProfile('engmaster');
  for (const precision of ['int8', 'fp32']) await runOnce({ server, profileDir: master, cfg: { policy: 'plan', precision,
    plan: { pinned: [], groupSize: 1, prewarm: false, earlyExit: true }, workload: [3], requestMode: 'batch', cache: true } });   // sentence 3 runs the full path: loads all chunks + both heads
  const copy = () => { const d = newProfile('engwarm'); fs.cpSync(master, d, { recursive: true }); for (const f of ['SingletonLock', 'SingletonCookie', 'SingletonSocket', 'DevToolsActivePort']) fs.rmSync(path.join(d, f), { force: true }); return d; };
  // calibration: once, in a warm copy; saved so every later process uses the same values
  let { ctx, page } = await openRunner(copy(), server.base);
  const tc = Date.now(); const calibration = await page.evaluate(() => window.p7.calibrate()); const calibrationS = (Date.now() - tc) / 1000;
  const masterCache = await page.evaluate(() => window.p7.cacheState()); await ctx.close();
  fs.writeFileSync(path.join(OUT, 'calibration_cloud.json'), JSON.stringify(calibration, null, 1));
  // decisions: 3 profiles × early exit off/on × cache cold/warm
  const decisions = [];
  for (const cache of ['cold', 'warm']) {
    ({ ctx, page } = await openRunner(cache === 'warm' ? copy() : newProfile('engcold'), server.base));
    for (const profile of ['low', 'mid', 'high']) for (const earlyExit of [false, true]) {
      const d = await page.evaluate(a => window.p7.decide(a), { profile, overrides: { sentencesPerRequest: 20, earlyExit }, calibration });
      const feas = d.trace.filter(t => t.status !== 'rejected').sort((a, b) => a.rank - b.rank);
      const npin = t => typeof t.pinned === 'number' ? t.pinned : t.pinned.length;     // the trace stores the pin COUNT
      const fam = t => `${t.precision}|${npin(t) === 4 ? 'resident' : npin(t) ? 'hybrid' : 'sequential'}|ee=${+t.earlyExit}`;
      const bestPerFamily = Object.values(feas.reduce((a, t) => (a[fam(t)] ??= t, a), {}));
      const toMeasure = [...new Set([d.plan?.id, ...feas.slice(0, 5).map(t => t.id), ...bestPerFamily.map(t => t.id)].filter(Boolean))];
      decisions.push({ cache, profile, earlyExit, chosen: d.plan?.id ?? null, feasible: d.feasible, nCandidates: d.trace.length, nFeasible: feas.length,
                       bestHybrid: feas.find(t => npin(t) > 0 && npin(t) < 4)?.id ?? null, families: bestPerFamily.map(t => fam(t)), top3: feas.slice(0, 3).map(t => ({ id: t.id, rank: t.rank, cost: t.cost })), toMeasure, plan: d.plan, cachedChunks: d.signals?.cachedChunks ?? d.signals?.cache ?? null });
      console.log(cache, profile, 'ee', earlyExit, '→', d.plan?.id, '| feasible', feas.length, '| to measure', toMeasure.length);
    }
    await ctx.close();
  }
  const unique = [...new Set(decisions.flatMap(d => d.toMeasure))];
  // measure: the mid (ee off) chosen plan, warm and cold, + its prediction under the run's actual conditions
  const runs = [];
  for (const dsel of decisions.filter(d => !d.earlyExit && d.profile === 'mid')) {
    const plan = { precision: dsel.plan.precision, pinned: dsel.plan.pinned, groupSize: dsel.plan.groupSize, prewarm: dsel.plan.prewarm, earlyExit: false };
    const dir = dsel.cache === 'warm' ? copy() : newProfile('engcold');
    ({ ctx, page } = await openRunner(dir, server.base));
    const pred = await page.evaluate(a => window.p7.predict(a), { plan, n: 20, calibration }); await ctx.close();
    // exactly the request the engine planned for: ONE call with sentencesPerRequest = 20 sentences
    const r = await runOnce({ server, profileDir: dir, cfg: { policy: 'plan', precision: plan.precision, plan, workload: W.pilot20, requestMode: 'batch', cache: true, ttfi: false } });
    const measuredTotal = r.workloadMs, resident = plan.pinned.length === 4;
    const predictedTotal = (resident ? pred.initialLoadMs : 0) + 20 * pred.perSentenceMs;
    runs.push({ decisionCache: dsel.cache, runCache: dsel.cache, planId: r.planId, ...brief(r), predicted: { wasmMiBWithMargin: pred.predictedWasmMiBWithMargin, totalMs: Math.round(predictedTotal) },
                measuredTotalMs: Math.round(measuredTotal), timeErrorPct: +(100 * (predictedTotal - measuredTotal) / measuredTotal).toFixed(1),
                memoryUnderestimated: r.memory.peakWasmMiB > pred.predictedWasmMiBWithMargin });
    console.log('measure', dsel.cache, r.planId, 'time err', runs.at(-1).timeErrorPct, '% mem', r.memory.peakWasmMiB, '≤', pred.predictedWasmMiBWithMargin.toFixed(1), 'bytes', r.server.onnxBytes, 'wall', r.wallS);
  }
  server.close();
  save('eng', { masterCache, calibrationS, decisions, uniquePlansToMeasure: unique.length, runs, wallS: (Date.now() - T0) / 1000 });
  console.log('unique plans to measure:', unique.length, 'calibration', calibrationS, 's');
}

if (step === 'engstab') {
  // Decision stability: the SAME decision request repeated with (i) a fixed calibration file (engine determinism)
  // and (ii) freshly measured calibrations (how much calibration noise moves the decision). Cold profile each time.
  const server = await startServer({}); const out = { fixed: [], fresh: [] };
  const fixedCal = JSON.parse(fs.readFileSync(process.env.CAL));
  const ask = async (page, calibration) => {
    const r = {};
    for (const profile of ['low', 'mid', 'high']) for (const earlyExit of [false, true]) {
      const d = await page.evaluate(a => window.p7.decide(a), { profile, overrides: { sentencesPerRequest: 20, earlyExit }, calibration });
      const feas = d.trace.filter(t => t.status !== 'rejected').sort((a, b) => a.rank - b.rank);
      r[`${profile}|ee${+earlyExit}`] = { chosen: d.plan?.id, top3: feas.slice(0, 3).map(t => ({ id: t.id, cost: +t.cost.toFixed(4) })) };
    } return r; };
  for (let k = 0; k < 3; k++) { const { ctx, page } = await openRunner(newProfile('stab'), server.base); out.fixed.push(await ask(page, fixedCal)); await ctx.close(); }
  for (let k = 0; k < 3; k++) { const { ctx, page } = await openRunner(newProfile('stab'), server.base);
    const cal = await page.evaluate(() => window.p7.calibrate()); const d = await ask(page, cal); d._calibration = cal; out.fresh.push(d); await ctx.close(); }
  server.close();
  const keys = Object.keys(out.fixed[0]);
  out.summary = Object.fromEntries(keys.map(k => [k, { fixedDistinct: [...new Set(out.fixed.map(x => x[k].chosen))], freshDistinct: [...new Set(out.fresh.map(x => x[k].chosen))],
    freshTop2RelGap: out.fresh.map(x => x[k].top3.length > 1 ? +((x[k].top3[1].cost - x[k].top3[0].cost) / x[k].top3[0].cost * 100).toFixed(2) : null) }]));
  console.log(JSON.stringify(out.summary, null, 1));
  save('engstab', { ...out, wallS: (Date.now() - T0) / 1000 });
}

if (step === 'f28') {
  // E-F28 pilot: create the c1 int8 Worker under 4 states (a none alive, b another chunk Worker with a session,
  // c a Worker with ORT initialised but no session, d one just terminated). Bytes from IndexedDB (primed profile),
  // so only creation differs. One fresh browser process per state; 3 repetitions inside; order recorded.
  const server = await startServer({}); const master = newProfile('f28m');
  await runOnce({ server, profileDir: master, cfg: { policy: 'plan', precision: 'int8', plan: { pinned: [], groupSize: 1, prewarm: false, earlyExit: false }, workload: [3], requestMode: 'batch', cache: true } });
  const copy = () => { const d = newProfile('f28'); fs.cpSync(master, d, { recursive: true }); for (const f of ['SingletonLock', 'SingletonCookie', 'SingletonSocket']) fs.rmSync(path.join(d, f), { force: true }); return d; };
  const rows = [];
  for (const state of ['a', 'b', 'c', 'd', 'e']) {
    const { ctx, page, errors } = await openRunner(copy(), server.base);
    for (let k = 0; k < 3; k++) { const r = await page.evaluate(s => window.p7.creation({ chunk: 'c1_l0_1', precision: 'int8', state: s }), state); r.rep = k; rows.push(r);
      console.log(state, k, 'total', r.totalMs.toFixed(0), 'init', r.spawnInitMs.toFixed(0), 'create', r.createMs.toFixed(0), 'bytes', r.bytesMs.toFixed(0), r.source); }
    if (errors.length) console.log('errors', errors); await ctx.close();
  }
  server.close(); save('f28', { rows, wallS: (Date.now() - T0) / 1000 });
}
