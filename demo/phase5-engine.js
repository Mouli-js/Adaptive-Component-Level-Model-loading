import { installWasmMemoryProbe, WordPieceTokenizer, loadManifest, ChunkStore, readSignals, decide, calibrate,
         PlanRunner, DEFAULT_CALIBRATION, predictMemory, predictTime, chunkInfo, applyProfile, planId } from 'adaptive-onnx-loader';
installWasmMemoryProbe();
const U = p => new URL(p, location.href).href;
const workerOpts = { workerUrl: U('/packages/adaptive-onnx-loader/src/workers/chunkWorker.js'), ortUrl: U('/node_modules/onnxruntime-web/dist/ort.wasm.min.mjs'),
                     wasmPaths: U('/node_modules/onnxruntime-web/dist/'), numThreads: 1, cache: { dbName: 'adaptive-onnx-loader', verifyOnRead: true } };
const $ = id => document.getElementById(id);
const getJSON = async u => (await fetch(u)).json();
$('coi').textContent = crossOriginIsolated ? 'yes' : 'NO'; $('coi').className = crossOriginIsolated ? 'ok' : 'bad';
const manifest = await loadManifest('/models/onnx/manifest.json');
const tokenizer = WordPieceTokenizer.fromVocabText(await (await fetch('/models/onnx/vocab.txt')).text(), { maxLength: manifest.max_length });
const rows = await getJSON('/data/sst2/validation.json');
const eeTable = await getJSON('/results/phase5/early_exit_wasm.json');
const tau = (await getJSON('/models/heads/early_exit_policy.json')).chosen.tau;
const refs = {};
const ref = async (plan) => { const k = plan.earlyExit ? `wasm_ee_${plan.precision}` : `wasm_chain_${plan.precision}_logits`;
  return refs[k] ??= await getJSON(`/data/sst2/${k}.json`); };
let calibration = null;

async function signalsNow() { const s = await ChunkStore.open({ dbName: 'adaptive-onnx-loader' }); try { return await readSignals({ store: s }); } finally { s.close(); } }
async function getCalibration() {
  // length-representative sample: every 54th validation sentence (16 sentences spread over the set)
  if (!calibration) calibration = await calibrate({ manifest, workerOpts, tokenizer, sentences: rows.filter((_, i) => i % 54 === 0).map(r => r.sentence) });
  return calibration;
}

/** Step 1–7 of the engine, with the profile. */
async function decidePlan({ profile = 'mid', overrides = {}, useCalibration = true } = {}) {
  const signals = await signalsNow();
  const cal = useCalibration ? await getCalibration() : DEFAULT_CALIBRATION;
  return decide({ manifest, signals, profile: profile || null, overrides, calibration: cal, earlyExitTable: eeTable });
}

/** Execute a plan; compare outputs with the per-plan reference; compare predictions (under the REAL
 *  conditions of this machine, not the simulated profile) with what was measured. */
async function runPlan(plan, { n = 8, start = 0, warmFirst = true, onProgress } = {}) {
  const texts = rows.slice(start, start + n).map(r => r.sentence);
  if (warmFirst) { const w = new PlanRunner(manifest, plan, { workerOpts, earlyExitTau: tau }); await w.classifyMany(tokenizer, texts.slice(0, 1)); w.release(); }
  const r = new PlanRunner(manifest, plan, { workerOpts, earlyExitTau: tau });
  const out = await r.classifyMany(tokenizer, texts, { onProgress });
  const peak = r.peakLiveHeapBytes; r.release();
  const R = await ref(plan);
  let maxDiff = 0, exitMismatch = 0, correct = 0;
  out.results.forEach((x, k) => {
    const i = start + k, rl = plan.earlyExit ? R[i].logits : R[i];
    maxDiff = Math.max(maxDiff, Math.abs(x.logits[0] - rl[0]), Math.abs(x.logits[1] - rl[1]));
    if (plan.earlyExit && x.exitAt !== R[i].exitAt) exitMismatch++;
    correct += (x.logits[1] > x.logits[0]) === (rows[i].label === 1);
  });
  // prediction under actual conditions: localhost link, chunks now cached, calibrated timings
  const signals = await signalsNow();
  const ctx = applyProfile(signals, null, { downlinkMbps: 1000, rttMs: 1, sentencesPerRequest: n, earlyExit: plan.earlyExit });
  const chunks = chunkInfo(manifest, plan), cal = await getCalibration();
  const pm = predictMemory(plan, chunks, ctx);
  const pt = predictTime(plan, chunks, ctx, cal, { exitStats: eeTable[plan.precision], diskFits: true });
  const resident = plan.pinned.length === 4;
  const predictedTotalMs = (resident ? pt.initialLoadMs : 0) + n * pt.perSentenceMs;
  const predictedWasmNoMargin = pm.workerWasmMiB / ctx.heapUncertainty;
  const measuredWasmMiB = peak / 1048576;
  return { plan: plan.id, n, maxAbsDiffVsRef: maxDiff, exitMismatch, accuracyOnSample: correct / n,
           exits: out.results.reduce((a, x) => (a[x.exitAt] = (a[x.exitAt] || 0) + 1, a), {}),
           memory: { measuredPeakWasmMiB: +measuredWasmMiB.toFixed(2), predictedWasmMiBNoMargin: +predictedWasmNoMargin.toFixed(2),
                     predictedWasmMiBWithMargin: +pm.workerWasmMiB.toFixed(2), errorPct: +(100 * (predictedWasmNoMargin - measuredWasmMiB) / measuredWasmMiB).toFixed(1) },
           time: { measuredTotalMs: Math.round(out.totalMs), predictedTotalMs: Math.round(predictedTotalMs),
                   errorPct: +(100 * (predictedTotalMs - out.totalMs) / out.totalMs).toFixed(1) },
           spawns: r.spawns, maxLiveWorkers: Math.max(...r.timeline.map(e => e.liveWorkers)), predictedMaxLiveWorkers: pm.maxLiveWorkers };
}

async function scenario({ profile, overrides = {}, n = 8, start = 0, forcePlan = null }) {
  const d = await decidePlan({ profile, overrides });
  if (!d.feasible && !forcePlan) return { profile, overrides, feasible: false, explanation: d.explanation };
  const plan = forcePlan ? { ...forcePlan, id: planId(forcePlan) } : d.plan;
  const run = await runPlan(plan, { n, start });
  return { profile, overrides, decided: d.plan?.id ?? null, forced: !!forcePlan, usableMiB: d.budget.usableMiB,
           predicted: d.predicted, explanation: d.explanation, candidates: d.candidates, calibration: d.calibrationSource, run,
           date: new Date().toISOString(), userAgent: navigator.userAgent, hardwareConcurrency: navigator.hardwareConcurrency, deviceMemory: navigator.deviceMemory ?? null };
}

window.phase5 = { decidePlan, runPlan, scenario, getCalibration, ready: true };

const opts = () => ({ profile: $('profile').value, overrides: { sentencesPerRequest: Number($('spr').value), earlyExit: $('ee').checked }, useCalibration: $('cal').checked });
const show = async (p) => {
  document.querySelectorAll('button').forEach(b => b.disabled = true); $('out').textContent = 'working…';
  try { const r = await p; $('why').innerHTML = (r.explanation || []).map(l => `<li>${l.replace(/</g, '&lt;')}</li>`).join('');
        $('out').textContent = JSON.stringify(r, null, 2); }
  catch (e) { $('out').textContent = 'ERROR: ' + (e.stack || e); }
  document.querySelectorAll('button').forEach(b => b.disabled = false);
};
$('decide').onclick = () => show(decidePlan(opts()));
$('run').onclick = () => show((async () => { const o = opts(); const d = await decidePlan(o); if (!d.feasible) return d; return { ...d, run: await runPlan(d.plan, { n: 8 }) }; })());
$('copy').onclick = async () => { try { await navigator.clipboard.writeText($('out').textContent); $('copy').textContent = 'Copied'; } catch { $('copy').textContent = 'Select and copy manually'; } };
