# Phase 5 — Resource Monitor and Decision Engine: Completion Report

**Planned:** 17–20 Nov 2026 · **Actual:** 31 Oct 2026 (Day 1) · **Status:** 🟨 Complete and verified (cloud), **awaiting your approval**
**Scope:** your approved plan, with the five tightenings from your review. §2 maps each one to its implementation.

---

## 1. Phase overview

**Objective:** For a given device and situation, choose automatically and **deterministically** how the model runs:

- precision per chunk
- which chunk Workers stay alive
- group size
- pre-starting of the next Worker
- (opt-in) early exit

The engine must never break a hard constraint, and must explain every decision.

| Deliverable | Status |
|---|---|
| Resource monitor with Low / Mid / High profile overrides | ✅ `engine/monitor.js`, `engine/profiles.js` |
| Cost model from Phase 2–4 measurements, each memory and time component separate | ✅ `engine/costModel.js`, `engine/measurements.js` |
| Per-device time calibration | ✅ `engine/calibrate.js` (rebuilt twice; see §6) |
| Candidate generator → hard-constraint filter → weighted ranking → explanation | ✅ `engine/planner.js` |
| Plan runner for every plan shape (resident, sequential, hybrid, pre-start, early exit) | ✅ `workers/planRunner.js` |
| Early exit: off by default; τ tuned on the dev split; accuracy measured, not estimated | ✅ |
| Unit tests (profiles → plans, constraints, determinism) and browser validation | ✅ 14/14 + 53/53 |

## 2. How each of your adjustments was implemented

| Your requirement | Implementation | Evidence |
|---|---|---|
| **Safety reserve:** never target 100% of the budget | usable = allowance × (1 − 0.15). The 15% reserve is a parameter (`reserveFraction`) and appears in every explanation. | test "usable budget keeps the reserve"; e.g. Low: 150 → 127.5 MiB |
| **Memory split into components** | `predictMemory` returns Worker WASM heap (× 1.10 uncertainty), page-held tensors (group × 0.375 MiB worst case), cached bytes in memory (0 on the Worker path), and browser overhead (3 MiB page + 2 MiB per live Worker, from Phase 3 D). They must sum to the peak. | test "memory prediction reports every component…" |
| **Don't assume identical heaps across platforms** | Heaps are **measured estimates × 1.10 uncertainty**, in addition to the 15% budget reserve. F-27 is restated as "matched on the 2 platforms tested", not a general rule. | `measurements.js`, `DEFAULTS.heapUncertainty` |
| **Time calibrated separately** for download, creation, inference and transfer | Download comes from the link signal or profile. Creation = Worker start + base + slope × MiB, with base depending on whether another Worker is alive (F-28). Inference per chunk and precision is calibrated on length-representative sentences after warm-up. Transfer = round trip minus run time. IndexedDB and hash rates come separately from cached loads. | `calibrate.js`, `costModel.loadTime` |
| **Disk cache and in-memory residency as separate resources** | Disk (IndexedDB) has its own budget: free quota × (1 − 10%). Fitting on disk is **not** a hard constraint; it decides whether reloads come from disk or the network. In-memory residency (pinned Workers) counts against the memory budget. | `usableBudget().diskUsableMiB`, `predictTime(…, {diskFits})` |
| **Reject infeasible plans first, then rank only the rest** | Step 4 runs before any cost is computed. Cost normalisation uses only the feasible set. | `planner.decide` |
| **Deterministic 7-step sequence** | Exactly the 7 steps in code order. No randomness and no clock in the decision. Ties are broken by fewer Worker starts, then less network, then plan id. | test "deterministic: byte-identical decisions" |
| **Weighted cost** | Cost = w_m·M̂ + w_t·T̂ + w_l·L̂ + w_n·N̂. Each term is divided by the best feasible value, so the weights are unit-free. Low (0.6 / 0.2 / 0.2) prioritises memory; High (0.1 / 0.6 / 0.3) prioritises latency. w_n defaults to 0. | `profiles.js`, explanation line 6 |
| **Hard constraints separate from preferences** | Hard: memory ≤ usable budget, accuracy ≥ floor, accuracy must be *measured* (unmeasured plans are rejected as "unverified"), outputs reference-identical (proven by the browser gates). Preferences: the cost terms and the tie-breakers. A plan that violates a hard constraint is removed before any cost is computed. | sweep test over 130 budget × floor × workload combinations |
| **Early exit off by default** | `DEFAULTS.earlyExit = false`. Early-exit candidates are only generated when you opt in, and are still subject to the accuracy floor. | tests; S5 (opt-in) vs S1 |
| **Explainable output** | Every decision returns the context (with the **source** of each value: profile, browser or default), the budget, candidate counts by rejection reason, the predicted memory and time breakdown, the cost terms, and the runners-up. | test "explanation names …" |

## 3. Headline results

### 3.1 What the engine chooses (cloud calibration, 237 candidates; 474 with early exit)

| Profile | Usable memory | Accuracy floor | Workload | **Chosen plan** | Rejected (memory / accuracy) | Feasible |
|---|---|---|---|---|---|---|
| Low | 127.5 MiB | 0.900 | 1 sentence | **int8 · one Worker at a time · groups of 1** | 234 / 0 | 3 |
| Low | 127.5 MiB | 0.900 | 32 sentences | **int8 · one at a time · groups of 32** | 234 / 0 | 3 |
| Mid | 435.2 MiB | 0.905 | 1 | **mixed (C2 fp32) · all resident** | 76 / 79 | 82 |
| High | 1,305.6 MiB | 0.910 | 1 | **fp32 · all resident** | 0 / 158 | 79 |
| Low + early exit opted in, floor 0.895 | 127.5 MiB | 0.895 | 32 | **int8 · one at a time · G = 32 · early exit** | 468 / 0 | 6 |
| Low + early exit opted in, floor 0.900 | 127.5 MiB | 0.900 | — | early exit **rejected** (89.91% < 90.0%) | — | — |
| Mid + early exit opted in | 435.2 MiB | 0.905 | 1 | **mixed · resident · early exit** (90.60% ≥ 0.905) | 162 / 158 | 154 |

Example explanation (Low, 1 sentence per request), exactly as the engine returns it:

> 1. Profile "low": allowance 150 MiB − 15% reserve = usable 127.5 MiB; minimum accuracy 0.9.
> 2. Hard constraints rejected 234 plans for memory and 0 for accuracy; 3 of 237 remain.
> 3. Chosen: int8 weights, one chunk Worker at a time, groups of 1.
> 4. Predicted peak memory 90.3 MiB (Workers 84.9 incl. ×1.1 uncertainty, tensors 0.4, overhead 5.0), 71% of the usable budget.
> 5. Predicted 972.5 ms per sentence and 361.12 s initial load; accuracy 90.02%.
> 6. Weights m=0.6 t=0.2 l=0.2: lowest weighted cost 1.000 (next best int8|sequential|pin=-|G=8|pw=0|ee=0 at 1.017).

The 361 s initial load is correct for the Low profile's simulated **1.5 Mbit/s** link on a first visit (64 MiB to download). On a revisit the cache removes it (Phase 4).

### 3.2 Browser validation: decided and forced plans, executed (CLOUD-HL-1T, calibrated on the device)

| | Plan | Outputs vs reference | Peak WASM measured / predicted (no margin) | ≤ usable? | Time measured / predicted |
|---|---|---|---|---|---|
| S1 | int8 · sequential · G1 | Δ = 0 | 77.19 / 77.19 MiB (0%) | ✅ 127.5 | 8,862 / 8,053 ms (−9.1%) |
| S2 | int8 · sequential · G32 | Δ = 0 | 77.19 / 77.19 (0%) | ✅ | 7,423 / 6,899 (−7.1%) |
| S3 | mixed · resident | Δ = 0 | 355.06 / 354.99 (0%) | ✅ 435.2 | 3,240 / 3,192 (−1.5%) |
| S4 | fp32 · resident | Δ = 0 | 813.31 / 813.23 (0%) | ✅ 1,305.6 | 4,207 / 4,369 (+3.9%) |
| S5 | int8 · sequential · G32 · **early exit** | Δ = 0, exit points identical | 77.19 / 77.19 (0%) | ✅ | 7,092 / 6,559 (−7.5%) |
| S6 | mixed · resident · **early exit** | Δ = 0, exit points identical | 355.06 / 378.99 (+6.7%) | ✅ | 3,187 / 2,795 (−12.3%) |
| F1 | *forced* int8 · C0 pinned · G8 · pre-start | Δ = 0 | 123.56 / 168.79 (upper bound)† | — | 2,214 / 1,712 (−22.7%) |
| F2 | *forced* fp32 · sequential · G8 · pre-start | Δ = 0 | 280.13 / 466.33 (upper bound)† | — | 6,459 / 4,229 (−34.5%) |
| F3 | *forced* mixed · C2 pinned · G8 | Δ = 0 | 263.44 / 263.39 (0%) | — | 3,377 / 2,292 (−32.2%) |

† **Pre-start plans:** the probe sees a Worker's heap only after its load completes. When the current chunk finishes before the pre-started one is ready, the overlap window is invisible, so the measurement is a **lower bound** and the prediction an **upper bound**. In the previous run, F1 *did* capture the overlap (167.69 vs 168.79 MiB), which confirms the overlap is real and the bound is needed.

**Gate summary:** 53/53, covering:

- outputs equal to the reference (Δ = 0 for int8 and early exit; < 1e-4 for fp32 and mixed)
- identical early-exit points
- measured peak ≤ usable budget for every decided plan
- the prediction **never underestimates** memory (all 9 scenarios)
- ±15% memory accuracy for every plan without pre-start
- live Workers ≤ predicted
- no page errors

### 3.3 Accuracy table used by the hard constraint (SST-2 validation, WASM engine; all measured)

| Precision plan | Without early exit | With early exit (τ = 0.95) | Exit after C1 / C2 / full |
|---|---|---|---|
| fp32 | 91.06% | 90.71% (−0.35) | 20.1% / 24.0% / 56.0% |
| mixed (C2 fp32) | **90.83%** (new) | 90.60% (−0.23) | 17.2% / 25.1% / 57.7% |
| int8 | 90.02% | 89.91% (−0.11) | 17.2% / 24.0% / 58.8% |

τ was chosen **on the dev split only** (the 2,000 held-out training sentences): the smallest τ whose predictions agree with the full model on ≥ 99% of dev. That gave τ = 0.95 (99.1% agreement; 23.8% / 40.2% exits on dev). The validation set above was used only for evaluation, never for the choice (I-1.3 resolved).

## 4. New findings (added to `docs/FINDINGS.md`)

| ID | Finding |
|---|---|
| **F-28** | **Session creation is ~2.5× slower when no other chunk Worker is alive** (cold 356–459 ms vs warm 111–218 ms per chunk, in Phase 3 resident vs sequential loads and the Phase 5 calibration). The likely mechanism is that the browser reuses the compiled WASM module only while some Worker holds it. That's a hypothesis consistent with both datasets, not verified. **This difference was the main error in the first cost model.** Consequence: plain sequential mode pays the cold cost on every reload, while pinning one chunk or pre-starting makes every reload warm. |
| **F-29** | **Inference time depends on sentence length and on JIT warm-up:** the first run after a Worker starts is ~2× slower (19.1 → ~9 ms), and short sentences are faster (8.8 ms) than the validation mix (~14.7 ms). Calibration must discard warm-up runs and use a length-representative sample. |
| **F-30** | **Mixed precision (C2 fp32, rest int8) reaches 90.83% in WASM**, recovering 78% of the int8 → fp32 gap for +141 MiB resident memory (355 vs 214 MiB). That makes it the Mid profile's choice. |
| **F-31** | **Early exit at τ = 0.95 (tuned on dev)** costs 0.11–0.35 points on validation, and 41–44% of sentences stop before the last chunk. Running the exit head inside the C1/C2 Worker **added no measurable WASM memory** (S6: 355.06 MiB with and without exits). The 12 MiB-per-head estimate is therefore conservative. |
| **F-32** | **The cost model's time error depends on plan shape.** Decided plans (resident / sequential): −12.3% to +3.9% (mean \|e\| 6.9%). Hybrid and pre-start plans: −23% to −35%, always *under*-predicted. A likely contributor is CPU contention between Worker creation and inference on the 2-vCPU machine; not verified. |

## 5. Implementation details

### 5.1 Module map (`packages/adaptive-onnx-loader/src/engine/`)

```
profiles.js      PROFILES (low/mid/high) and DEFAULTS (reserve 15%, heap ×1.10, early exit OFF, group sizes)
monitor.js       readSignals()  → deviceMemory, cores, connection.downlink/rtt, storage.estimate, cached SHA-256s
                 applyProfile() → context; every value tagged with its source (override / profile / browser / default)
                 usableBudget() → memory (allowance − reserve) and disk (free quota − 10%) as separate resources
measurements.js  measured inputs with their evidence: per-chunk heaps, overheads, accuracies, default timings
costModel.js     chunkInfo(), predictMemory(), loadTime(), predictTime(), reachFractions() (early exit)
planner.js       generateCandidates(), decide()  (the 7 steps), summarize(), explain()
calibrate.js     per-device time calibration (medians, warm-up discarded, warm vs cold creation)
workers/planRunner.js  executes any plan; records loads, live heap, Workers and exit points
```

### 5.2 Candidate space (237 without early exit, 474 with)

For each of 3 precision plans, the generator takes every subset of the 4 chunks to pin:

- **∅** = sequential
- **all 4** = resident
- **anything else** = hybrid

Each non-resident plan gets group sizes {1, 8, 32}, and pre-start on/off where at least 2 chunks are not pinned. For 3 precision plans: 3 × (6 + 24 + 36 + 12 + 1) = **237**. The group size used for time is min(G, sentences per request), because a group can't hold more sentences than a request has.

### 5.3 Memory model (per plan)

```
Worker WASM   = ( Σ heap(pinned) + max over non-pinned i of [heap(i) + (prewarm ? heap(next non-pinned) : 0)] ) × 1.10
page tensors  = (non-pinned exist ? G : 1) × 0.375 MiB      (worst case: one 128-token hidden state per waiting sentence)
cached bytes  = 0 MiB                                       (the Worker path keeps no byte cache in memory)
overhead      = 3.0 + 2.0 × maxLiveWorkers MiB              (Phase 3 D: page 2.8 MiB, ≈1.6 MiB per Worker)
peak          = sum of the above;  HARD: peak ≤ usable
```

### 5.4 Time model (per plan)

```
load(chunk)  = download (if not cached: RTT + size/link) + disk read (if cached) + store (if downloaded)
             + SHA-256 verify + Worker start + create(base_warm|cold + slope × MiB)
compute      = Σ_chunks reach_i × infer_i (+ exit head) + Σ reach × transfer
reload/group = Σ_non-pinned max(0, load_i − (prewarm ? G × infer_prev : 0))
T            = compute + reload/group ÷ G                (per sentence, amortised)
L            = Σ first-request loads on the critical path (pre-start overlaps them with compute)
```

`reach` = the share of sentences that get to a chunk (1, 1, 1 − exit1, 1 − exit1 − exit2 with early exit; otherwise all 1).

### 5.5 `PlanRunner`

For each group of G sentences, it processes chunk-major:

1. Get the chunk's Worker: pinned and alive, pre-started, or newly spawned.
2. If pre-start is on, spawn the **next** non-pinned chunk *before* running this one, so the two overlap.
3. Run every active sentence through the chunk (batch size 1).
4. With early exit, the C1/C2 Worker also runs its exit head in the same call. Sentences with confidence ≥ τ stop there.
5. Terminate the Worker unless it's pinned.

Pinned Workers survive across groups and requests until `release()`. The runner records loads, live heap, live Workers and exit points.

**Exit heads inside the chunk's Worker:** an exit head is a tiny graph that needs the chunk's output. Hosting it in the same Worker (an additive `exitEntry` in the Worker protocol) avoids a whole extra Worker and its ~16–19 MiB fixed cost (F-18). It also avoids an extra transfer: the hidden state never leaves the Worker for the head.

## 6. What went wrong and how it was fixed (calibration, in two rounds)

| Version | Change | Decided-plan time error | What was wrong |
|---|---|---|---|
| v1 | 1 sample per load; 5 short sentences, no warm-up discard | −55% to +15% (S1 −55%) | One outlier creation sample (130 ms vs ~430 real) skewed the fit; warm-up inflated inference ×1.9 |
| v2 | Medians of 3 loads, warm-up discarded | −28% to −56% (all under) | Calibration measured creation **with another Worker alive** (warm), while sequential plans reload **cold** (F-28) |
| **v3 (final)** | Separate warm and cold creation; length-representative sentences (every 54th) | **−12.3% to +3.9%** (mean \|e\| 6.9%) | — for decided plans; hybrid and pre-start still −23 to −35% (F-32, I-5.1) |

All three runs are kept as evidence: `results/phase5/cloud_engine_v1_calibration_flaw.json`, `cloud_engine_v2_no_compile_effect.json`, `cloud_engine.json`. **Memory predictions were exact in all three.** Only the time model changed.

## 7. Technical decisions

| Decision | Alternatives | Why |
|---|---|---|
| Exhaustive enumeration (237 / 474 plans) | Search heuristics, ILP | The space is small (≪ 1 ms to score), so exhaustive search is optimal **by construction**, deterministic and easy to test |
| Min-normalised weighted sum | Raw units, Pareto front | Unit-free weights a profile can express ("memory matters 3×"); a Pareto front doesn't give a single answer |
| Accuracy as a hard floor, not a cost term | Weighted accuracy | Your requirement; it also keeps accuracy guarantees separate from performance preferences |
| Unmeasured accuracy ⇒ reject ("unverified") | Estimate it | A hard constraint can't rest on an estimate |
| Profiles carry an accuracy floor | One global floor | Without it the cost function always prefers int8 (smaller and faster). The floor lets a better device trade memory for quality, explicitly. |
| Heap × 1.10 **and** a 15% budget reserve | One margin | They cover different risks: estimate error vs other memory the page needs |
| Upper-bound memory for pre-start | Assume no overlap | The overlap was observed (F1, run 1); the safe direction is the hard constraint's direction |
| Exit head inside the chunk's Worker | Separate Worker | No ~16–19 MiB fixed cost, no extra transfer |
| Fixed CLOUD defaults + optional calibration | Always calibrate | Deterministic unit tests; calibration (~7.5 s) is an explicit choice |

## 8. Files and components

**New:** `src/engine/{profiles,monitor,measurements,costModel,planner,calibrate}.js` · `src/workers/planRunner.js` · `test/engine.test.mjs` (14 tests) · `demo/phase5-engine.html`, `demo/phase5-engine.js` · `bench/phase5_browser_test.mjs` · `bench/measure_early_exit.mjs` · `python/tune_early_exit.py` · `models/heads/early_exit_policy.json` · `results/phase5/*` (early-exit table, 3 engine runs, 3 regression runs).

**Changed (additive):**

- `src/workers/chunkWorker.js`, `src/workers/workerChunk.js`: optional `exitEntry` / `withExit`
- `src/index.js`: exports
- `bench/gen_chain_refs.mjs`: named mixed plan, and a new reference `data/sst2/wasm_chain_mixedC2_logits.json` (git-ignored)

**Baseline (Phase 2) files:** unchanged.

## 9. Validation summary

| # | Test | Result |
|---|---|---|
| V1 | Unit tests, all packages | ✅ **31/31** (14 new) |
| V2 | Profile → plan table (Low ×2, Mid, High) | ✅ 4/4 |
| V3 | Determinism (byte-identical JSON) | ✅ |
| V4 | Hard-constraint sweep: 13 budgets × 5 floors × 2 workloads | ✅ never violated; infeasible cases return reasons |
| V5 | Larger budget never shrinks the feasible set | ✅ |
| V6 | Early exit: off by default; floor enforced; unmeasured ⇒ rejected | ✅ |
| V7 | Browser: 6 decided + 3 forced scenarios | ✅ **53/53** |
| V8 | Regression: Phase 2 / Phase 3 / Phase 4 (int8) | ✅ 5/5 · 23/23 (peaks 214.1 / 77.2) · 26/26 |

## 10. Issues, limitations and deviations

| ID | Item | Severity | Action |
|---|---|---|---|
| I-5.1 | **Hybrid and pre-start time predictions are 23–35% optimistic** (F-32). The engine could over-prefer them on profiles where they're feasible. | Medium | Phase 7: measure on your Mac (4+ cores) and refit, or add a contention term. Until then this is a documented bias; it didn't affect the plans chosen for Low, Mid or High. |
| I-5.2 | **Pre-start memory overlap can't always be observed** (probe timing) | Low | The prediction is used as an upper bound; reported, not gated |
| I-5.3 | All Phase 5 numbers are cloud numbers; calibration on your Mac is untested | Medium | Recommended Mac run (§11) |
| I-5.4 | The exit-head memory estimate (12 MiB per head) is conservative; measured ≈ 0 | Low | Leave conservative; it can only cause over-rejection near the budget edge (S6 reached 98% of usable) |
| I-5.5 | τ features came from the fp32 PyTorch backbone; int8 / mixed plans reuse τ = 0.95 | Low | Their validation accuracy was measured per plan, so the hard constraint is still exact |
| I-5.6 | `navigator.connection` is Chromium-only; Safari and Firefox fall back to defaults (5 Mbit/s, 150 ms) | Low | Documented; the source of each value is reported |
| I-5.7 | The PIPELINED policy from the master plan is implemented as **pre-start** within chunk-major execution, not as overlapping two sentences in different chunks | Deviation (scope) | The plan's goal (hide load time behind compute) is met; true pipelining between sentences is future work |

No other planned requirement was skipped. I-1.1 (mixed precision), I-1.3 (τ on dev), I-3.2 (group size), I-4.1 (pinning) and I-4.2 (pre-start) are resolved in this phase.

## 11. Recommended Mac check (~3 min)

With `npm run serve` running, open **http://localhost:8080/demo/phase5-engine.html**:

1. **Profile = "this browser"**, Calibrate on, then **Decide**. This shows what the engine picks for your real Mac signals.
2. **Profile = low**, then **Decide and run**. Expect int8 one-at-a-time, `run.maxAbsDiffVsRef: 0`, `run.memory.measuredPeakWasmMiB` ≈ 77.19.
3. **Profile = high**, then **Decide and run**. Expect fp32 resident.

Copy the JSON results to me. Your Mac's calibration will show whether F-28 and F-32 hold on a 4+-core machine.

## 12. Next phase: Phase 6, npm package and demo (planned 21–23 Nov)

Public API (`loadModel()`, `infer()`, `getCacheStats()`, `explainPlan()`), TypeScript types, README, a clean `npm pack` installed into an empty project, and a demo page that shows the engine's decision and live memory. Viva topics: API design, packaging ES modules with Workers, semantic versioning.
