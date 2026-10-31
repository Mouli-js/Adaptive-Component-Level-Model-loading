/**
 * Decision engine — deterministic 7-step sequence:
 *   1. read signals + apply profile        (monitor.applyProfile)
 *   2. usable memory budget                (monitor.usableBudget)
 *   3. generate candidate plans            (generateCandidates)
 *   4. reject plans violating HARD constraints (memory, accuracy, known/verified outputs)
 *   5. estimate cost of the remaining plans
 *   6. select the lowest-cost feasible plan (deterministic tie-breakers)
 *   7. return the plan + explanation + predicted metrics
 * Same inputs -> same output (no randomness, no clock, stable ordering).
 */
import { applyProfile, usableBudget } from './monitor.js';
import { ACCURACY, PRECISION_PLANS, DEFAULT_CALIBRATION } from './measurements.js';
import { DEFAULTS } from './profiles.js';
import { CHAIN, chunkInfo, predictMemory, predictTime } from './costModel.js';

const subsets = arr => arr.reduce((acc, x) => acc.concat(acc.map(s => [...s, x])), [[]]);
export const planId = p => `${p.precision}|${p.pinned.length === 4 ? 'resident' : p.pinned.length === 0 ? 'sequential' : 'hybrid'}|pin=${p.pinned.map(n => n.slice(0, 2)).join('+') || '-'}|G=${p.groupSize}|pw=${+p.prewarm}|ee=${+!!p.earlyExit}`;

export function generateCandidates({ earlyExit = false, groupSizes = DEFAULTS.groupSizes } = {}) {
  const out = [];
  for (const precision of Object.keys(PRECISION_PLANS))
    for (const pinned of subsets(CHAIN))                                  // 16 pin sets (∅ = sequential, all = resident)
      for (const groupSize of pinned.length === 4 ? [1] : groupSizes)
        for (const prewarm of pinned.length >= 3 ? [false] : [false, true])   // prewarm needs ≥ 2 non-pinned chunks
          for (const ee of earlyExit ? [false, true] : [false])
            out.push({ precision, pinned: CHAIN.filter(c => pinned.includes(c)), groupSize, prewarm, earlyExit: ee });
  return out.map(p => ({ ...p, id: planId(p) }));
}

/** accuracy of a plan on SST-2 validation (WASM). Unknown accuracy => plan cannot be accepted. */
function planAccuracy(plan, eeTable) {
  if (!plan.earlyExit) return ACCURACY[plan.precision] ?? null;
  return eeTable?.[plan.precision]?.accuracy ?? null;
}

export function decide({ manifest, signals, profile = null, overrides = {}, calibration = DEFAULT_CALIBRATION, earlyExitTable = null }) {
  // 1–2
  const ctx = applyProfile(signals, profile, overrides);
  const budget = usableBudget(ctx);
  // 3
  const cands = generateCandidates({ earlyExit: ctx.earlyExit });
  const rejected = { memory: 0, accuracy: 0, unverified: 0 }, feasible = [];
  for (const plan of cands) {
    const chunks = chunkInfo(manifest, plan);
    const mem = predictMemory(plan, chunks, ctx);
    const acc = planAccuracy(plan, earlyExitTable);
    // 4 — HARD constraints, checked before any cost is considered
    if (acc == null) { rejected.unverified++; continue; }                  // no measured, reference-checked accuracy
    if (acc < ctx.minAccuracy) { rejected.accuracy++; continue; }
    if (mem.peakMiB > budget.usableMiB) { rejected.memory++; continue; }
    // 5
    const diskNeedMiB = chunks.reduce((s, c) => s + c.sizeMiB, 0);
    const diskFits = diskNeedMiB <= budget.diskUsableMiB;
    const time = predictTime(plan, chunks, ctx, calibration, { exitStats: earlyExitTable?.[plan.precision], diskFits });
    feasible.push({ plan, mem, time, accuracy: acc, diskNeedMiB, diskFits });
  }
  const base = { profile: ctx.profile, context: ctx, budget, calibrationSource: calibration.source,
                 candidates: { total: cands.length, rejected, feasible: feasible.length } };
  if (!feasible.length) return { ...base, feasible: false, plan: null,
    explanation: [`No plan satisfies the hard constraints: usable memory ${budget.usableMiB.toFixed(1)} MiB, minimum accuracy ${ctx.minAccuracy}.`,
                  `Rejected: ${rejected.memory} for memory, ${rejected.accuracy} for accuracy, ${rejected.unverified} unverified.`] };
  // 5 — normalised weighted cost (each term divided by the best feasible value)
  const best = k => Math.min(...feasible.map(f => k(f)));
  const mMin = best(f => f.mem.peakMiB), tMin = best(f => f.time.perSentenceMs), lMin = best(f => f.time.initialLoadMs),
        nMin = best(f => f.time.networkMiBFirstRequest);
  const w = ctx.weights;
  for (const f of feasible) {
    f.terms = { m: f.mem.peakMiB / mMin, t: f.time.perSentenceMs / tMin, l: f.time.initialLoadMs / lMin,
                n: (f.time.networkMiBFirstRequest + 1) / (nMin + 1) };
    f.cost = w.m * f.terms.m + w.t * f.terms.t + w.l * f.terms.l + (w.n ?? 0) * f.terms.n;
  }
  // 6 — deterministic order: cost, then preferences (fewer Worker startups, less network), then id
  feasible.sort((a, b) => (a.cost - b.cost) || (a.time.startupsPerSentence - b.time.startupsPerSentence)
                       || (a.time.networkMiBFirstRequest - b.time.networkMiBFirstRequest) || a.plan.id.localeCompare(b.plan.id));
  const chosen = feasible[0];
  // 7
  return { ...base, feasible: true, plan: chosen.plan, predicted: summarize(chosen), runnersUp: feasible.slice(1, 4).map(summarize),
           explanation: explain(chosen, ctx, budget, base.candidates, feasible) };
}

const r1 = x => Math.round(x * 10) / 10;
function summarize(f) {
  return { id: f.plan.id, cost: +f.cost.toFixed(4), terms: Object.fromEntries(Object.entries(f.terms).map(([k, v]) => [k, +v.toFixed(3)])),
           accuracy: f.accuracy,
           memory: { peakMiB: r1(f.mem.peakMiB), workerWasmMiB: r1(f.mem.workerWasmMiB), pageTensorsMiB: r1(f.mem.pageTensorsMiB),
                     cachedBytesMiB: f.mem.cachedBytesMiB, browserOverheadMiB: r1(f.mem.browserOverheadMiB), maxLiveWorkers: f.mem.maxLiveWorkers },
           time: { perSentenceMs: r1(f.time.perSentenceMs), computeMs: r1(f.time.computeMs), reloadPerSentenceMs: r1(f.time.reloadPerSentenceMs),
                   transferMs: r1(f.time.transferMs), initialLoadMs: Math.round(f.time.initialLoadMs), startupsPerSentence: r1(f.time.startupsPerSentence),
                   effectiveGroupSize: f.time.effectiveGroupSize },
           network: { firstRequestMiB: r1(f.time.networkMiBFirstRequest), persistentCache: f.diskFits, diskNeedMiB: r1(f.diskNeedMiB) },
           loadBreakdownFirst: f.time.loadBreakdownFirst };
}

function explain(f, ctx, budget, cands, feasible) {
  const p = f.plan, mode = p.pinned.length === 4 ? 'all chunk Workers resident' : p.pinned.length === 0 ? 'one chunk Worker at a time'
    : `${p.pinned.join(', ')} kept resident, the rest loaded one at a time`;
  const lines = [
    `Profile "${ctx.profile}": allowance ${ctx.allowanceMiB} MiB − ${Math.round(ctx.reserveFraction * 100)}% reserve = usable ${budget.usableMiB.toFixed(1)} MiB; minimum accuracy ${ctx.minAccuracy}.`,
    `Hard constraints rejected ${cands.rejected.memory} plans for memory and ${cands.rejected.accuracy} for accuracy${cands.rejected.unverified ? `, ${cands.rejected.unverified} with unmeasured accuracy` : ''}; ${cands.feasible} of ${cands.total} remain.`,
    `Chosen: ${p.precision} weights, ${mode}${p.pinned.length < 4 ? `, groups of ${f.time.effectiveGroupSize}` : ''}${p.prewarm ? ', next chunk pre-started while the current one computes' : ''}${p.earlyExit ? ', early exit ON (opted in)' : ''}.`,
    `Predicted peak memory ${f.mem.peakMiB.toFixed(1)} MiB (Workers ${f.mem.workerWasmMiB.toFixed(1)} incl. ×${ctx.heapUncertainty} uncertainty, tensors ${f.mem.pageTensorsMiB.toFixed(1)}, overhead ${f.mem.browserOverheadMiB.toFixed(1)}), ${(100 * f.mem.peakMiB / budget.usableMiB).toFixed(0)}% of the usable budget.`,
    `Predicted ${f.time.perSentenceMs.toFixed(1)} ms per sentence and ${(f.time.initialLoadMs / 1000).toFixed(2)} s initial load; accuracy ${(f.accuracy * 100).toFixed(2)}%.`,
    `Weights m=${ctx.weights.m} t=${ctx.weights.t} l=${ctx.weights.l}: lowest weighted cost ${f.cost.toFixed(3)}${feasible[1] ? ` (next best ${feasible[1].plan.id} at ${feasible[1].cost.toFixed(3)})` : ''}.`,
  ];
  return lines;
}
