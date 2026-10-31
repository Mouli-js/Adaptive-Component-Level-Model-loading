// Demo app — uses ONLY the public API of adaptive-onnx-loader. Every number shown comes from the
// engine (explainPlan / previewPlan) or the runtime (infer results, getCacheStats); nothing is hard-coded.
import { loadModel } from 'adaptive-onnx-loader';
const $ = id => document.getElementById(id);
const esc = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const f1 = x => (x == null || Number.isNaN(x)) ? '—' : Number(x).toFixed(1);
$('coi').textContent = crossOriginIsolated ? 'yes' : 'no — see README';
let model = null, lastRun = null;

const CHUNK = { c0_embed: 'C0 embed', c1_l0_1: 'C1 L0–1', c2_l2_3: 'C2 L2–3', c3_l4_5_cls: 'C3 L4–5+cls', e1_after_c1: 'exit head E1', e2_after_c2: 'exit head E2' };
const setBusy = b => { for (const id of ['load', 'go', 'clear', 'dispose']) $(id).disabled = b || (id !== 'load' && !model); };
const kv = (el, pairs) => { el.innerHTML = pairs.map(([k, v]) => `<dt>${esc(k)}</dt><dd>${esc(v)}</dd>`).join(''); };
const options = () => ({ profile: $('profile').value || null, earlyExit: $('ee').checked, calibrate: $('cal').checked,
                         overrides: { sentencesPerRequest: Number($('spr').value) } });

async function refresh() {
  if (!model) return;
  const s = await model.getCacheStats(), e = model.explainPlan();
  kv($('state'), [['Plan', e.plan.precision + (e.plan.pinned.length === 4 ? ' · all resident' : e.plan.pinned.length ? ` · ${e.plan.pinned.length} pinned` : ' · one at a time') + (e.plan.earlyExit ? ' · early exit' : '')],
    ['Live Workers', s.runtime.liveWorkers], ['Live WASM memory', `${s.runtime.liveWasmMiB} MiB`],
    ['Worker starts', s.runtime.workerStarts], ['Sentences classified', s.runtime.sentences]]);
  $('meterBox').hidden = false;
  const pct = Math.min(100, 100 * s.runtime.peakWasmMiB / e.budget.usableMiB);
  $('meter').style.width = pct + '%'; $('meterTxt').textContent = `measured peak ${s.runtime.peakWasmMiB} of ${e.budget.usableMiB.toFixed(0)} MiB usable (${pct.toFixed(0)}%)`;
  // (2) predicted vs measured memory — like-for-like rows labelled explicitly
  const m = e.predicted.memory, unc = e.context.heapUncertainty;
  const measured = s.runtime.workerStarts ? s.runtime.peakWasmMiB : null;
  $('memTable').hidden = false;
  $('memTable').querySelector('tbody').innerHTML = [
    ['Predicted peak (all components, incl. ×' + unc + ' margin)', f1(m.peakMiB)],
    ['Predicted Worker WASM (no margin)', f1(m.workerWasmMiB / unc)],
    ['Measured peak Worker WASM', measured == null ? 'run Classify' : f1(measured)],
    ['Prediction error (Worker WASM)', measured == null ? '—' : `${f1(100 * (m.workerWasmMiB / unc - measured) / measured)}%`],
    ['Usable budget (allowance − ' + Math.round(e.budget.reserveFraction * 100) + '%)', f1(e.budget.usableMiB)],
  ].map(([k, v]) => `<tr><td>${esc(k)}</td><td class="num">${esc(v)}</td></tr>`).join('');
  await renderCompare();
  kv($('cache'), [['Entries', s.persistent.entries.length ? s.persistent.entries.map(x => `${x.name}/${x.precision} ${x.sizeMiB} MiB (${x.hits} hits)`).join(', ') : 'none'],
    ['Stored', `${s.persistent.usageMiB} MiB`], ['Persistent storage', s.persistent.storage.persisted ? 'granted' : 'not granted (browser may evict)']]);
  renderDebug(e, s);
}

function showPlan(e) {
  $('planId').textContent = e.planId;
  // (1) early-exit status, incl. τ when used
  const ee = e.earlyExit;
  $('eeNote').hidden = !ee.requested;
  $('eeNote').innerHTML = ee.requested ? `<b>Early exit:</b> ${esc(ee.reason)}` : '';
  $('why').innerHTML = e.explanation.map(l => `<li>${esc(l)}</li>`).join('') + `<li class="muted">Timings: ${esc(e.calibration)}</li>`;
  // alternatives considered
  $('altsBox').hidden = false;
  $('alts').innerHTML = e.alternatives.map(a => `<tr><td>${esc(a.family)}</td><td class="${a.status}">${a.status}</td><td>${esc(a.detail)}</td><td class="num">${a.candidates}</td></tr>`).join('');
}

// (5) profile comparison: previews from the engine, nothing applied
async function renderCompare() {
  const base = options(), rows = [];
  for (const p of ['low', 'mid', 'high', null]) {
    const r = await model.previewPlan({ ...base, profile: p });
    const label = p ?? 'this browser', cur = (model.explainPlan().profile === (p ?? 'browser')) ? ' ◀ running' : '';
    rows.push(r.feasible
      ? `<tr><td>${esc(label)}${cur}</td><td>${f1(r.budget.usableMiB)} MiB</td><td><code>${esc(r.planId)}</code></td><td class="num">${f1(r.predicted.memory.peakMiB)} MiB</td><td class="num">${f1(r.predicted.time.perSentenceMs)}</td><td class="num">${(r.predicted.accuracy * 100).toFixed(2)}%</td><td class="num">${r.candidates.feasible} / ${r.candidates.total}</td></tr>`
      : `<tr><td>${esc(label)}</td><td>${f1(r.budget.usableMiB)} MiB</td><td class="rejected" colspan="4">no feasible plan</td><td class="num">0 / ${r.candidates.total}</td></tr>`);
  }
  $('cmp').innerHTML = rows.join('');
}

// (6) experiment / debug view
function renderDebug(e, s) {
  const c = e.context, src = c.sources || {};
  const sig = [['deviceMemoryGiB', c.deviceMemoryGiB], ['cores', c.cores], ['downlinkMbps', c.downlinkMbps], ['rttMs', c.rttMs], ['allowanceMiB', c.allowanceMiB],
               ['minAccuracy', c.minAccuracy], ['sentencesPerRequest', c.sentencesPerRequest], ['diskFreeMiB', c.diskFreeMiB == null ? null : Math.round(c.diskFreeMiB)],
               ['cachedChunks', c.cachedChunks], ['crossOriginIsolated', c.crossOriginIsolated]];
  const cal = e.calibrationValues;
  const calRows = [['source', cal.source], ['Worker start', `${f1(cal.spawnMs)} ms`], ['session create, warm base', `${f1(cal.createBaseWarmMs)} ms`],
                   ['session create, cold base', cal.createBaseColdMs == null ? '—' : `${f1(cal.createBaseColdMs)} ms`], ['create per MiB', `${(cal.createPerMiBMs ?? 0).toFixed(2)} ms`],
                   ['inference C1 int8 / fp32', `${f1(cal.inferC1Ms.int8)} / ${f1(cal.inferC1Ms.fp32)} ms`], ['transfer per boundary', `${(cal.transferMs ?? 0).toFixed(2)} ms`],
                   ['IndexedDB read / SHA-256', `${Math.round(cal.idbReadMBps)} / ${Math.round(cal.hashMBps)} MB/s`]];
  const rej = e.candidates.rejected;
  // like-for-like: predicted compute (excl. loads) vs measured compute + transfer inside the Workers;
  // wall time is shown separately with the number of Worker starts it included
  const pc = e.predicted.time.computeMs;
  const t = lastRun ? [['Sentences in last request', lastRun.n],
      ['Predicted compute + transfer (computeMs × n, excludes loads)', `${f1(pc * lastRun.n)} ms`],
      ['Measured compute + transfer inside Workers (Σ)', `${f1(lastRun.computeMs + lastRun.transferMs)} ms`],
      ['Compute prediction error', `${f1(100 * (pc * lastRun.n - (lastRun.computeMs + lastRun.transferMs)) / (lastRun.computeMs + lastRun.transferMs))}%`],
      ['Measured wall time (incl. loads)', `${f1(lastRun.wallMs)} ms — ${lastRun.starts} Worker start(s) in this request`],
      ['Predicted per-sentence incl. amortised reloads', `${f1(e.predicted.time.perSentenceMs)} ms`],
      ['Predicted initial load', `${(e.predicted.time.initialLoadMs / 1000).toFixed(2)} s — uses the profile's link (${e.context.downlinkMbps} Mbit/s), not this machine's`]]
    : [['Last request', 'run Classify first']];
  const tbl = rows => `<table>${rows.map(([k, v]) => `<tr><td>${esc(k)}</td><td>${esc(v ?? '—')}${src[k] ? ` <small>(${esc(src[k])})</small>` : ''}</td></tr>`).join('')}</table>`;
  $('debugBody').innerHTML =
    `<h3>Device signals (value · source)</h3>${tbl(sig)}` +
    `<h3>Calibration</h3>${tbl(calRows)}` +
    `<h3>Candidates</h3>${tbl([['Generated', e.candidates.total], ['Rejected — memory', rej.memory], ['Rejected — accuracy', rej.accuracy], ['Rejected — unverified accuracy', rej.unverified], ['Feasible', e.candidates.feasible]])}` +
    `<h3>Predicted vs measured time</h3>${tbl(t)}` +
    `<h3>Runtime</h3>${tbl([['Worker starts (total)', s.runtime.workerStarts], ['Live Workers', s.runtime.liveWorkers], ['Requests', s.runtime.requests], ['Peak Worker WASM', `${s.runtime.peakWasmMiB} MiB`]])}`;
}

$('load').onclick = async () => {
  setBusy(true); $('err').textContent = '';
  try {
    if (model) showPlan(await model.replan(options()));
    else { model = await loadModel({ manifestUrl: '/models/onnx/manifest.json', ...options() }); showPlan(model.explainPlan()); }
    $('load').textContent = 'Re-plan'; lastRun = null;
  } catch (e) {
    $('err').textContent = e.code === 'EARLY_EXIT_UNAVAILABLE' ? 'Early exit must be enabled before the first load. Dispose, then load again.' : e.message;
  }
  setBusy(false); await refresh();
};
$('go').onclick = async () => {
  const lines = $('text').value.split('\n').map(s => s.trim()).filter(Boolean); if (!lines.length) return;
  setBusy(true);
  const startsBefore = (await model.getCacheStats()).runtime.workerStarts, t = performance.now();
  try {
    const r = await model.infer(lines);
    const wallMs = performance.now() - t;
    const starts = (await model.getCacheStats()).runtime.workerStarts - startsBefore;
    lastRun = { n: lines.length, wallMs, starts, computeMs: r.reduce((a, p) => a + p.computeMs, 0), transferMs: r.reduce((a, p) => a + p.transferMs, 0) };
    // (3) per-sentence execution details, expandable; (4) confidence labelled as such
    $('resHead').hidden = false;
    $('res').innerHTML = r.map((p, i) => `<details class="r"><summary><span>${esc(lines[i])}</span><span><span class="${p.label}">${p.label}</span> ${(p.score * 100).toFixed(2)}%${p.exitAt !== 'full' ? ` <small>exit ${p.exitAt}</small>` : ''}</span></summary>
      <dl class="kv"><dt>Predicted label</dt><dd>${p.label}</dd><dt>Model confidence</dt><dd>${(p.score * 100).toFixed(2)}% <small>(not accuracy)</small></dd>
      <dt>Execution path</dt><dd>${p.path.map(c => esc(CHUNK[c] ?? c)).join(' → ')}</dd>
      <dt>Stopped at</dt><dd>${p.exitAt === 'full' ? 'full model (C3 classifier)' : `early exit ${p.exitAt.toUpperCase()}`}</dd>
      <dt>Time inside Workers</dt><dd>${f1(p.computeMs)} ms <small>+ ${p.transferMs.toFixed(2)} ms transfer</small></dd>
      <dt>Logits</dt><dd>[${p.logits.map(x => x.toFixed(3)).join(', ')}]</dd></dl></details>`).join('');
    $('took').textContent = `${wallMs.toFixed(0)} ms total (incl. any chunk loads)`;
  } catch (e) { $('err').textContent = e.message; }
  setBusy(false); await refresh();
};
$('clear').onclick = async () => { setBusy(true); await model.clearCache(); setBusy(false); await refresh(); };
$('dispose').onclick = async () => { model.dispose(); model = null; lastRun = null; $('load').textContent = 'Load model'; setBusy(false);
  kv($('state'), [['Status', 'disposed — all chunk Workers terminated, memory returned']]); $('meterBox').hidden = true; $('memTable').hidden = true; };
window.demo = { get model() { return model; } };
