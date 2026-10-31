// Uses only the documented public API: loadModel, AdaptiveLoaderError, model.{plan, explainPlan, infer, getCacheStats, replan, clearCache, dispose}
import { loadModel, AdaptiveLoaderError } from 'adaptive-onnx-loader';
const M = '/models/onnx/manifest.json';
const J = async u => (await fetch(u)).json();
const errCode = async p => { try { await p; return 'NO ERROR'; } catch (e) { return e instanceof AdaptiveLoaderError ? e.code : 'UNTYPED: ' + e; } };
const diff = (preds, ref, start = 0) => Math.max(...preds.map((p, k) => { const r = ref[start + k].logits ?? ref[start + k]; return Math.max(Math.abs(p.logits[0] - r[0]), Math.abs(p.logits[1] - r[1])); }));

async function run() {
  const rows = await J('/fixtures/validation.json'), out = {};
  const S = rows.map(r => r.sentence);
  // 1. Low profile: engine decides; sequential int8
  const m = await loadModel({ manifestUrl: M, profile: 'low' });
  out.low = { plan: m.plan.id, why: m.explainPlan().explanation };
  const p6 = await m.infer(S.slice(0, 6)), single = await m.infer(S[6]);
  const refI = await J('/fixtures/wasm_chain_int8_logits.json');
  out.low.maxDiff = Math.max(diff(p6, refI), diff([single], refI, 6));
  out.low.labelsConsistent = [...p6, single].every(p => (p.label === 'POSITIVE') === (p.logits[1] > p.logits[0]) && p.score > 0.5 && p.score <= 1);
  out.low.singleIsObject = !Array.isArray(single) && typeof single.label === 'string';
  out.low.stats = await m.getCacheStats();
  // explainability additions (output-only): path/time per sentence, alternatives, early-exit status, previewPlan
  out.low.paths = p6.map(p => p.path.join('>')); out.low.timesOk = p6.every(p => p.computeMs > 0 && p.transferMs >= 0);
  const ex = m.explainPlan();
  out.low.alternatives = ex.alternatives.length; out.low.altCandidates = ex.alternatives.reduce((s, a) => s + a.candidates, 0);
  out.low.eeStatus = ex.earlyExit; out.low.ctxSources = Object.keys(ex.context.sources || {}).length;
  const before = m.plan.id, prev = await m.previewPlan({ profile: 'high' });
  out.low.preview = { previewId: prev.planId, unchanged: m.plan.id === before };
  // 2. replan to High: fp32 resident
  out.high = { explain: await m.replan({ profile: 'high' }) };
  const pf = await m.infer(S.slice(0, 6));
  out.high.maxDiff = diff(pf, await J('/fixtures/wasm_chain_fp32_logits.json'));
  out.high.stats = await m.getCacheStats();
  out.earlyExitWithoutMeta = await errCode(m.replan({ earlyExit: true }));
  m.dispose();
  out.afterDispose = { stats: (await m.getCacheStats()).runtime, inferCode: await errCode(m.infer('x')) };
  // 3. Early exit opted in (Low, floor 0.895, batch workload)
  const e = await loadModel({ manifestUrl: M, profile: 'low', earlyExit: true, overrides: { minAccuracy: 0.895, sentencesPerRequest: 32 } });
  const pe = await e.infer(S.slice(0, 32)), refE = await J('/fixtures/wasm_ee_int8.json');
  out.earlyExit = { plan: e.plan.id, maxDiff: diff(pe, refE), exitMismatch: pe.filter((p, k) => p.exitAt !== refE[k].exitAt).length,
                    tau: e.explainPlan().earlyExit.tau, pathsConsistent: pe.every(p => p.exitAt === 'full' ? p.path.at(-1) === 'c3_l4_5_cls' : p.path.at(-1) === (p.exitAt === 'e1' ? 'e1_after_c1' : 'e2_after_c2')),
                    exits: pe.reduce((a, p) => (a[p.exitAt] = (a[p.exitAt] || 0) + 1, a), {}) };
  await e.clearCache(); out.earlyExit.entriesAfterClear = (await e.getCacheStats()).persistent.entries.length; e.dispose();
  // 4. Infeasible budget -> typed error carrying the explanation
  try { await loadModel({ manifestUrl: M, profile: 'low', overrides: { allowanceMiB: 60 } }); out.infeasible = 'NO ERROR'; }
  catch (x) { out.infeasible = { code: x.code, hasExplanation: /No plan satisfies/.test(x.message), feasible: x.details?.decision?.feasible }; }
  // 5. cache disabled
  const n = await loadModel({ manifestUrl: M, profile: 'low', cache: false }); await n.infer(S[0]);
  out.noCache = (await n.getCacheStats()).persistent; n.dispose();
  out.badOptions = await errCode(loadModel({}));
  return out;
}
window.app = { run, ready: true };
document.getElementById('s').textContent = 'ready';
