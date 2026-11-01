# Phase 7: Experiments, Completion Report

**Dates:** 31 Oct – 1 Nov 2026 (planned 24–27 Nov) · **Status:** ✅ **Approved 1 Nov 2026**: results, validation outcomes, limitations, unsupported hypotheses and unexplained observations accepted. The time-prediction model is **future work** (not investigated). Development frozen after the Phase 7 commit.
**Detailed results:** cloud + offline → `docs/phase-reports/PHASE_7_RESULTS_REPORT.md`; Mac → `docs/phase-reports/PHASE_7_MAC_RESULTS.md`. The two are **never combined or averaged**; this report places them side by side.
**Plan:** `docs/PHASE_7_EXPERIMENT_PLAN.md` v1.2 · **Pilot:** `docs/phase-reports/PHASE_7_PILOT_REPORT.md` · **Checklist:** `docs/PHASE_7_EXECUTION_CHECKLIST.md`

---

## 1. Overview

**Objective:** collect the evidence for or against the project's claims:

- **H1 / H2:** splitting + Workers make the memory / latency trade-off controllable.
- **H3 / H4 / H5:** early exit, mixed precision and caching have measurable costs and benefits.
- **Engine:** the decision engine picks good plans and predicts them well.
- **Mandatory findings:** F-5 (native vs WASM) and F-6 (int8 batch dependence).

**How:** pre-registered predictions → pilot → plan v1.2 (with your decisions) → validated execution blocks.

## 2. Work completed

| Part | Result |
|---|---|
| Plan v1.0 → v1.1 → v1.2 | Your 7 decisions, 3 instructions, R1–R5 and 5 execution conditions applied |
| Harness | Runner page, cloud suite (10 blocks), validator, offline runner (WASM + native), Mac page with `?only=` and foreground guard, analysis scripts |
| Pilot (P-0) | CPU throttling doesn't reach Workers (dropped); throttle within ±5%; determinism and probe verified; E2 / E3 redesigned |
| Cloud + offline (Steps 1–13) | 1,310 browser runs + 249 offline passes (WASM, native x86-64 1.20.1 / 1.29.0, native aarch64 1.20.1); **all 13 blocks valid; 0 failed runs**; 6.0 h |
| Mac (Step 14) | Original run (MAC-1 valid; MAC-2 timing invalid, kept) + MAC-5 + re-run of MAC-2 / 3 / 4 (**valid**, 235 / 235, foreground guard clean) |

## 3. Implementation details

- **Measurement code:** only the public API and the forced-plan runner already used in Phase 5. **Engine, runtime, package, baseline and demo unchanged** in the whole phase.
- **Isolation:**
  - Cloud: one browser process per run; fixed origin per link (F-36).
  - Cache states set by copying one primed profile, or by using an empty one.
  - Mac: one page reload per run; visibility recorded per run.
- **Checks on every run:**
  - outputs vs reference (int8 Δ = 0; fp32 / mixed Δ < 1e-4; exit points identical)
  - cache state and origin before / after
  - server bytes (cloud)
  - memory probe + upper bound for pre-start plans
- **Statistics:** median / IQR / bootstrap 95% CIs; exact McNemar; seeded random order; failed attempts kept and retried as `retryOf` rows (none needed in the final data).

## 4. Technical decisions (with reasons)

| Decision | Why |
|---|---|
| Predictions written before measuring (plan §6) | So unsupported hypotheses are reported, not rationalised |
| Validator separates conduct from outcome | A block fails only for how it was run, never because a hypothesis failed |
| Cache off in E1, cold / warm copies elsewhere | The same cache state for every compared plan (your instruction 3) |
| One fixed calibration per device for E-ENG | Near-ties flip with calibration noise (F-35) |
| WASM in Node for E4 / E-B | Same kernels as the browser (hashes checked at batch 1 and 32) |
| Native on two architectures (R4) | "Native" depends on CPU and ORT version (F-34) |
| Refit only as a parameterised **copy** of the time formula | Condition 1: the engine is not modified |

## 5. Why it matters

- **The architecture's central claim holds on both machines:** peak memory is controllable by policy, and identical across platforms.
- **The negative results define where it does not help:**
  - pre-start doesn't speed up the first result
  - early exit doesn't save bytes over a session
  - precision differences aren't statistically significant at n = 872
  - the time model is optimistic for pre-start / pinned plans
- These results are what the final report and viva need: honest limits measured with a valid method.

## 6. Results by hypothesis (cloud and Mac in separate columns)

| | Cloud (CLOUD-HL-1T, x86-64, 2 vCPU) | Mac (MAC-CHROME-*, Apple Silicon, 8 cores) | Verdict |
|---|---|---|---|
| **H1** memory policies | sequential < chain < baseline at every precision (int8 80 < 111 < 180 MiB; fp32 283 < 403 < 656); identical in all reps; sequential costs +50–72% TTFI | peaks **identical to the cloud** in all 8 configurations (F-27) | ✅ Supported |
| **H2** pre-start lowers TTFI | ≤ 6% either way; CI includes 0 in 6 / 8 cells; +5.7% slower once. Workload −18…−27%; memory +18–33% (probe) / ≤ +67% (bound) | not measured as an experiment (only within E-ENG plans) | ❌ **Not supported** (throughput benefit found) |
| **H3** early exit, latency / compute | resident −19…−20%; sequential −5.7…−7.1%; compute −16.5…−21% | resident −21.0…−21.2%; sequential −11.6…−12.2% | ✅ Supported |
| **H3** early exit, bytes | single cold request: −40…−63% (E1 exit), −9…−20% (E2 exit), **+1.8…+7% (full path)**; ≈ 0 over a cached session | not measured (no server log on the Mac) | ⚠️ **Partly supported** |
| **H3** early exit, accuracy | −0.11 / −0.23 / −0.34 pt; McNemar p ≥ 0.55 | device-independent (identical logits) | Loss quantified; **not significant** |
| **H4** mixed precision | mixedC2 on the accuracy-vs-bytes Pareto front; C2 fp32 recovers 77.8%; **C0 fp32 lowers accuracy**; mixed vs int8 p = 0.14, int8 vs fp32 p = 0.064 | device-independent | ⚠️ **Descriptive only**, not significant |
| **H5** cache | ×1.16–1.34 (localhost) to ×52–78 (5 Mbit/s); 0 bytes; 100% hits | — (no throttled network on the Mac) | ✅ Supported |
| **H6** int8 batch dependence | real on every platform (10–22 / 872 flips; fp32 0); **no growth with batch size; sorting doesn't help**; composition moves accuracy up to 1.6 pt | — (CPU-kernel property; native aarch64 = your Mac's Linux sandbox, in the cloud report) | ⚠️ **Partly supported** |
| **F-5** native vs WASM | aarch64 1.20.1: 1 flip (reproduces F-5); x86-64 1.20.1: 0 flips; x86-64 1.29.0: 4 flips; none significant | (aarch64 row) | Reported per platform |
| **Engine:** memory | 0 / 200 underestimates | 0 / 180 underestimates | ✅ Safe on both |
| **Engine:** time | warm resident / sequential −2.7 / −6.2%; pre-start / pinned **−28…−52%**; cold resident +24% | warm sequential +0.6%, resident +5.3%; pre-start / pinned **−15…−29%**; cold resident **+124%** | ⚠️ **Same pattern on both; machine-dependent size** |
| **Engine:** regret | 10 / 12 decisions rank 1 (0%); **mid profile, early exit off: rank 4 / 6, regret 24% warm / 43% cold** | 12 / 12 rank 1 (0%) **among each decision's top-4 predicted plans** (narrower set; the cloud's best mid plan was not measured on the Mac) | ⚠️ Criterion **not met** in the cloud; not tested on the Mac with the same set |
| **E-F28** creation | (b) / (e) −56…−70% vs (a); (c), (d) ≈ (a) | (b) −64.7% vs (a) (same-tab protocol) | ✅ Supported |
| **F-13 / F-43** int8 vs fp32 speed | int8 faster (1 thread) | **int8 never faster** (9–19% slower at 1 / 2 / 8 threads, equal at 4); 8 threads slower than 4 | Device-dependent: int8's Mac benefit is size / memory |

## 7. Validation summary

| Stage | Checks | Result |
|---|---|---|
| Pilot | throttle ±5%, determinism, probe vs browser measurement, CPU throttling | passed / dropped as decided |
| Steps 1–13 | per-block validator (counts, errors, references, cache, bytes, origin, determinism) | **13 / 13 valid**, 0 failures |
| Step 14 original | same + CPU stability | MAC-1 valid; **MAC-2 timing NOT valid** (stopped and reported) |
| Step 14 re-run | same + foreground guard + absolute CPU check | **valid** |
| Report numbers | every table generated by the analysis scripts from raw files; hand-written summaries cross-checked (5 cloud + 1 Mac wording errors found and fixed) | ✅ |

## 8. Issues, deviations and remaining limitations

**Problems found and fixed during the phase (all disclosed in the sub-reports):**

| # | Problem | Fix |
|---|---|---|
| P-1 | Throttle server stalled < 5.24 Mbit/s | Fixed (Phase 4 unaffected) |
| P-2 to P-5 | Pilot harness bugs | Fixed |
| S-1 | 28 GB of temporary browser profiles filled the disk | Each run's profile is deleted after the run |
| S-2 | Random port made warm caches look empty (F-36) | Fixed before any suite run |
| S-3 to S-6 | Harness details | Fixed |
| — | Two validator changes, both disclosed | Mac cache-off criterion; refit target set |
| I-7.11 | **My concurrent aarch64 runs during your first Mac run** | Re-run on an idle Mac |
| I-7.10 | First Mac run's **MAC-2 slowdown** | Re-run with the foreground guard |

**Remaining limitations (to state in the final report):**

1. **Two machines, not a CPU experiment.** Cloud vs Mac differ in OS, browser build, headless vs headed, and protocol (process vs tab reload). Simulated CPU throttling can't reach Workers (F-33).
2. **The Mac protocol keeps compiled WASM across reloads** (F-37), so Mac creation and cold-start times aren't comparable with the cloud's.
3. **Engine time model:** 15–52% optimistic for pre-start / pinned plans, and pessimistic for cold resident plans (+24% cloud, +124% Mac). The tested three-parameter refit only moves the error between shapes (not recommended), so **a cost term is missing**, not identified. **The engine is unchanged; any change needs your approval.**
4. **Mac regret** was measured on a narrower plan set than the cloud's; the mid-profile regret is confirmed only in the cloud.
5. **Statistical power:** n = 872 can't separate the precision settings (int8 vs fp32 p = 0.064) or the early-exit loss; n = 5 timing reps give wide CIs for some cells (e.g. Mac int8 4-thread M4 [16.75, 24.06]).
6. **Single model / task / data set** (DistilBERT-SST2); the cost model and accuracy table are model-specific (I-6.1). τ was tuned on dev; validation is used only for reporting.
7. **Network:** a token-bucket server on localhost (+3.2% at 50 Mbit/s; first-byte delay 20 ms), not a real network. **fp32 at 5 Mbit/s omitted** (decision 4). No throttled network on the Mac.
8. **Memory probe** sees WASM heaps only (JS heaps +4–10 MiB, from the UA spot checks). Pre-start plans are reported with a lower and an upper bound.
9. **Unexplained single observations kept:**
   - **I-4.8** (Mac fp32 F4 network loads; narrowed to a 9–12 s window)
   - **F-14** (not reproduced)
   - **fp32 baseline 11.1 s TTFI** (pilot, not reproduced)
   - **the first Mac run's 6–17× slowdown** (cause not determined)
10. **Native int8 results depend on CPU and ORT version** (F-34). Only WASM is portable; native conclusions hold per platform.
11. **No real low-memory device**; profiles impose memory only as an engine budget.

## 9. Files

**Harness (new):**

- `bench/phase7/`: `runner.html`, `runner.js`, `lib.mjs`, `cdp.mjs`, `cpu.html`, `busyWorker.js`, `workload.mjs`, `pilot.mjs`, `suite.mjs`, `validate.mjs`, `offline.mjs`, `node_wasm.mjs`, `native_eb.py`, `analyze.mjs`, `eng_traces.mjs`, `analyze_mac.mjs`, `mac.js`, `mac_selftest.mjs`, `mac_selftest2.mjs`
- `bench/phase7-mac.html`

**Changed:**

- `bench/throttledServer.mjs` (P-1)
- `bench/configs.json` (new configurations)

**Results:**

- `results/phase7/{acc,e1,f28,eng,e3bytes,netcheck,net,e5x,g1,ebrowser}/`
- `results/phase7/{wasm,native-x86-ort1.20.1,native-x86-ort1.29.0,native-arm64-ort1.20.1}/`
- `results/phase7/mac/` (both Mac runs + MAC-5)
- `results/phase7/pilot/`, `results/phase7/_smoke/` (not results)
- `results/phase7/summary/{analysis,analysis_mac,analysis_mac_final}.json`
- `results/phase7/workload_100.json`

**Docs:**

- this report
- `PHASE_7_RESULTS_REPORT.md`, `PHASE_7_MAC_RESULTS.md`, `PHASE_7_PILOT_REPORT.md`
- `PHASE_7_EXPERIMENT_PLAN.md`, `PHASE_7_EXECUTION_CHECKLIST.md`
- `FINDINGS.md` (F-33–F-43), `PROGRESS_TRACKER.md`

## 10. Outcome and next phase

Phase 7 produced a complete, validated evidence base:

- **Supported:** 3 hypotheses (H1, H5, E-F28) and H3's latency part.
- **Unsupported, in whole or part (kept):**
  - H2 for time to first result
  - H3's byte and accuracy claims
  - H4's significance
  - two of H6's three claims
  - the engine's regret criterion for the mid profile
- **Engine:** memory is safe on both machines, but the time model has a confirmed, unexplained optimism.

**Your decisions (1 Nov 2026):**

1. Phase 7 approved.
2. The time-model issue (I-5.1 / F-39) is **future work**; not investigated, engine unchanged.
3. Commit after you review the proposed contents.
4. Development is then frozen.

**Next: Phase 8**, the final report and VIVA preparation (planned 28–30 Nov), which will use these results as written, including the negative ones.
