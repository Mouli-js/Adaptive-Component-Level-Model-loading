/**
 * Phase 7 Mac driver (MAC-CHROME-*). A queue of steps runs ONE step per page load: the page reloads before every
 * run, so each run starts with a fresh page heap (the closest a single tab gets to the cloud's one-process-per-run).
 * State and results live in IndexedDB 'p7mac' (separate from the chunk cache), so a crash or closed tab resumes.
 * An interrupted step is recorded as failed and retried once as a new row (retryOf), as in the cloud harness.
 * Measurement code is the same runner as the cloud (bench/phase7/runner.js, window.p7).
 * ?quick=1 (self-test only): 1 repetition, 20 sentences, threads 1 and 2, fewer plans. Never used for results.
 */
import { generateCandidates, planId } from 'adaptive-onnx-loader';
while (!window.p7?.ready) await new Promise(r => setTimeout(r, 50));
const p7 = window.p7, $ = id => document.getElementById(id);
$('origin').textContent = location.origin;
const W = await (await fetch('/results/phase7/workload_100.json')).json();
const ALL4 = ['c0_embed', 'c1_l0_1', 'c2_l2_3', 'c3_l4_5_cls'];

// ---------- tiny IndexedDB key-value + row store ----------
const db = await new Promise((res, rej) => { const o = indexedDB.open('p7mac', 1);
  o.onupgradeneeded = () => { o.result.createObjectStore('kv'); o.result.createObjectStore('rows', { autoIncrement: true }); }; o.onsuccess = () => res(o.result); o.onerror = () => rej(o.error); });
const tx = (store, mode, fn) => new Promise((res, rej) => { const t = db.transaction(store, mode); const r = fn(t.objectStore(store)); t.oncomplete = () => res(r?.result); t.onerror = () => rej(t.error); });
const kvGet = k => new Promise(res => { const r = db.transaction('kv').objectStore('kv').get(k); r.onsuccess = () => res(r.result); });
const kvSet = (k, v) => tx('kv', 'readwrite', s => s.put(v, k));
const addRow = row => tx('rows', 'readwrite', s => s.add(row));
const allRows = () => new Promise(res => { const r = db.transaction('rows').objectStore('rows').getAll(); r.onsuccess = () => res(r.result); });

// ---------- seeded shuffle (same generator as the cloud harness) ----------
function shuffle(a, seed) { let t = seed >>> 0; const rnd = () => { t += 0x6D2B79F5; let r = Math.imul(t ^ t >>> 15, 1 | t); r ^= r + Math.imul(r ^ r >>> 7, 61 | r); return ((r ^ r >>> 14) >>> 0) / 4294967296; };
  const b = [...a]; for (let i = b.length - 1; i > 0; i--) { const j = Math.floor(rnd() * (i + 1)); [b[i], b[j]] = [b[j], b[i]]; } return b; }

// ---------- the step queue ----------
// ?only=MAC-2,MAC-3,MAC-4 (re-run 1 Nov): build the full queue, keep only the listed blocks
const ONLY = (new URLSearchParams(location.search).get('only') || '').split(',').map(x => x.trim()).filter(Boolean);
function buildQueue(quick, only = []) { const Q = buildFullQueue(quick); return only.length ? Q.filter(s => only.includes(s.block)) : Q; }
function buildFullQueue(quick) {
  const REPS = quick ? 1 : 5, WL = quick ? W.pilot20 : W.w100, Q = [];
  // MAC-1: F-13 thread sweep — baseline int8 / fp32 at 1/2/4/8 page threads (configuration MAC-CHROME-T<n>), cache n/a (localhost)
  const t1 = []; for (const threads of quick ? [1, 2] : [1, 2, 4, 8]) for (const precision of ['int8', 'fp32']) t1.push({ threads, precision });
  for (let rep = 0; rep < REPS; rep++) for (const [k, c] of shuffle(t1, 7000 + rep).entries())
    Q.push({ block: 'MAC-1', key: `mac1|t${c.threads}|${c.precision}|rep${rep}`, configId: `MAC-CHROME-T${c.threads}`, threads: c.threads, rep, orderIndex: k, cacheState: 'n/a (localhost, no IndexedDB tier)',
      kind: 'run', cfg: { policy: 'baseline', precision: c.precision, workload: WL, requestMode: 'single', discard: 5, cache: false } });
  for (const c of t1) Q.push({ block: 'MAC-1', key: `mac1|t${c.threads}|${c.precision}|acc`, configId: `MAC-CHROME-T${c.threads}`, threads: c.threads, rep: 0, cacheState: 'n/a',
      kind: 'run', cfg: { policy: 'baseline', precision: c.precision, workload: [WL[0]], requestMode: 'single', discard: 0, cache: false, accuracy: !quick } });
  // MAC-3: E1/E3 subset — int8, mixedC2 × resident / sequential G 32 × early exit off/on, cache OFF (D-7.1), 1 thread per Worker
  const m3 = []; for (const precision of ['int8', 'mixedC2']) for (const [pol, plan, mode] of [['resident', { pinned: ALL4, groupSize: 1 }, 'single'], ['sequential', { pinned: [], groupSize: 32 }, 'batch']])
    for (const ee of [false, true]) m3.push({ precision, pol, plan: { ...plan, prewarm: false, earlyExit: ee }, mode, ee });
  for (let rep = 0; rep < REPS; rep++) for (const [k, c] of shuffle(quick ? m3.slice(0, 2) : m3, 7100 + rep).entries())
    Q.push({ block: 'MAC-3', key: `mac3|${c.pol}|${c.precision}|ee${+c.ee}|rep${rep}`, configId: 'MAC-CHROME-W1', threads: 1, rep, orderIndex: k, cacheState: 'off',
      kind: 'run', cfg: { policy: 'plan', precision: c.precision, plan: c.plan, workload: WL, requestMode: c.mode, discard: 5, cache: false } });
  // MAC-4: E-F28 states (a) no other Worker, (b) another chunk Worker alive — c1 int8, warm cache, one page per creation
  for (let rep = 0; rep < REPS; rep++) for (const state of shuffle(['a', 'b'], 7200 + rep))
    Q.push({ block: 'MAC-4', key: `mac4|${state}|rep${rep}`, configId: 'MAC-CHROME-W1', threads: 1, rep, cacheState: 'warm (primed)', kind: 'creation', state });
  // MAC-2: decision engine (I-5.3). One fixed calibration measured on this Mac (warm), decisions cold + warm,
  //        then chosen + 3 next-ranked plans per decision × 5 × {warm, cold}; expanded once the decisions exist.
  Q.push({ block: 'MAC-2', key: 'mac2|prime', kind: 'prime' });
  Q.push({ block: 'MAC-2', key: 'mac2|calibrate', kind: 'calibrate' });
  Q.push({ block: 'MAC-2', key: 'mac2|decide-warm', kind: 'decide', cache: 'warm' });
  Q.push({ block: 'MAC-2', key: 'mac2|decide-cold', kind: 'decide', cache: 'cold' });
  Q.push({ block: 'MAC-2', key: 'mac2|expand', kind: 'expand', reps: REPS, quick });
  return Q;
}

const PRIME = async () => { for (const precision of ['int8', 'fp32'])   // sentence 3 takes the full path: all chunks + both heads → 10 entries
  await p7.run({ policy: 'plan', precision, plan: { pinned: [], groupSize: 1, prewarm: false, earlyExit: true }, workload: [3], requestMode: 'batch', cache: true, ttfi: false });
  return p7.cacheState(); };
async function ensureCache(state) {          // makes the cache state exactly what the step requires, and reports what was done
  const before = await p7.cacheState();
  if (state === 'cold') { await p7.clearCache(); return { action: before.entries ? 'cleared' : 'already empty', entriesBefore: before.entries, after: (await p7.cacheState()).entries }; }
  if (before.entries === 10) return { action: 'already primed', entriesBefore: 10, after: 10 };
  await p7.clearCache(); const a = await PRIME(); return { action: 're-primed', entriesBefore: before.entries, after: a.entries };
}

async function execute(step, state) {
  const base = { key: step.key, block: step.block, configId: step.configId ?? 'MAC-CHROME-W1', rep: step.rep ?? null, orderIndex: step.orderIndex ?? null,
                 threads: step.threads ?? 1, cacheState: step.cacheState ?? step.cache ?? null, date: new Date().toISOString(), origin: location.origin };
  if (step.kind === 'run') {
    const cacheBefore = await p7.cacheState(); const t = performance.now(); const r = await p7.run(step.cfg); const cacheAfter = await p7.cacheState();
    const { trace, timeline, ...rest } = r;
    return { ...base, ...rest, trace, timeline, cacheBefore: { entries: cacheBefore.entries }, cacheAfter: { entries: cacheAfter.entries }, wallS: (performance.now() - t) / 1000 };
  }
  if (step.kind === 'creation') { const prep = await ensureCache('warm'); const cacheBefore = await p7.cacheState();
    return { ...base, cachePrep: prep, cacheBefore: { entries: cacheBefore.entries }, ...(await p7.creation({ chunk: 'c1_l0_1', precision: 'int8', state: step.state })) }; }
  if (step.kind === 'prime') { const prep = await ensureCache('warm'); return { ...base, cachePrep: prep }; }
  if (step.kind === 'calibrate') { await ensureCache('warm'); const calibration = await p7.calibrate(); await kvSet('calibration', calibration); return { ...base, calibration }; }
  if (step.kind === 'decide') {
    const prep = await ensureCache(step.cache), calibration = await kvGet('calibration'), out = [];
    for (const profile of ['low', 'mid', 'high']) for (const earlyExit of [false, true]) {
      const d = await p7.decide({ profile, overrides: { sentencesPerRequest: 20, earlyExit }, calibration });
      const feas = d.trace.filter(t => t.status !== 'rejected').sort((a, b) => a.rank - b.rank);
      out.push({ profile, earlyExit, chosen: d.plan?.id ?? null, top: feas.slice(0, 4).map(t => ({ id: t.id, rank: t.rank, cost: t.cost })),
                 margin: feas.length > 1 ? (feas[1].cost - feas[0].cost) / feas[0].cost : null, budget: d.budget, signals: d.signals });
    }
    const all = (await kvGet('decisions')) ?? {}; all[step.cache] = out; await kvSet('decisions', all);
    return { ...base, cachePrep: prep, decisions: out };
  }
  if (step.kind === 'expand') {                  // MAC-2 measurement steps, now that the decisions are known
    const dec = await kvGet('decisions'); const ids = [...new Set(Object.values(dec).flat().flatMap(d => d.top.map(t => t.id)))];
    const use = step.quick ? ids.slice(0, 2) : ids, add = [];
    for (let rep = 0; rep < step.reps; rep++) for (const cache of ['warm', 'cold']) for (const [k, id] of shuffle(use, 7300 + rep * 2 + (cache === 'cold')).entries())
      add.push({ block: 'MAC-2', key: `mac2|${id}|${cache}|rep${rep}`, configId: 'MAC-CHROME-W1', rep, orderIndex: k, cache, kind: 'engrun', planIdStr: id });
    state.queue.push(...add); return { ...base, measuredPlans: use, steps: add.length };
  }
  if (step.kind === 'engrun') {
    const byId = Object.fromEntries([...generateCandidates({ earlyExit: false }), ...generateCandidates({ earlyExit: true })].map(p => [planId(p), p]));
    const plan = byId[step.planIdStr]; if (!plan) throw new Error('unknown plan ' + step.planIdStr);
    const prep = await ensureCache(step.cache), cacheBefore = await p7.cacheState(), calibration = await kvGet('calibration');
    const prediction = await p7.predict({ plan, n: 20, calibration });
    const r = await p7.run({ policy: 'plan', precision: plan.precision, plan, workload: W.pilot20, requestMode: 'batch', cache: true, ttfi: false });
    const { trace, timeline, ...rest } = r;
    return { ...base, cacheState: step.cache, cachePrep: prep, cacheBefore: { entries: cacheBefore.entries }, prediction, ...rest, trace, timeline };
  }
  throw new Error('unknown step ' + step.kind);
}

// ---------- page-load loop: run the current step, store it, advance, reload ----------
const show = async state => {
  const n = state?.queue.length ?? 0, i = state?.i ?? 0;
  $('bar').max = Math.max(1, n); $('bar').value = i;
  $('status').textContent = !state ? 'Not started.' : i >= n ? `Finished: ${i} steps. Download the results.` : state.paused ? `Paused at step ${i + 1} of ${n}.` : `Running step ${i + 1} of ${n} (${state.queue[i].block})…`;
  $('status').className = state && i >= n ? 'ok' : '';
  const rows = await allRows(); const fails = rows.filter(r => r.failed).length;
  $('detail').textContent = state ? `${rows.length} rows stored · ${fails} failed attempts · ${rows.filter(r => r.anomaly).length} hidden-page rows (repeated) · started ${state.startedAt}${state.only?.length ? ' · only ' + state.only.join(', ') : ''}${state.quick ? ' · QUICK SELF-TEST (not results)' : ''}` : '';
  $('log').textContent = rows.slice(-6).map(r => `${r.key}${r.failed ? '  FAILED ' + r.error.slice(0, 80) : `  ${r.ttfiMs != null ? 'ttfi ' + Math.round(r.ttfiMs) : ''} ${r.workloadMs != null ? 'wl ' + Math.round(r.workloadMs) : ''} ${r.refCheck ? 'ref ' + r.refCheck.pass : ''}`}`).join('\n') || '—';
};
const urlFor = step => { const u = new URL(location.href); const q = new URLSearchParams(location.search);
  u.search = `?threads=${step?.threads ?? 1}${q.get('quick') ? '&quick=1' : ''}${q.get('only') ? '&only=' + q.get('only') : ''}`; return u.href; };

// ---------- foreground guard (re-run 1 Nov) ----------
// A step only STARTS while the page is visible. While it runs, every visibility change is recorded. A step that was
// hidden at any moment is stored as an ANOMALOUS row (kept, never deleted) and run again as a new row (retryOf).
const vis = { events: [], hiddenSince: null, hiddenMs: 0 };
document.addEventListener('visibilitychange', () => { const now = performance.now();
  vis.events.push({ t: Math.round(now), state: document.visibilityState });
  if (document.visibilityState === 'hidden') vis.hiddenSince = now; else if (vis.hiddenSince != null) { vis.hiddenMs += now - vis.hiddenSince; vis.hiddenSince = null; } });
const visRecord = start => ({ atStart: start.state, focusAtStart: start.focus, atEnd: document.visibilityState, focusAtEnd: document.hasFocus(), changes: vis.events.length,
  hiddenMs: Math.round(vis.hiddenMs + (vis.hiddenSince != null ? performance.now() - vis.hiddenSince : 0)), events: vis.events.slice(0, 20) });

let state = await kvGet('state');
await show(state);
if (state && !state.paused && state.i < state.queue.length) {
  const step = state.queue[state.i];
  if ((step.threads ?? 1) !== p7.env().pageThreads) location.replace(urlFor(step));          // wrong thread count for this step: reload with the right one
  else {
    if (state.inProgress === state.i) {                                                     // the previous load died during this step
      await addRow({ key: step.key, block: step.block, failed: true, error: 'interrupted (page reload/crash during the step)', date: new Date().toISOString() });
      step.tries = (step.tries ?? 0) + 1;
    }
    if (document.visibilityState !== 'visible') {                                            // guard: never START a step while hidden
      $('status').textContent = `Paused: the page is hidden. Bring this tab to the front to continue (step ${state.i + 1} of ${state.queue.length}).`; $('status').className = 'bad';
      state.guardPauses = (state.guardPauses ?? 0) + 1; await kvSet('state', state);
      document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') location.reload(); });
    }
    else if ((step.tries ?? 0) >= 2 || (step.hiddenTries ?? 0) >= 3) { state.i++; state.inProgress = null; await kvSet('state', state); location.replace(urlFor(state.queue[state.i])); }
    else {
      state.inProgress = state.i; await kvSet('state', state);
      const start = { state: document.visibilityState, focus: document.hasFocus() };
      let hiddenRetry = false;
      try { const row = await execute(step, state); if (step.tries || step.hiddenTries) row.retryOf = (step.tries ?? 0) + (step.hiddenTries ?? 0);
            row.visibility = visRecord(start);
            if (row.visibility.atStart !== 'visible' || row.visibility.atEnd !== 'visible' || row.visibility.changes > 0) {
              row.anomaly = 'page hidden during the run (kept; the step is repeated as a new row)'; step.hiddenTries = (step.hiddenTries ?? 0) + 1; hiddenRetry = true; }
            await addRow(row); }
      catch (e) { await addRow({ key: step.key, block: step.block, failed: true, error: String(e?.stack ?? e).slice(0, 2000), date: new Date().toISOString() });
                  step.tries = (step.tries ?? 0) + 1; if (step.tries < 2) { state.inProgress = null; await kvSet('state', state); location.replace(urlFor(step)); throw e; } }
      if (hiddenRetry) { state.inProgress = null; await kvSet('state', state); setTimeout(() => location.replace(urlFor(step)), 300); }
      else { state.i++; state.inProgress = null; await kvSet('state', state); }
      await show(state);
      if (!hiddenRetry && state.i < state.queue.length && !state.paused) setTimeout(() => location.replace(urlFor(state.queue[state.i])), 300);
    }
  }
}

$('start').onclick = async () => {
  const cur = await kvGet('state'); if (cur && cur.i < cur.queue.length) { $('status').textContent = 'A run is already stored: use Resume, or Reset first.'; return; }
  if (cur) {   // a FINISHED earlier run is ARCHIVED (kept in this browser), never deleted, before a new run starts
    await kvSet(`archive:${cur.startedAt}`, { state: cur, rows: await allRows(), calibration: await kvGet('calibration'), decisions: await kvGet('decisions') });
    const list = (await kvGet('archives')) ?? []; list.push(cur.startedAt); await kvSet('archives', list);
    await tx('rows', 'readwrite', x => x.clear()); await kvSet('decisions', null); await kvSet('calibration', null);
  }
  const quick = !!new URLSearchParams(location.search).get('quick');
  const s = { queue: buildQueue(quick, ONLY), i: 0, startedAt: new Date().toISOString(), quick, only: ONLY, env: p7.env(), paused: false };
  await kvSet('state', s); location.replace(urlFor(s.queue[0]));
};
$('pause').onclick = async () => { const s = await kvGet('state'); if (s) { s.paused = true; await kvSet('state', s); await show(s); } };
$('resume').onclick = async () => { const s = await kvGet('state'); if (s) { s.paused = false; await kvSet('state', s); location.replace(urlFor(s.queue[s.i])); } };
let armed = false;
$('reset').onclick = async () => { if (!armed) { armed = true; $('reset').textContent = 'Click again to delete stored results'; return; }
  await kvSet('state', null); await tx('rows', 'readwrite', s => s.clear()); await kvSet('decisions', null); await kvSet('calibration', null); armed = false; $('reset').textContent = 'Reset (click twice)'; await show(null); };
$('download').onclick = async () => {
  const s = await kvGet('state'), rows = await allRows();
  const out = { kind: 'phase7-mac', quickSelfTest: !!s?.quick, startedAt: s?.startedAt, downloadedAt: new Date().toISOString(), env: { ...p7.env(), ...(s?.env ?? {}) },
                configs: { 'MAC-CHROME-T<n>': 'baseline, page ORT threads n (MAC-1)', 'MAC-CHROME-W1': '1 thread per chunk Worker (MAC-2/3/4)' },
                only: s?.only ?? [], guardPauses: s?.guardPauses ?? 0, archivedEarlierRuns: (await kvGet('archives')) ?? [],
                steps: s?.queue.length ?? 0, completed: s?.i ?? 0, calibration: await kvGet('calibration'), decisions: await kvGet('decisions'), rows };
  const a = document.createElement('a'); a.href = URL.createObjectURL(new Blob([JSON.stringify(out)], { type: 'application/json' }));
  a.download = `phase7_mac_${(s?.startedAt ?? 'none').replace(/[:.]/g, '-')}${s?.only?.length ? '_only-' + s.only.join('-') : ''}${s?.quick ? '_QUICK' : ''}.json`; a.click();
};
window.p7mac = { kvGet, allRows };                // for the automated self-test only
