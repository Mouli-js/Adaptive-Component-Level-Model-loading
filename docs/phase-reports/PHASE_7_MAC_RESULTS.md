# Phase 7: Mac Results (Step 14, MAC-CHROME-*). Final. Kept separate from the cloud results

**Date:** 1 Nov 2026 · **Status: VALID.** MAC-1 and MAC-5 come from the original run; MAC-2 / MAC-3 / MAC-4 come from the re-run.
**Device:** Apple Silicon Mac, `hardwareConcurrency` 8, `deviceMemory` 16, Chrome 155, cross-origin isolated, `http://localhost:8080`.
**Analysis:** `node bench/phase7/analyze_mac.mjs <original> --rerun <re-run>` → `results/phase7/summary/analysis_mac_final.json`. The original-only analysis is kept in `analysis_mac.json`.

| Run | File | Used for | Status |
|---|---|---|---|
| Original, 03:36–04:39 UTC | `results/phase7/mac/f7d83e4b-phase7_mac_2026-11-01T03-36-18-093Z.json` (283 steps) | **MAC-1** | MAC-1 valid. **Its MAC-2 timing is invalid** (§5): Worker compute 6–17× slower from 03:51:37 UTC; MAC-3 / MAC-4 overlapped my aarch64 runs. **Kept in full, not used for MAC-2 / 3 / 4.** |
| MAC-5, 05:25 UTC | `results/phase7/mac/mac5_diag_fetch_transcribed.json` (your paste) | **MAC-5** | Valid |
| Re-run, 10:43–10:58 UTC | `results/phase7/mac/dcc9af05-phase7_mac_2026-11-01T10-43-02-746Z_only-MAC-2-MAC-3-MAC-4.json` (235 steps) | **MAC-2, MAC-3, MAC-4** | **Valid** |

## 1. Validation of the combined data (all checks pass)

| Check | Result |
|---|---|
| Original run complete (283 / 283); re-run complete (235 / 235), not quick mode, `only` = MAC-2, MAC-3, MAC-4 | ✅ |
| Re-run contains no MAC-1 rows (MAC-1 preserved) | ✅ |
| **Foreground guard:** every re-run row ran with the page visible from start to end, with 0 visibility changes | ✅ 0 pauses, 0 anomalous rows |
| No failed or interrupted steps; one origin | ✅ |
| **Outputs = reference** in every run (268 runs) | ✅ |
| MAC-1 thread counts as intended; latency consistent across reps (worst max / min 1.44) | ✅ |
| Cache off (MAC-1 / MAC-3): store unused, i.e. entry count unchanged and every load from the network | ✅ (8 → 8 original, 6 → 6 re-run) |
| MAC-4: primed cache (10 entries), bytes from IndexedDB | ✅ |
| MAC-2: warm = 10 entries and all from IndexedDB; cold = 0 entries and all from the network; one calibration | ✅ |
| **Expected repetitions:** MAC-1 48, MAC-3 40, MAC-4 10, MAC-2 18 plans × 5 × 2 = 180 | ✅ |
| **CPU stability, relative:** 0 / 180 MAC-2 runs above 2× the first 20 | ✅ |
| **CPU stability, absolute:** MAC-2 max 100.0 ms, MAC-3 max 56.1 ms (≤ 150 ms) | ✅ |
| No concurrent load from me: re-run 10:43–10:58; my last action on your Mac was 10:26 | ✅ |

Notes:

- **Compute speed was flat through the whole re-run** (median per quarter 53.6 / 53.2 / 53.4 / 53.4 ms). The highest values (≈ 100 ms) all belong to the int8 sequential G = 1 plan, whose every sentence runs in a fresh Worker (first-run warm-up, F-29) in every repetition.
- **Browser archive empty:** the re-run's "archived earlier runs" list is empty. No earlier run was stored in the browser when you clicked Start (browser data cleared, or another profile). The original run is preserved as its downloaded file.
- **Disclosed validator change (from the first analysis):** the cache-off check was changed from "store empty" to the plan's definition, "store unused".

## 2. MAC-1: thread sweep (F-13, F-43); original run, clean

Baseline, w100, single requests, median [95% CI]:

| Page threads | int8 M4 (ms) | fp32 M4 (ms) | int8 − fp32 |
|---|---|---|---|
| 1 | 55.72 [55.36, 56.44] | 50.83 [50.59, 52.25] | **+9.6%** [3.22, 5.72 ms] |
| 2 | 29.16 [28.94, 30.30] | 26.83 [26.59, 28.26] | **+8.7%** [0.90, 3.47] |
| 4 | 16.89 [16.75, 24.06] | 17.47 [17.03, 18.57] | −3.3%, CI includes 0 |
| 8 | 30.31 [26.82, 35.58] | 25.38 [24.92, 26.99] | **+19.4%** [1.44, 10.20] |

- **int8 is never faster than fp32 on this Mac.**
- **8 threads is slower than 4** (int8 +79%, fp32 +45%).
- **Accuracy:** logits are identical at every thread count and equal to the cloud's.

## 3. MAC-3: policies / early exit (re-run)

| Plan | Peak MiB (= cloud?) | M4 ms, early exit off → on | Early-exit effect [CI] | TTFI ms off → on |
|---|---|---|---|---|
| resident int8 | 214.06 (=) | 54.99 → 43.31 | **−21.2%** [−13.37, −8.75 ms] | 502 → 430 |
| sequential G 32 int8 | 80.46 (=) | 90.80 → 79.70 (amort.) | **−12.2%** [−12.54, −10.40] | 891 → 676 |
| resident mixedC2 | 355.06 (=) | 53.88 → 42.59 | **−21.0%** [−13.13, −10.01] | 536 → 466 |
| sequential G 32 mixedC2 | 189.53 (=) | 90.28 → 79.82 (amort.) | **−11.6%** [−12.85, −7.43] | 938 → 721 |

- **F-27 holds on the Mac in all 8 configurations,** mixedC2 included: peaks are identical to the cloud's to the last digit.
- **Early exit lowers latency on the Mac too**, with every CI excluding 0. In the first run, sequential mixedC2's CI included 0; with clean conditions it doesn't.

## 4. MAC-4: creation states (re-run; same-tab protocol)

| State | Create ms, median [CI], n = 5 |
|---|---|
| (a) no other Worker | 177.3 [174.3, 186.2] |
| (b) another chunk Worker alive | 62.5 [60.9, 65.5] |
| (b) − (a) | **−114.7 [−123.7, −111.5] (−64.7%)** |

The same direction as the cloud's E-F28. The absolute values aren't comparable, because the page reloads one tab rather than starting a fresh process (F-37).

## 5. MAC-2: decision engine on the Mac (re-run)

**Calibration (measured once, idle Mac):**

- spawn 13.3 ms
- create base 50.2 ms warm / 174.7 ms cold, 0.37 ms / MiB
- C1 compute: int8 20.7 ms vs fp32 18.0 ms. int8 is slower than fp32 here, matching F-43.

### 5.1 Decisions vs the cloud's (same profiles, Mac calibration)

| Profile | Early exit | Mac choice (warm and cold) | Cloud choice |
|---|---|---|---|
| low | off / on | int8 sequential G 32 | same |
| mid | off | mixedC2 sequential G 32 + pre-start | same |
| **mid** | **on** | **mixedC2 sequential G 32 + pre-start + early exit** | **mixedC2 resident + early exit** (the near-tie of F-35) |
| high | off / on | fp32 resident | same |

### 5.2 Memory

**0 / 180 runs exceeded the prediction**, checked against the probe and the upper bound. Without the margin, 10 of 18 plans are predicted exactly; 8 are over-predicted (pre-start, pinned or early-exit plans, as in the cloud).

### 5.3 Time: prediction error by plan shape (median [CI], negative = optimistic)

| Shape | Warm | Cold |
|---|---|---|
| sequential | **+0.6%** [−9.4, 5.6] | **−1.9%** [−13.3, −1.3] |
| resident | +5.3% [3.6, 7.1] | **+124.0%** [119.7, 124.3] (pessimistic) |
| sequential + pre-start | −15.0% [−32.3, −10.2] | −22.7% [−40.8, −21.2] |
| hybrid | −19.6% [−24.0, −15.3] | −29.2% [−31.7, −27.0] |
| hybrid + pre-start | −17.8% [−20.8, −16.4] | −28.4% [−29.0, −26.4] |

The **same pattern as the cloud** (F-39) on an 8-core real device:

- plain sequential and resident are accurate when warm
- every pre-start or pinned shape is 15–29% optimistic
- the cold resident prediction is far too pessimistic

The optimism is **smaller than in the cloud** (cloud −28…−52%), so part of it depends on the machine. It is **not** only 2-vCPU contention.

### 5.4 Regret and rank (profile weights on measured M, T, L)

| Decision | Chosen = measured best? | Regret | Spearman ρ (pred vs measured) |
|---|---|---|---|
| all 12 (3 profiles × early exit × warm / cold) | **yes, rank 1 in every case** | **0%** | 0.2–1.0 |

**Important limitation:** on the Mac each decision's measured set was **its top 4 plans by predicted cost**. The cloud also measured the best plan of every family. **mixedC2 resident, the cloud's measured best for the mid profile, was not measured on the Mac.** So "regret 0%" on the Mac means "best among the four plans the engine itself ranked highest". It does not show the Mac would avoid the cloud's mid-profile regret (24–43%), and it does not contradict it either.

## 6. MAC-5: F-14 fetch diagnostic (unchanged)

- **The original F-14 (int8 fetch 736 ms > fp32 548 ms) did not reproduce.** int8 was faster in all 6 rounds (70–241 vs 196–356 ms) and in the Phase 2 replay.
- **What reproduces:** int8's byte rate is lower in all 6 rounds (1.1–3.7×).
- F-14 stays an unexplained single observation.

## 7. The first run's invalid MAC-2 data (kept, not used)

- **What went wrong:** from 03:51:37 UTC to the end, compute inside the Workers ran 6–17× slower in all 135 remaining MAC-2 runs. The cause is not determined; you didn't confirm whether the window was hidden or the display slept.
- **A second, smaller confound:** my aarch64 native runs (03:46–04:10) overlapped MAC-3 / MAC-4 and the calibration, making MAC-3 2.4–7.5% slower.
- **Cross-check against the re-run:** the first run's 45 pre-slowdown MAC-2 runs showed the same optimism pattern (indicative only). Its decisions agree with the re-run's in 12 / 12 cases.
- **Preserved:** all of it is in the original file and `analysis_mac.json`.
