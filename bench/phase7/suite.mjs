/**
 * Phase 7 full suite (plan v1.2). Usage:
 *   node bench/phase7/suite.mjs <block> [--smoke]
 * Blocks (run in the checklist order, each validated by validate.mjs before the next):
 *   acc      accuracy + determinism (precision × early exit × 2 runs)
 *   e1       E1 policies × precision + E3 latency (early exit ON variants), w100, cache OFF
 *   f28      E-F28 creation states a–e × chunk × precision × 10, one browser process each
 *   eng      E-ENG: one fixed calibration, decisions (cold/warm, + throttled link decision-only), measured set × 5 × {warm, cold}
 *   e3bytes  E3 bytes: 30 sentences per precision (10 per exit class) × {ee off, ee on, ee on + pre-start}, cold, 1 run each
 *   netcheck throttle accuracy re-check (gate ±5%) before the network blocks
 *   net      E2 + E5 at {unthrottled, 20, 5} Mbit/s: cold TTFI + w100 (G 32), pre-start off/on; pre-start-off profiles get 3 revisits (E5)
 *   e5x      E5 extra links {50, 10} Mbit/s: cold + 3 revisits
 *   g1       R1: one 20-sentence G = 1 throughput measurement per pre-start setting (indicative, n = 1)
 *   ebrowser E-B browser spot check: chain int8 at batch 1 and 32 in Chromium
 * Every run: fresh browser process; row appended to results/phase7/<block>/runs.jsonl; resumable;
 * TIME_BUDGET_S (default 540) stops cleanly between runs so each sandbox call stays under its limit.
 * --smoke: 1 repetition, at most 2 configurations, separate output dir (harness check only, not results).
 */
import fs from 'node:fs'; import path from 'node:path';
import { ROOT, startServer, newProfile, openRunner, runOnce, jsonl, envSnapshot, shuffle } from './lib.mjs';

const block = process.argv[2], SMOKE = process.argv.includes('--smoke');
const BUDGET = Number(process.env.TIME_BUDGET_S || 540) * 1000, T0 = Date.now();
const OUT = path.join(ROOT, 'results/phase7', SMOKE ? `_smoke/${block}` : block); fs.mkdirSync(OUT, { recursive: true });
const J = jsonl(path.join(OUT, 'runs.jsonl'));
const W = JSON.parse(fs.readFileSync(path.join(ROOT, 'results/phase7/workload_100.json')));
const ALL4 = ['c0_embed', 'c1_l0_1', 'c2_l2_3', 'c3_l4_5_cls'];
const PREC = ['int8', 'mixedC2', 'fp32'];
const REPS = SMOKE ? 1 : 5;
const PROFILES_DIR = '/home/claude/p7profiles'; fs.mkdirSync(PROFILES_DIR, { recursive: true });
const CONFIG_ID = { 0: 'CLOUD-HL-1T', 50: 'CLOUD-HL-1T-NET-50', 20: 'CLOUD-HL-1T-NET-20', 10: 'CLOUD-HL-1T-NET-10', 5: 'CLOUD-HL-1T-NET-5' };
const outOfTime = () => Date.now() - T0 > BUDGET;
const median = a => { const s = [...a].sort((x, y) => x - y), m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };
fs.writeFileSync(path.join(OUT, `env_${Date.now()}.json`), JSON.stringify({ block, smoke: SMOKE, ...envSnapshot() }, null, 1));

/** Row = everything the analysis needs; nothing is dropped (outliers included). */
function row(key, meta, r) {
  return { key, block, ...meta, date: new Date().toISOString(), planId: r.planId,
    ttfiMs: r.ttfiMs, workloadMs: r.workloadMs, n: r.n, m4MedianMs: r.m4MedianMs, m4AmortisedMs: r.m4AmortisedMs, requestMs: r.requestMs,
    memory: r.memory, ua: r.ua, refCheck: r.refCheck, maxLiveWorkers: r.maxLiveWorkers, spawns: r.spawns,
    loads: (r.allLoads || []).map(l => ({ chunk: l.chunk, source: l.source, totalMs: l.totalMs ?? null, bytesMs: l.bytesMs ?? null, createMs: l.createMs ?? null, spawnInitMs: l.spawnInitMs ?? null })),
    firstLoadsN: (r.firstLoads || []).length,
    trace: r.trace, timeline: r.timeline, exits: r.trace.reduce((a, x) => (a[x.exitAt] = (a[x.exitAt] || 0) + 1, a), {}),
    accuracy: r.accuracy, server: r.server, cacheBefore: r.cacheBefore, cacheAfter: r.cacheAfter,
    origin: r.env?.origin, browser: r.env?.userAgent, pageThreads: r.pageThreads, wallS: r.wallS, errors: r.errors };
}
// Each run's browser profile is DELETED after the run (a profile can hold up to ~340 MB of cached chunks; the pilot
// filled the workspace disk and IndexedDB writes failed with IOError). keepProfile: true only for profiles that
// revisits still need (E5); those are deleted after the last revisit.
const dropProfile = d => { try { fs.rmSync(d, { recursive: true, force: true }); } catch {} };
async function runRow(key, meta, args) {
  if (J.done.has(key)) { if (!args.keepProfile) dropProfile(args.profileDir); return 'skip'; }
  if (outOfTime()) return 'stop';
  let r;
  try { r = await runOnce(args); }
  catch (e) { J.append({ key, block, ...meta, date: new Date().toISOString(), failed: true, error: String(e).slice(0, 2000) }); console.log('FAILED', key, String(e).slice(0, 200)); if (!args.keepProfile) dropProfile(args.profileDir); return 'failed'; }
  if (!args.keepProfile) dropProfile(args.profileDir);
  J.append(row(key, meta, r)); console.log(key, r.ttfiMs != null ? `ttfi ${r.ttfiMs.toFixed(0)}` : '', `wl ${r.workloadMs?.toFixed(0)}`, `peak ${r.memory.peakTotalMiB}`, `ref ${r.refCheck?.pass}`, `bytes ${r.server.onnxBytes}`, `wall ${r.wallS}`);
  return 'ok';
}

/** Primed profile: every chunk of the given precisions (+ both exit heads) in IndexedDB. Built once, then COPIED per run. */
async function primedMaster(name, precisions, server) {
  const dir = path.join(PROFILES_DIR, name), stamp = path.join(dir, '.primed.json');
  if (fs.existsSync(stamp)) { const info = JSON.parse(fs.readFileSync(stamp)); if (info.origin === server.base) return { dir, info };
    console.log(`primed profile ${name} belongs to ${info.origin}, not ${server.base}: rebuilding`); }
  fs.rmSync(dir, { recursive: true, force: true }); fs.mkdirSync(dir, { recursive: true });
  for (const precision of precisions)            // sentence 3 runs the full path → all 4 chunks + both heads are fetched and stored
    await runOnce({ server, profileDir: dir, cfg: { policy: 'plan', precision, plan: { pinned: [], groupSize: 1, prewarm: false, earlyExit: true }, workload: [3], requestMode: 'batch', cache: true } });
  const { ctx, page } = await openRunner(dir, server.base); const info = { ...(await page.evaluate(() => window.p7.cacheState())), origin: server.base }; await ctx.close();
  fs.writeFileSync(stamp, JSON.stringify(info)); return { dir, info };
}
const copyProfile = (src, tag) => { const d = newProfile(tag); fs.cpSync(src, d, { recursive: true });
  for (const f of ['SingletonLock', 'SingletonCookie', 'SingletonSocket', 'DevToolsActivePort', '.primed.json']) fs.rmSync(path.join(d, f), { force: true }); return d; };

const POLICY = {
  baseline:   { policy: 'baseline', requestMode: 'single' },
  chain:      { policy: 'chain', requestMode: 'single' },
  resident:   { policy: 'plan', plan: { pinned: ALL4, groupSize: 1, prewarm: false, earlyExit: false }, requestMode: 'single' },
  sequential: { policy: 'plan', plan: { pinned: [], groupSize: 32, prewarm: false, earlyExit: false }, requestMode: 'batch' },
  // hybrid = the engine's best hybrid pin set and group size in the pilot (pin C0, G 32); pre-start OFF here (its effect is E2's question)
  hybrid:     { policy: 'plan', plan: { pinned: ['c0_embed'], groupSize: 32, prewarm: false, earlyExit: false }, requestMode: 'batch' },
};
const withEE = p => ({ ...p, plan: { ...p.plan, earlyExit: true } });
const lim = a => SMOKE ? a.slice(0, 2) : a;
let status = 'ok';

// ------------------------------------------------------------------------------------------------
if (block === 'acc') {
  const server = await startServer({});
  for (const precision of PREC) for (const ee of [false, true]) for (const rep of SMOKE ? [0] : [0, 1]) {
    const key = `acc|${precision}|ee${+ee}|rep${rep}`;
    status = await runRow(key, { exp: 'ACC', configId: 'CLOUD-HL-1T', precision, earlyExit: ee, rep, cacheState: 'off' },
      { server, profileDir: newProfile('acc'), cfg: { policy: 'plan', precision, plan: { pinned: ALL4, groupSize: 1, prewarm: false, earlyExit: ee },
        workload: [W.w100[0]], requestMode: 'single', discard: 0, accuracy: true, cache: false } });
    if (status === 'stop') break;
  }
  server.close();
}

if (block === 'e1') {
  const server = await startServer({});
  const cfgs = [];
  for (const precision of PREC) for (const [name, p] of Object.entries(POLICY)) {
    if (name === 'baseline' && precision === 'mixedC2') continue;                 // no single-file mixed model (by design)
    cfgs.push({ name: `${name}|${precision}|ee0`, exp: 'E1', precision, policy: name, earlyExit: false, cfg: { ...p, precision } });
    if (name === 'resident' || name === 'sequential')                              // E3 latency: same plans with early exit ON
      cfgs.push({ name: `${name}|${precision}|ee1`, exp: 'E3-LAT', precision, policy: name, earlyExit: true, cfg: { ...withEE(p), precision } });
  }
  outer: for (let rep = 0; rep < REPS; rep++) {
    const order = shuffle(lim(cfgs), 1000 + rep);
    for (let k = 0; k < order.length; k++) {
      const c = order[k], ua = rep === 0 && ['baseline', 'chain', 'resident'].includes(c.policy);   // UA spot check (D-7.7): rep 1, configs whose memory is resident at the end
      status = await runRow(`e1|${c.name}|rep${rep}`, { exp: c.exp, configId: 'CLOUD-HL-1T', precision: c.precision, policy: c.policy, earlyExit: c.earlyExit, rep, orderIndex: k, seed: 1000 + rep, cacheState: 'off' },
        { server, profileDir: newProfile('e1'), uaMemory: ua, cfg: { ...c.cfg, workload: W.w100, discard: 5, cache: false, uaCheck: ua } });
      if (status === 'stop') break outer;
    }
  }
  server.close();
}

if (block === 'f28') {
  const server = await startServer({}); const { dir: master, info } = await primedMaster('f28', ['int8', 'fp32'], server);
  const cells = []; for (const state of ['a', 'b', 'c', 'd', 'e']) for (const chunk of ALL4) for (const precision of ['int8', 'fp32']) cells.push({ state, chunk, precision });
  outer: for (let rep = 0; rep < (SMOKE ? 1 : 10); rep++) {
    for (const [k, c] of shuffle(lim(cells), 2000 + rep).entries()) {
      const key = `f28|${c.state}|${c.chunk}|${c.precision}|rep${rep}`;
      if (J.done.has(key)) continue; if (outOfTime()) { status = 'stop'; break outer; }
      const copyDir = copyProfile(master, 'f28'); const { ctx, page, errors } = await openRunner(copyDir, server.base);
      try { const cacheBefore = await page.evaluate(() => window.p7.cacheState()); const r = await page.evaluate(a => window.p7.creation(a), c);
        J.append({ key, block, exp: 'E-F28', configId: 'CLOUD-HL-1T', ...c, rep, orderIndex: k, cacheState: 'warm (primed copy)', masterEntries: info.entries,
                   cacheBefore: { entries: cacheBefore.entries, bytes: cacheBefore.bytes }, ...r, errors, date: new Date().toISOString() });
        console.log(key, 'create', r.createMs.toFixed(0), 'total', r.totalMs.toFixed(0), r.source);
      } catch (e) { J.append({ key, block, failed: true, error: String(e) }); console.log('FAILED', key, String(e)); }
      finally { await ctx.close(); dropProfile(copyDir); }
    }
  }
  server.close();
}

if (block === 'eng') {
  const server = await startServer({}); const { dir: master, info } = await primedMaster('eng', ['int8', 'fp32'], server);
  // (1) ONE calibration, measured once in a warm copy, saved; every decision and prediction uses it (D-7.4)
  const calFile = path.join(OUT, 'calibration_cloud.json');
  if (!fs.existsSync(calFile)) { const { ctx, page } = await openRunner(copyProfile(master, 'engcal'), server.base);
    fs.writeFileSync(calFile, JSON.stringify(await page.evaluate(() => window.p7.calibrate()), null, 1)); await ctx.close(); }
  for (const d of fs.readdirSync('/tmp')) if (/^eng(cal|w|c)-/.test(d)) dropProfile(path.join('/tmp', d));
  const calibration = JSON.parse(fs.readFileSync(calFile));
  // (2) decisions: 3 profiles × early exit × {cold, warm}; plus decision-only under a 20 Mbit/s link (cache-term check)
  const decFile = path.join(OUT, 'decisions.json');
  if (!fs.existsSync(decFile)) {
    const decisions = [];
    for (const cache of ['cold', 'warm']) {
      const { ctx, page } = await openRunner(cache === 'warm' ? copyProfile(master, 'engw') : newProfile('engc'), server.base);
      const state = await page.evaluate(() => window.p7.cacheState());
      for (const link of [null, { downlinkMbps: 20, rttMs: 40 }]) for (const profile of ['low', 'mid', 'high']) for (const earlyExit of [false, true]) {
        const d = await page.evaluate(a => window.p7.decide(a), { profile, overrides: { sentencesPerRequest: 20, earlyExit, ...(link ?? {}) }, calibration });
        const npin = t => typeof t.pinned === 'number' ? t.pinned : t.pinned.length;
        const fam = t => `${t.precision}|${npin(t) === 4 ? 'resident' : npin(t) ? 'hybrid' : 'sequential'}|ee=${+t.earlyExit}`;
        const feas = d.trace.filter(t => t.status !== 'rejected').sort((a, b) => a.rank - b.rank);
        const bestPerFamily = Object.values(feas.reduce((a, t) => (a[fam(t)] ??= t, a), {}));
        decisions.push({ cache, cacheEntries: state.entries, link: link ? '20 Mbit/s, first-byte 20 ms (decision only)' : 'localhost', profile, earlyExit,
          chosen: d.plan?.id ?? null, chosenPlan: d.plan, budget: d.budget, predicted: d.predicted, nFeasible: feas.length,
          top: feas.slice(0, 5).map(t => ({ id: t.id, rank: t.rank, cost: t.cost })),
          margin: feas.length > 1 ? (feas[1].cost - feas[0].cost) / feas[0].cost : null,
          measure: link ? [] : [...new Set([d.plan?.id, ...feas.slice(0, 5).map(t => t.id), ...bestPerFamily.map(t => t.id)].filter(Boolean))],
          planById: Object.fromEntries(feas.map(t => [t.id, { precision: t.precision, prewarm: t.prewarm, groupSize: t.groupSize, earlyExit: t.earlyExit, pinnedCount: npin(t) }])) });
      }
      await ctx.close();
    }
    fs.writeFileSync(decFile, JSON.stringify(decisions, null, 1));
  }
  const decisions = JSON.parse(fs.readFileSync(decFile));
  // plan objects: the chosen plans carry full pin lists; the others are rebuilt from the candidate generator via their id
  const { generateCandidates, planId } = await import('../../packages/adaptive-onnx-loader/src/engine/planner.js');
  const byId = Object.fromEntries([...generateCandidates({ earlyExit: false }), ...generateCandidates({ earlyExit: true })].map(p => [planId(p), p]));
  const ids = lim([...new Set(decisions.flatMap(d => d.measure))]);
  const missing = ids.filter(i => !byId[i]); if (missing.length) throw new Error('plan ids not reproducible: ' + missing.join(', '));
  outer: for (let rep = 0; rep < REPS; rep++) for (const cache of ['warm', 'cold']) {
    for (const [k, id] of shuffle(ids, 3000 + rep * 2 + (cache === 'cold')).entries()) {
      const key = `eng|${id}|${cache}|rep${rep}`; if (J.done.has(key)) continue; if (outOfTime()) { status = 'stop'; break outer; }
      const plan = byId[id]; const dir = cache === 'warm' ? copyProfile(master, 'engw') : newProfile('engc');
      const { ctx, page } = await openRunner(dir, server.base);
      const pred = await page.evaluate(a => window.p7.predict(a), { plan, n: 20, calibration }); await ctx.close();   // prediction under THIS run's cache state
      const ua = rep === 0 && cache === 'warm' && plan.pinned.length > 0;   // spot check only where Workers stay alive (sequential: nothing to measure; the call then waits ~60 s)
      status = await runRow(key, { exp: 'E-ENG', configId: 'CLOUD-HL-1T', precision: plan.precision, rep, orderIndex: k, cacheState: cache, masterEntries: cache === 'warm' ? info.entries : 0, prediction: pred },
        { server, profileDir: dir, uaMemory: ua, cfg: { policy: 'plan', precision: plan.precision, plan, workload: W.pilot20, requestMode: 'batch', cache: true, ttfi: false, uaCheck: ua } });
      if (status === 'stop') break outer;
    }
  }
  server.close();
}

if (block === 'e3bytes') {
  const server = await startServer({}); const selFile = path.join(OUT, 'selection.json');
  if (!fs.existsSync(selFile)) {         // 10 sentences per exit class, evenly spaced through that class (per precision's early-exit reference)
    const sel = {};
    for (const precision of PREC) { const ref = JSON.parse(fs.readFileSync(path.join(ROOT, `data/sst2/wasm_ee_${precision}.json`)));
      sel[precision] = Object.fromEntries(['e1', 'e2', 'full'].map(c => { const ix = ref.map((r, i) => r.exitAt === c ? i : -1).filter(i => i >= 0);
        return [c, [...Array(10).keys()].map(k => ix[Math.floor((k + 0.5) * ix.length / 10)])]; })); }
    fs.writeFileSync(selFile, JSON.stringify(sel, null, 1));
  }
  const sel = JSON.parse(fs.readFileSync(selFile)); const cells = [];
  for (const precision of PREC) for (const cls of ['e1', 'e2', 'full']) for (const idx of sel[precision][cls])
    for (const [cond, ee, pw] of [['ee0', false, false], ['ee1', true, false], ['ee1pw', true, true]]) cells.push({ precision, cls, idx, cond, ee, pw });
  for (const [k, c] of shuffle(lim(cells), 4000).entries()) {
    status = await runRow(`e3bytes|${c.precision}|${c.cls}|s${c.idx}|${c.cond}`, { exp: 'E3-BYTES', configId: 'CLOUD-HL-1T', precision: c.precision, expectExit: c.cls, sentence: c.idx, condition: c.cond, rep: 0, orderIndex: k, cacheState: 'cold' },
      { server, profileDir: newProfile('e3b'), cfg: { policy: 'plan', precision: c.precision, plan: { pinned: [], groupSize: 1, prewarm: c.pw, earlyExit: c.ee }, workload: [c.idx], requestMode: 'batch', cache: true, ttfi: false } });
    if (status === 'stop') break;
  }
  server.close();
}

if (block === 'netcheck') {
  const file = '/models/onnx/int8/c1_l0_1.onnx';
  for (const mbps of [50, 20, 10, 5]) {
    const key = `netcheck|${mbps}`; if (J.done.has(key)) continue;
    const server = await startServer({ mbps, rttMs: 40 }); const { ctx, page } = await openRunner(newProfile('nc'), server.base);
    const m = await page.evaluate(async u => { const t0 = performance.now(); const r = await fetch(u, { cache: 'no-store' }); const t1 = performance.now(); const b = await r.arrayBuffer(); return { bytes: b.byteLength, ttfbMs: t1 - t0, bodyMs: performance.now() - t1 }; }, file);
    await ctx.close(); server.close();
    const measured = m.bytes * 8 / 1e6 / (m.bodyMs / 1000), err = 100 * (measured - mbps) / mbps;
    J.append({ key, block, mbps, ...m, measuredMbps: measured, errorPct: err, within5pct: Math.abs(err) <= 5, date: new Date().toISOString() });
    console.log(key, measured.toFixed(3), err.toFixed(2) + '%', 'ttfb', m.ttfbMs.toFixed(1));
  }
}

if (block === 'net' || block === 'e5x') {
  // one server per link, kept for the whole block, so a profile's revisits hit the SAME origin
  const links = block === 'net' ? [0, 20, 5] : [50, 10];
  const servers = Object.fromEntries(await Promise.all(links.map(async l => [l, await startServer(l ? { mbps: l, rttMs: 40 } : {})])));
  const cells = [];
  for (const link of links) for (const precision of PREC) {
    if (precision === 'fp32' && link === 5) continue;                       // omitted by your decision 4 (documented)
    for (const prewarm of block === 'net' ? [false, true] : [false]) cells.push({ link, precision, prewarm });
  }
  outer: for (let rep = 0; rep < REPS; rep++) {
    for (const [k, c] of shuffle(lim(cells), (block === 'net' ? 5000 : 6000) + rep).entries()) {
      const server = servers[c.link], name = `${c.link || 'inf'}|${c.precision}|pw${+c.prewarm}`;
      const dirFile = path.join(OUT, `profile_${name.replace(/\|/g, '_')}_rep${rep}.txt`);
      const dir = fs.existsSync(dirFile) ? fs.readFileSync(dirFile, 'utf8') : (() => { const d = newProfile('net'); fs.writeFileSync(dirFile, d); return d; })();
      const plan = { pinned: [], groupSize: 32, prewarm: c.prewarm, earlyExit: false };
      const meta = { configId: CONFIG_ID[c.link], link: c.link || 'unthrottled', precision: c.precision, prewarm: c.prewarm, rep, orderIndex: k };
      // visit 0 = cold. 'net': TTFI + w100 workload (E2; for pre-start OFF it is also E5's cold visit). 'e5x': TTFI only.
      status = await runRow(`${block}|${name}|rep${rep}|v0`, { exp: block === 'net' ? (c.prewarm ? 'E2' : 'E2+E5') : 'E5', visit: 0, cacheState: 'cold', ...meta },
        { server, profileDir: dir, keepProfile: !c.prewarm, cfg: { policy: 'plan', precision: c.precision, plan, workload: block === 'net' ? W.w100 : [W.w100[0]], requestMode: 'batch', cache: true, firstRequestOnly: block !== 'net' } });
      if (status === 'stop') break outer;
      if (c.prewarm) continue;
      for (let v = 1; v <= 3; v++) {                                         // E5 revisits: same profile, new process, TTFI request only
        status = await runRow(`${block}|${name}|rep${rep}|v${v}`, { exp: 'E5', visit: v, cacheState: 'warm (revisit)', ...meta },
          { server, profileDir: dir, keepProfile: v < 3, cfg: { policy: 'plan', precision: c.precision, plan, workload: [W.w100[0]], requestMode: 'batch', cache: true, firstRequestOnly: true } });
        if (status === 'stop') break outer;
      }
    }
  }
  for (const s of Object.values(servers)) s.close();
}

if (block === 'g1') {
  const server = await startServer({}); const { dir: master, info: g1info } = await primedMaster('g1', ['int8'], server);
  for (const prewarm of [false, true])
    status = await runRow(`g1|int8|pw${+prewarm}`, { exp: 'E2-G1 (indicative, n = 1)', configId: 'CLOUD-HL-1T', precision: 'int8', prewarm, rep: 0, cacheState: 'warm (primed copy)', masterEntries: g1info.entries },
      { server, profileDir: copyProfile(master, 'g1'), cfg: { policy: 'plan', precision: 'int8', plan: { pinned: [], groupSize: 1, prewarm, earlyExit: false }, workload: W.pilot20, requestMode: 'batch', cache: true, ttfi: false } });
  server.close();
}

if (block === 'ebrowser') {
  const server = await startServer({});
  for (const batch of SMOKE ? [32] : [1, 32]) {
    const key = `ebrowser|int8|b${batch}`; if (J.done.has(key)) continue;
    const pdir = newProfile('ebb'); const { ctx, page, errors } = await openRunner(pdir, server.base);
    const r = await page.evaluate(a => window.p7.batchedChain(a), { precision: 'int8', batch }); await ctx.close(); dropProfile(pdir);
    J.append({ key, block, exp: 'E-B browser', configId: 'CLOUD-HL-1T', ...r, errors, date: new Date().toISOString() }); console.log(key, r.accuracy, r.logitsHash.slice(0, 16), (r.ms / 1000).toFixed(1) + 's');
  }
  server.close();
}

const rows = fs.existsSync(path.join(OUT, 'runs.jsonl')) ? fs.readFileSync(path.join(OUT, 'runs.jsonl'), 'utf8').trim().split('\n').filter(Boolean).length : 0;
console.log(`[${block}${SMOKE ? ' smoke' : ''}] ${status === 'stop' ? 'TIME BUDGET REACHED — run again to resume' : 'done'}; rows in file: ${rows}; elapsed ${((Date.now() - T0) / 1000).toFixed(0)} s`);
