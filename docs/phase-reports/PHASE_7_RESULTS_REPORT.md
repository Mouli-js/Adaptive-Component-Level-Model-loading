# Phase 7: Results Report (final)

**Date:** 1 Nov 2026 · **Plan:** v1.2 · **Status:** **FINAL. Phase 7 approved 1 Nov 2026.** All results, CIs, validation outcomes, unsupported hypotheses, unexplained observations and limitations retained as accepted.

**Structure:** this report has two parts that are **never combined or averaged**.

- **Part A (§1–§12):** cloud + offline (Steps 1–13).
- **Part B (§13):** Mac (Step 14), in its own tables.
- **§14–§17:** validation outcomes, verdicts side by side (cloud and Mac in separate columns), limitations, and the raw-data index.
- **Completion report:** `PHASE_7_REPORT.md`. The Mac detail is also in `PHASE_7_MAC_RESULTS.md`.
**Raw data:** `results/phase7/<block>/runs.jsonl`, `results/phase7/{wasm,native-*}/`. Analysis: `results/phase7/summary/analysis.json`, produced by `bench/phase7/analyze.mjs` from the raw files only.
**Configurations:** `CLOUD-HL-1T` / `CLOUD-HL-1T-NET-*` (x86-64, 2 vCPU, Chromium 153, one browser process per run), `NODE-WASM-X86`, `NATIVE-X86-ORT1.20.1`, `NATIVE-ARM64-ORT1.20.1` (your Mac's Linux sandbox), `NATIVE-X86-ORT1.29.0` (supplementary). **Part A contains no Mac browser results**; Part B contains only Mac browser results (`MAC-CHROME-T1/T2/T4/T8`, `MAC-CHROME-W1`, `MAC-CHROME-4T`).

**Statistics:** median, with a [bootstrap 95% CI] (10,000 resamples) unless stated. "Δ" is a difference of medians with its CI. n = 5 per timing configuration. Accuracy pairs use an exact McNemar test.

---

# Part A: Cloud + offline (CLOUD-HL-1T*, NODE-WASM-X86, NATIVE-*)

## 1. Execution summary

| Step | Block | Runs | Gate | Result |
|---|---|---|---|---|
| 1 | native x86-64 (1.20.1 + 1.29.0) | 82 passes | files, no failures | ✅ (= pilot hashes) |
| 2 | native aarch64 1.20.1 | 77 passes | batch-1 = Phase 1 file | ✅ max Δ 5.0e-7 |
| 3 | WASM (E4 + E-B + F-5) | 90 passes | batch-1 hash = browser | ✅ `1b4238…` |
| 4 | acc | 12 | determinism, Δ = 0 | ✅ VALID |
| 5 | ebrowser | 2 | browser = Node | ✅ VALID |
| 6 | e1 | 100 | cache off, outputs = ref, UA | ✅ VALID |
| 7 | f28 | 400 | identical primed cache | ✅ VALID |
| 8 | eng | 200 | warm 10 entries / 0 bytes; cold 0 | ✅ VALID |
| 9 | e3bytes | 270 | cold, exit path | ✅ VALID |
| 10 | netcheck | 4 | ±5% | ✅ +3.24 / +1.26 / +0.64 / +0.10% |
| 11 | net | 200 | cold / revisit / origin | ✅ VALID |
| 12 | e5x | 120 | same | ✅ VALID |
| 13 | g1 | 2 | warm copy | ✅ VALID |

**Totals:**

- **Rows:** 1,310 browser rows plus 249 offline passes. **0 failed runs**, 0 retries.
- **Output check:** every one of the 904 rows that carry one passed (int8 Δ = 0, fp32 / mixed < 1e-4, identical exit points).
- **Wall clock:** 6.0 h (estimate 5.8 h + 20 min).
- **Unchanged:** engine, package, baseline and demo. Nothing has been committed.

## 2. Verdicts against the pre-registered predictions (Part A; the side-by-side table with the Mac is §15)

| H | Prediction (plan §6) | Result | Verdict |
|---|---|---|---|
| **H1** memory policies | Supported | sequential < chain < baseline at every precision, identical in all 5 reps; time to first inference +50–72% vs resident | ✅ **Supported** |
| **H2** pre-start lowers TTFI | Not supported for TTFI | TTFI Δ CI includes 0 in 6 / 8 cells; in 1 cell pre-start is **slower** (+5.7%). Workload −18 to −27% (CI excludes 0 in all 8). Memory +18–33% (probe) / up to +67% (bound). | ❌ **Not supported** (TTFI); throughput benefit found |
| **H3** early exit: latency / compute | Latency: small benefit | resident −19 to −20%, sequential −5.7 to −7.1%; compute −16.5 to −21% (CIs exclude 0) | ✅ Supported (larger than the pilot suggested) |
| **H3** early exit: bytes | Lower for early exits, higher for full path | single cold request: −40% to −63% (E1 exit), −9% to −20% (E2 exit), **+1.8% to +7% (full path)**; pre-start cuts the saving; **≈ 0 over a cached session** | ⚠️ **Partly supported**: only for single cold requests that exit early |
| **H3** early exit: accuracy | −0.11 to −0.35 pt | −0.11 / −0.23 / −0.34 pt; McNemar p = 1.00 / 0.63 / 0.55 | Quantified; the loss is **not statistically significant** |
| **H4** mixed precision | Supported; C2 best | mixedC2 is on the accuracy-vs-bytes Pareto front; C2 fp32 recovers 77.8% of the gap (best single chunk) | ✅ Supported **descriptively**; ⚠️ **not significant** (mixed vs int8 p = 0.14; even int8 vs fp32 p = 0.064) |
| **H5** cache | Supported | ×1.16–1.34 (localhost) up to ×52–78 (5 Mbit/s); 0 bytes and 100% hits on every revisit | ✅ **Supported** |
| **H6** int8 batch dependence | Grows with batch / padding; sorting reduces it; fp32 invariant | batch dependence confirmed (10–22 flips; fp32 ≤ 1.1e-5, 0 flips), **but it does not grow with batch size and sorting does not reduce it** | ⚠️ **Partly supported**; two sub-claims **not supported** |
| **Engine** | regret ≤ 10%, top 3, 0 memory underestimates | 0 / 200 memory underestimates; 10 / 12 decisions regret 0%; **mid profile (no early exit): rank 4 / 6, regret 24% warm / 42.9% cold** | ⚠️ **Not met for the mid profile** |
| E-F28 hypothesis | Creation is fast while a compiled ORT WASM instance is alive | (b) and (e) −56 to −70% vs (a); (c) and (d) ≈ (a) | ✅ **Supported** |

## 3. E1: memory policies (H1)

Cache off, w100, CLOUD-HL-1T. **Peak memory was identical in all 5 repetitions of every configuration.** Peak total = WASM + waiting hidden states (F-21). M4 is single-request latency for sentence-major policies and amortised time per sentence for chunk-major ones (D-7.2).

| Policy | Precision | Peak total MiB | vs baseline | vs chain | TTFI ms | M4 ms | Worker starts |
|---|---|---|---|---|---|---|---|
| baseline | int8 | 180.25 | — | +62.1% | 760 [717, 868] | 42.07 [41.13, 43.88] | — |
| chain in page | int8 | 111.19 | **−38.3%** | — | 874 [826, 896] | 42.14 [41.79, 42.22] | — |
| resident | int8 | 214.06 | **+18.8%** | +92.5% | 1,232 [1,183, 1,285] | 44.91 [44.12, 45.77] | 4 |
| hybrid (pin C0, G 32) | int8 | 126.84 | −29.6% | +14.1% | 1,230 [1,226, 1,275] | 70.17 [69.14, 70.95] (amort.) | 16 |
| sequential G 32 | int8 | **80.46** | **−55.4%** | −27.6% | 2,119 [2,044, 2,196] | 133.03 [132.27, 135.14] (amort.) | 20 |
| chain in page | mixedC2 | 226.75 | n/a | — | 967 [942, 1,051] | 47.99 [47.24, 50.03] | — |
| resident | mixedC2 | 355.06 | n/a | +56.6% | 1,378 [1,318, 1,412] | 53.28 [50.48, 55.53] | 4 |
| hybrid | mixedC2 | 266.71 | n/a | +17.6% | 1,356 [1,223, 1,418] | 79.19 [76.01, 81.98] | 16 |
| sequential G 32 | mixedC2 | **189.53** | n/a | −16.4% | 2,206 [2,067, 2,274] | 140.03 [137.70, 142.00] | 20 |
| baseline | fp32 | 656.38 | — | +62.7% | 1,347 [1,287, 1,525] | 65.88 [64.46, 67.49] | — |
| chain in page | fp32 | 403.44 | **−38.5%** | — | 1,385 [1,163, 1,574] | 67.84 [63.17, 69.17] | — |
| resident | fp32 | 813.31 | **+23.9%** | +101.6% | 1,804 [1,585, 1,904] | 68.71 [67.46, 70.99] | 4 |
| hybrid | fp32 | 469.65 | −28.4% | +16.4% | 1,860 [1,784, 1,938] | 100.48 [99.92, 102.05] | 16 |
| sequential G 32 | fp32 | **283.40** | **−56.8%** | −29.8% | 2,705 [2,587, 2,907] | 164.41 [160.32, 169.89] | 20 |

**Latency cost of sequential vs resident (TTFI):** int8 +887 ms [809, 1,003] (+72%), mixedC2 +827 [689, 898] (+60%), fp32 +901 [728, 1,120] (+50%).

**UA spot checks:** the browser's own measurement was always above the probe, by 4.2–10.2 MiB (JS heaps; for example resident int8: 224.28 vs 214.06). This confirms F-8 / F-17 / F-18 / F-21 under the Phase 7 protocol.

## 4. E3: early exit (H3), three separate verdicts (decision 1)

### 4.1 Accuracy (872 sentences; determinism confirmed: identical hashes in 2 processes for all 6 settings)

| Precision | Off | On (τ 0.95) | Δ pt | McNemar (off-right/on-wrong : off-wrong/on-right), p | Exit at E1 / E2 / full |
|---|---|---|---|---|---|
| int8 | 90.02% | 89.91% | −0.11 | 3 : 2, p = 1.00 | 150 / 209 / 513 (41%) |
| mixedC2 | 90.83% | 90.60% | −0.23 | 3 : 1, p = 0.63 | 150 / 219 / 503 (42%) |
| fp32 | 91.06% | 90.71% | −0.34 | 7 : 4, p = 0.55 | 175 / 209 / 488 (44%) |

**τ trade-off on dev** (where τ was chosen; rule: smallest τ with agreement ≥ 0.99):

| τ | 0.80 | 0.90 | 0.95 (chosen) | 0.98 | 0.99 |
|---|---|---|---|---|---|
| Agreement with full model | 0.955 | 0.978 | 0.991 | 0.998 | 0.998 |
| Exit at E1 / E2 | 62.7% / 25.6% | 40.3% / 36.3% | 23.8% / 40.2% | 10.8% / 36.8% | 5.7% / 32.0% |

### 4.2 Latency and compute (same randomised block as E1)

| Plan | Precision | M4 off → on | Δ [CI] | Compute per sentence off → on | Δ [CI] |
|---|---|---|---|---|---|
| resident | int8 | 44.91 → 36.39 ms | −8.51 [−9.91, −5.22] (−19.0%) | 44.59 → 35.68 | −8.91 [−9.92, −7.93] (−20.0%) |
| resident | mixedC2 | 53.28 → 43.38 | −9.90 [−12.15, −6.77] (−18.6%) | 51.65 → 41.05 | −10.60 [−13.23, −7.68] (−20.5%) |
| resident | fp32 | 68.71 → 54.66 | −14.04 [−17.01, −10.41] (−20.4%) | 68.22 → 53.78 | −14.44 [−17.06, −11.38] (−21.2%) |
| sequential G 32 | int8 | 133.03 → 125.43 (amort.) | −7.60 [−14.43, −5.16] (−5.7%) | 53.93 → 45.04 | −8.89 [−10.74, −7.29] (−16.5%) |
| sequential G 32 | mixedC2 | 140.03 → 131.94 | −8.09 [−15.51, −5.35] (−5.8%) | 58.12 → 47.86 | −10.26 [−11.37, −8.80] (−17.7%) |
| sequential G 32 | fp32 | 164.41 → 152.74 | −11.67 [−17.33, −7.58] (−7.1%) | 64.30 → 52.94 | −11.36 [−15.19, −10.19] (−17.7%) |

- **Exited vs full-path requests (resident, early exit on):** int8 30.11 vs 42.96 ms; mixedC2 37.17 vs 46.84 ms; fp32 40.42 vs 68.43 ms.
- **No memory cost:** early exit added no WASM memory (peaks identical on and off).
- **Smaller gain in sequential plans:** reloads dominate their time.

### 4.3 Bytes (270 cold single-sentence requests; G 1, nothing pinned; 10 sentences per exit class; deterministic)

| Precision | Sentence exits at | Early exit off | On | On + pre-start |
|---|---|---|---|---|
| int8 | E1 | 67.30 MB | **40.50 (−39.8%)** | 57.15 (−15.1%) |
| int8 | E2 | 67.30 | 57.15 (−15.1%) | 72.04 (+7.0%) |
| int8 | full | 67.30 | **72.04 (+7.0%)** | 72.04 (+7.0%) |
| mixedC2 | E1 | 109.74 | **40.50 (−63.1%)** | 99.60 (−9.2%) |
| mixedC2 | E2 | 109.74 | 99.60 (−9.2%) | 114.48 (+4.3%) |
| mixedC2 | full | 109.74 | **114.48 (+4.3%)** | 114.48 (+4.3%) |
| fp32 | E1 | 267.90 | **154.45 (−42.4%)** | 213.54 (−20.3%) |
| fp32 | E2 | 267.90 | 213.54 (−20.3%) | 272.64 (+1.8%) |
| fp32 | full | 267.90 | **272.64 (+1.8%)** | 272.64 (+1.8%) |

- **Model check:** every one of the 270 byte counts equals the runtime model (chunks spawned + exit heads).
- **Request time:** an E1 exit with int8 takes 1,200 ms vs 2,490 ms with early exit off.
- **Session level** (with the persistent cache): C2 is fetched at the first sentence that doesn't exit at E1 (sentence #1 in dataset order) and C3 at the first full-path sentence (#3). From then on nothing is downloaded again. So over a session **the byte saving is ≈ 0, and the exit heads are an extra +4.7 MB**.
- In the G 32 workload of E1, the last group (4 sentences) exited entirely before C3 in every repetition, so there were 19 instead of 20 Worker starts. This is the only group-level byte saving observed.

## 5. E2: pre-start (H2) and the G = 1 measurement

Cold profile, sequential G 32; TTFI = first sentence; then the 100-sentence workload on the now-filled cache.

| Link | Precision | TTFI off → on (ms) | Δ TTFI [CI] | Workload off → on (ms) | Δ workload [CI] | Peak probe off / on | Upper bound off / on |
|---|---|---|---|---|---|---|---|
| unthrottled | int8 | 2,483 → 2,417 | −67 [−165, 54] (−2.7%) | 13,395 → 9,832 | **−26.6%** [−3,988, −3,140] | 80.46 / 94.90 | 77.2 / 122.5 |
| unthrottled | mixedC2 | 2,670 → 2,822 | **+152 [57, 286] (+5.7%)** | 14,436 → 11,329 | −21.5% [−3,806, −2,432] | 189.53 / 235.90 | 186.3 / 232.7 |
| unthrottled | fp32 | 3,809 → 3,816 | +7 [−149, 278] (+0.2%) | 17,880 → 14,700 | −17.8% [−4,588, −2,065] | 283.40 / 375.78 | 280.1 / 466.4 |
| 20 Mbit/s | int8 | 29,009 → 28,982 | −27 [−151, 97] (−0.1%) | 13,412 → 10,186 | −24.1% [−3,343, −2,818] | same | same |
| 20 Mbit/s | mixedC2 | 46,160 → 46,111 | −49 [−185, −13] (−0.1%) | 14,206 → 10,985 | −22.7% [−3,747, −2,805] | same | same |
| 20 Mbit/s | fp32 | 110,336 → 110,299 | −37 [−172, 58] (0.0%) | 17,899 → 14,268 | −20.3% [−4,381, −2,549] | same | same |
| 5 Mbit/s | int8 | 110,045 → 109,925 | −120 [−584, 22] (−0.1%) | 13,405 → 9,963 | −25.7% [−3,756, −2,966] | same | same |
| 5 Mbit/s | mixedC2 | 178,203 → 178,295 | +92 [−125, 195] (+0.1%) | 14,238 → 11,311 | −20.6% [−3,413, −2,511] | same | same |
| 5 Mbit/s | fp32 | *omitted (decision 4)* | | | | | |

**Verdict:**

- **TTFI:** H2 is **not supported**. The largest TTFI effect in either direction is under 6%, and at 20 and 5 Mbit/s it is ≤ 0.1%.
- **Throughput:** pre-start gives a clear benefit (−18% to −27%).
- **Memory:** it costs memory: the probe peak is +18–33%, and the upper bound for fp32 rises from 280 to 466 MiB (+67%).
- **G = 1 (indicative, n = 1, int8, warm):** 20 sentences took 44.8 s without and 43.4 s with pre-start (−3%), i.e. ~2.2 s per sentence either way.

## 6. E5: cache revisits (H5)

TTFI cold vs revisit (3 revisits × 5 reps per cell); revisits served 0 bytes with a 100% IndexedDB hit rate (M6 = 1.00) in **every** cell.

| Link | int8 cold → warm (×) | mixedC2 | fp32 |
|---|---|---|---|
| unthrottled | 2,483 → 2,142 ms, **×1.16** [1.11, 1.20] | 2,670 → 2,239, ×1.19 [1.13, 1.23] | 3,809 → 2,840, ×1.34 [1.28, 1.38] |
| 50 Mbit/s | 12,807 → 2,110, **×6.07** [5.93, 6.12] | 19,814 → 2,285, ×8.67 [8.52, 8.78] | 46,024 → 2,878, ×15.99 [15.90, 16.41] |
| 20 Mbit/s | 29,009 → 2,146, **×13.52** [13.33, 13.71] | 46,160 → 2,221, ×20.79 [20.60, 21.24] | 110,336 → 2,799, ×39.42 [38.34, 40.08] |
| 10 Mbit/s | 55,989 → 2,153, **×26.01** [25.75, 26.57] | 90,153 → 2,246, ×40.13 [39.46, 40.59] | 217,491 → 2,854, ×76.21 [75.44, 78.57] |
| 5 Mbit/s | 110,045 → 2,117, **×51.98** [51.15, 53.40] | 178,203 → 2,282, ×78.08 [77.12, 79.67] | *omitted (decision 4)* |

- **Speed-up vs link:** it grows roughly in proportion to 1 / bandwidth, as predicted. The 20 Mbit/s values reproduce F-23 (×12.8 / ×37.8 in Phase 4; now ×13.5 / ×39.4).
- **Warm time is dominated by Worker start + session creation:** 71–84% of a warm TTFI. This confirms F-22.

## 7. E4: mixed precision (H4): all 16 combinations (WASM, 872 sentences)

| Spec (C0 C1 C2 C3) | Accuracy | Flips vs fp32 / int8 | McNemar vs int8 p | vs fp32 p | MB | Resident heap MiB |
|---|---|---|---|---|---|---|
| f f f f (fp32) | 91.06% | 0 / 19 | 0.064 | — | 267.90 | 813.3 |
| **i i f i (mixedC2)** | **90.83%** | 12 / 17 | 0.143 | 0.774 | **109.74** | **355.0** |
| i i f f | 90.83% | 12 / 19 | 0.167 | 0.774 | 153.96 | 469.3 |
| f f f i | 90.83% | 2 / 21 | 0.189 | 0.500 | 223.69 | 699.0 |
| i f f f | 90.60% | 4 / 17 | 0.332 | 0.125 | 196.40 | 610.4 |
| f i f i, f i f f, f f i f | 90.48% | 11–23 / 16–28 | 0.45–0.57 | 0.23–0.41 | 181–225 | 558–672 |
| i f i i, i f i f, i f f i, f f i i | 90.37% | 6–24 / 19–29 | 0.65–0.71 | 0.03–0.31 | 110–181 | 355–558 |
| i i i f | 90.25% | 21 / 2 | 0.500 | 0.189 | 111.51 | 328.4 |
| i i i i (int8) | 90.02% | 19 / 0 | — | 0.064 | 67.30 | 214.1 |
| f i i f | 90.02% | 23 / 18 | 1.000 | 0.093 | 183.01 | 531.3 |
| **f i i i** | **89.91%** | 22 / 15 | 1.000 | 0.052 | 138.80 | 417.0 |

- **Pareto front:** accuracy vs bytes {int8, **mixedC2**, fp32}; accuracy vs resident heap {int8, iiif, mixedC2, fp32}.
- **Single fp32 chunk, share of the int8→fp32 gap recovered:**
  - C2: **77.8%** (+42.4 MB, +140.9 MiB)
  - C1: 33.3%
  - C3: 22.2%
  - C0: **−11.1%**, i.e. making the embedding fp32 *lowers* accuracy below all-int8. This is unexpected and preserved.
- **Browser cross-check:** the int8, mixedC2 and fp32 browser hashes equal the Node WASM hashes.
- **Caveat that must be stated:** at n = 872, **no precision difference is statistically significant at α = 0.05**, not even int8 vs fp32 (14 : 5 flips, p = 0.064). H4 holds as a Pareto statement about this validation set, not as a significant improvement.

## 8. E-B: batch dependence of dynamic int8 (F-6, mandatory)

Flips vs batch 1 (of 872) and accuracy. Shuffled = 5 seeds (median flips [range]; accuracy range). **The full and chain models are bit-identical in all 38 / 38 batched pairs on every platform**, so the table holds for both.

| Platform | Batch 1 | Batch 4: order / sorted / shuffled | Batch 8 | Batch 16 | Batch 32 |
|---|---|---|---|---|---|
| WASM (= browser; hash-checked at b1 and b32) | 90.02% | 18 / 15 / 13 [12–20] (89.79–90.48%) | 13 / 18 / 17 [12–20] (89.45–90.60%) | 16 / 18 / 14 [13–19] (89.22–90.60%) | 16 / 18 / 14 [13–19]; order 90.71% |
| native x86-64 ORT 1.20.1 | 90.02% | 16 / 12 / 14 [12–21] | 14 / 20 / 16 [12–20] | 16 / 20 / 16 [15–18] | 16 / 19 / 16 [11–17]; order 90.71% |
| native aarch64 ORT 1.20.1 | **90.14%** | 15 / 15 / 15 [14–20] | 13 / 17 / 16 [15–21] | 16 / 22 / 16 [15–19] | 10 / 13 / 17 [10–20]; order 90.37% |
| native x86-64 ORT 1.29.0 (suppl.) | 90.02% | — | — | — | order 16 flips; **89.79%** |
| **fp32 control** (all platforms) | 91.06% | **0 flips**, max \|Δ\| ≤ 1.1e-5 (exactly 0 on native x86) | 0 | 0 | 0 |

- **Confirmed:** int8 predictions depend on the batch, on every platform. Max |Δlogit| vs batch 1 is 2.4–3.5. fp32 is invariant.
- **Not supported:** "flips grow with batch size". Batch 4 already flips about as many sentences as batch 32 (10–22 throughout).
- **Not supported:** "length-sorted batches reduce flips". Sorted is equal or worse in 10 of 12 platform × batch cells.
- **Unexpected:** batch composition alone moves int8 accuracy by up to **1.6 pt** at a fixed batch size on one platform (native x86, batch 16: 89.33–90.94%; WASM batch 16: 89.22–90.60%).
- **Interpretation (hypothesis):** dynamic quantization takes *one* activation scale per tensor, so any batch > 1 mixes sentences into that scale. Padding is not the main driver.
- **Design rule for the README (supported):** "int8: use batch size 1 for reproducible predictions". The package already does this (F-6). The rule "or length-sorted batches" is **not** supported and will not be written.

## 9. F-5: native vs WASM, batch 1 (mandatory table)

| Native platform | Setting | Native | WASM | Flips | Mean \|Δ\| | Max \|Δ\| | McNemar p |
|---|---|---|---|---|---|---|---|
| **aarch64 ORT 1.20.1** (= original F-5) | full int8 | 90.14% | 90.02% | 1 | 1.82e-2 | 1.215 | 1.00 |
| | chain int8 | 90.14% | 90.02% | 1 | 1.82e-2 | 1.215 | 1.00 |
| | mixedC2 | 90.60% | 90.83% | 2 | 7.99e-3 | 0.981 | 0.50 |
| | fp32 | 91.06% | 91.06% | 0 | 8.9e-7 | 1.2e-5 | 1.00 |
| **x86-64 ORT 1.20.1** | full / chain int8 | 90.02% | 90.02% | 0 | 1.05e-2 | 0.619 | 1.00 |
| | mixedC2 | 90.71% | 90.83% | 1 | 3.93e-3 | 0.422 | 1.00 |
| | fp32 | 91.06% | 91.06% | 0 | 8.4e-7 | 8.7e-6 | 1.00 |
| x86-64 ORT 1.29.0 (suppl.) | full / chain int8 | 90.02% | 90.02% | 4 | 4.93e-2 | 2.193 | 1.00 |
| | mixedC2 | 90.48% | 90.83% | 3 | 1.62e-2 | 0.981 | 0.25 |

- **F-5 reproduced exactly on its original platform:** 1 flip (sentence 702), max Δ 1.21.
- **"Native vs WASM" depends on CPU architecture and ORT version** (F-34). WASM gives the same result everywhere it was run.
- **None of the native/WASM differences is statistically significant**; they are 0–4 flips of 872.

## 10. E-F28: session creation (400 creations, each in a fresh browser process)

Create time (ms), n = 40 per cell (4 chunks × 10):

| State | int8 | fp32 | vs (a) int8 / fp32 |
|---|---|---|---|
| (a) no other Worker | 393 [379, 406] | 440 [434, 447] | — |
| (b) another chunk Worker with a session | **118** [115, 121] | **193** [185, 201] | −276 [−287, −260] (−70%) / −247 (−56%) |
| (c) ORT's JS imported only | 394 [382, 402] | 445 [437, 448] | +1 [−16, 18] / +4 [−4, 12] |
| (d) other Worker just terminated | 377 [368, 393] | 431 [424, 440] | −16 [−31, 5] / −10 [−19, 1] |
| (e) live WASM instance, session released | **119** [114, 129] | **203** [195, 208] | −274 [−287, −257] (−70%) / −238 (−54%) |

**Verdict:** creation is fast **if and only if another Worker holds a live, instantiated ORT WebAssembly instance**. A session isn't needed (e ≈ b). Importing ORT's JS isn't enough (c ≈ a), and the effect ends when that Worker is terminated (d ≈ a). This supports the compiled-module-reuse hypothesis behind F-28 and explains why pinning and pre-start make reloads "warm". It also explains the Mac-page protocol difference (F-37).

## 11. E-ENG: decision-engine predictions and regret

One calibration (spawn 55.1 ms, warm create base 143.8 ms, cold 388.9 ms, 0.65 ms/MiB); 12 decisions; 20 plans × 5 reps × {warm, cold}; each run is exactly the planned 20-sentence request.

### 11.1 Memory

- **Underestimates:** 0 / 200 runs, checked against both the probe and the upper bound.
- **Without the 10% margin:** the prediction equals the measured peak for 12 of 20 plans (±0.1 MiB).
- **Over-predictions:** 8 plans are over-predicted by 6.7–66.5%. All of them are pre-start or early-exit plans, where the prediction is a deliberate worst case: the overlap Worker, and exit heads assumed loaded.
- **Timing changes the visible peak:** fp32 hybrid pin C0 + C1 measured 652.6 MiB cold but 813.3 MiB warm. The pre-start overlap becomes *visible* to the probe only when loads are fast. The upper bound (813.3) is the same in both.

### 11.2 Time: prediction error by plan shape (negative = optimistic)

| Shape | Warm | Cold |
|---|---|---|
| resident | **−2.7%** [−3.1, 0.9] | **+23.7%** [17.8, 30.6] (pessimistic) |
| sequential | −6.2% [−7.4, −2.4] | −19.5% [−22.8, −12.7] |
| sequential + pre-start | −28.7% [−33.9, −27.5] | −45.4% [−48.5, −42.2] |
| hybrid | −30.3% [−35.5, −24.4] | −40.4% [−44.3, −35.3] |
| hybrid + pre-start | −39.7% [−41.1, −37.4] | **−51.8%** [−53.4, −49.8] |

- **Accurate case:** plain resident and plain sequential plans are within single digits when warm. This confirms Phase 5.
- **Everything with pre-start or a pin set is 28–52% optimistic.** That is larger than F-32's −23…−35%, and the cold case is worse.
- **Cold predictions:** too pessimistic for resident plans and too optimistic for every other shape.

### 11.3 Decisions, rank and regret

Regret uses the profile's own weights on the measured M, T and L.

| Profile | Early exit | Chosen (both cache states) | Margin to #2 | Rank among measured | Regret warm / cold | Spearman ρ (pred vs measured cost) warm / cold |
|---|---|---|---|---|---|---|
| low | off / on | int8 sequential G 32 | 13.35% | 1 / 3 | 0% / 0% | 1.00 / 1.00 |
| **mid** | **off** | **mixedC2 sequential G 32 + pre-start** | 2.60% / 1.91% | **4 / 6** | **24.0% / 42.9%** | 0.43 / 0.54 |
| mid | on | mixedC2 resident + early exit | 0.31% / 0.91% | 1 / 8 | 0% / 0% | 0.83 / 0.71 |
| high | off / on | fp32 resident (early exit rejected: accuracy floor) | 9.32% / 9.95% | 1 / 6 | 0% / 0% | 0.94 / 0.83 |

- **Overall:** 10 of 12 decisions choose the best measured plan.
- **The failure is the mid profile without early exit.** The measured best is **mixedC2 resident**: the plan the engine chose in Phase 5 for single-sentence requests, and the one it picks here once early exit is on. The engine prefers sequential + pre-start only because its time for that shape is 28–45% optimistic: predicted 1,648 ms vs measured 2,297 ms warm / 3,019 ms cold. The cause is the same one as in §11.2, now with a measurable cost.
- **Cache state did not change any decision.** The engine's network term uses the *profile's* link, not localhost, so the cache only enters through the time and memory terms.

### 11.4 I-5.1 refit: proposal only, and the result is negative

- **Method:** a copy of the time formula with three parameters:
  - α, the realised share of the pre-start overlap
  - the create base for loads made warm by pre-start
  - the create base for loads made warm by a pinned Worker

  With the engine's values it reproduces the engine's 200 predictions **exactly** (max relative difference 0). Fit on reps 1–2, evaluate on reps 3–5.

| Shape (eval reps) | Engine | Fit A: all affected plans (α 0, 230 ms, 280 ms) | Fit B: pre-start / hybrid only (α 0.8, 380 ms, 520 ms) |
|---|---|---|---|
| resident warm / cold | −2.8% / +20.4% | **+12.8% / +33.0%** | **+41.3% / +56.0%** |
| sequential + pre-start warm / cold | −30.1% / −45.4% | +8.0% / −15.4% | +8.5% / −15.3% |
| hybrid warm / cold | −30.3% / −40.4% | −16.9% / −28.9% | +6.8% / −8.7% |
| hybrid + pre-start warm / cold | −40.2% / −52.6% | −14.2% / −30.9% | −2.9% / −21.2% |
| sequential (unaffected) | −6.4% / −20.7% | unchanged | unchanged |

**Conclusion:** the shared "warm because a pinned Worker is alive" term also governs resident plans. Any refit that fixes pre-start and hybrid plans breaks the resident plans, which are currently the best-predicted shape. Fit A even sets α = 0: no modelled overlap is realised on this 2-vCPU machine (CPU contention is a plausible cause, not verified).

So the error comes from a cost the model **doesn't contain**, not from badly set parameters. **Neither fit is applied.** The engine is unchanged (condition 1). **By your decision (1 Nov), the time-prediction model is not investigated further and is recorded as future work.** The Mac data (§13.4) shows the same pattern on an 8-core device.

## 12. Deviations and unexpected findings (all preserved)

| # | Finding | Where |
|---|---|---|
| U-1 | **H2 fails for TTFI**; in one cell pre-start is slower (+5.7%) | §5 |
| U-2 | **H6 sub-claims fail:** flips don't grow with batch size; sorting doesn't help; composition alone moves accuracy by up to 1.6 pt | §8 |
| U-3 | **C0 fp32 lowers accuracy below all-int8** (−11% gap "recovery") | §7 |
| U-4 | **No precision difference is significant at α = 0.05** (int8 vs fp32 p = 0.064) | §7 |
| U-5 | **Early-exit accuracy loss is not significant** (p ≥ 0.55); latency gain −19…−20% is larger than the pilot's 20-sentence look suggested (pilot: −2%) | §4 |
| U-6 | **Early exit costs bytes for full-path sentences** (+1.8–7%) and saves ≈ 0 over a cached session | §4.3 |
| U-7 | **Engine regret 24–43% for the mid profile**; time-model errors up to −52% for hybrid + pre-start | §11 |
| U-8 | **The refit is a trade-off, not a fix**: it would degrade resident predictions | §11.4 |
| U-9 | **Cold-time predictions are pessimistic for resident plans (+24%)** but optimistic for every other shape | §11.2 |
| U-10 | **The visible memory peak of a pre-start plan depends on load speed** (652.6 vs 813.3 MiB, same plan); the upper bound is stable | §11.1 |
| U-11 | **Native int8 differs by platform and ORT version**; the aarch64 platform reproduces F-5 exactly | §9 |
| U-12 | **Creation is fast only while a live WASM instance exists elsewhere** | §10 |
| U-13 | **Throttle bias at 50 Mbit/s (+3.2%)** inflates 50 Mbit/s cold times slightly; within the gate | §1 |
| D | Approved deviations applied: D-7.1 (E1 cache off), D-7.2 (two M4 forms), D-7.3 (accuracy per precision), D-7.4 (one calibration), D-7.5 (first-byte delay 20 ms), D-7.6 (native per platform), D-7.7 (UA spot checks). Omitted: fp32 at 5 Mbit/s (decision 4); simulated CPU throttling (F-33). | plan v1.2 |

# Part B: Mac (MAC-CHROME-*, Apple Silicon, 8 cores, Chrome 155, `http://localhost:8080`)

**Sources:**

- MAC-1 from the original run (`f7d83e4b-…03-36-18…json`, 283 steps)
- MAC-5 from your pasted diagnostic (`mac5_diag_fetch_transcribed.json`)
- MAC-2 / 3 / 4 from the **re-run** (`dcc9af05-…10-43-02…_only-MAC-2-MAC-3-MAC-4.json`, 235 steps)

The original run's MAC-2 / 3 / 4 rows are **kept but not used** (§13.6).

**Protocol differences from the cloud:** one tab reloaded per run (not one process per run), headed Chrome, localhost without throttling, no server byte log. **Creation and cold-start times are therefore not comparable with Part A** (F-37).

## 13. Mac results

### 13.1 MAC-1: thread sweep (F-13, F-43); original run, before any overlap

Baseline, w100, single requests, median [95% CI], n = 5:

| Page threads | int8 M4 (ms) | fp32 M4 (ms) | int8 − fp32 [CI] | TTFI int8 / fp32 (ms) | Peak MiB int8 / fp32 |
|---|---|---|---|---|---|
| 1 | 55.72 [55.36, 56.44] | 50.83 [50.59, 52.25] | +4.89 [3.22, 5.72] (+9.6%) | 165 / 376 | 180.25 / 656.38 |
| 2 | 29.16 [28.94, 30.30] | 26.83 [26.59, 28.26] | +2.33 [0.90, 3.47] (+8.7%) | 209 / 564 | 180.63 / 656.75 |
| 4 | 16.89 [16.75, 24.06] | 17.47 [17.03, 18.57] | −0.58 [−1.68, 6.58] (CI includes 0) | 184 / 632 | 181.50 / 657.50 |
| 8 | 30.31 [26.82, 35.58] | 25.38 [24.92, 26.99] | +4.94 [1.44, 10.20] (+19.4%) | 168 / 600 | 183.13 / 659.06 |

- **int8 is never faster than fp32 on the Mac.**
- **8 threads is slower than 4** (int8 +79%, fp32 +45%).
- **Accuracy:** logits are identical at every thread count and equal to Part A's hashes (`1b4238…` int8, `c4b44b…` fp32).

### 13.2 MAC-3: policies and early exit (re-run)

| Plan | Peak MiB (= Part A?) | M4 off → on (ms) | Early-exit Δ [CI] | TTFI off → on (ms) |
|---|---|---|---|---|
| resident int8 | 214.06 (=) | 54.99 → 43.31 | −11.67 [−13.37, −8.75] (**−21.2%**) | 502 → 430 |
| sequential G 32 int8 | 80.46 (=) | 90.80 → 79.70 (amort.) | −11.09 [−12.54, −10.40] (**−12.2%**) | 891 → 676 |
| resident mixedC2 | 355.06 (=) | 53.88 → 42.59 | −11.29 [−13.13, −10.01] (**−21.0%**) | 536 → 466 |
| sequential G 32 mixedC2 | 189.53 (=) | 90.28 → 79.82 (amort.) | −10.46 [−12.85, −7.43] (**−11.6%**) | 938 → 721 |

**F-27 holds:** the peaks are identical to Part A in all 8 configurations.

### 13.3 MAC-4: creation states (re-run; same-tab protocol)

| State | Create ms, median [CI], n = 5 |
|---|---|
| (a) no other Worker | 177.3 [174.3, 186.2] |
| (b) another chunk Worker alive | 62.5 [60.9, 65.5] |
| (b) − (a) | **−114.7 [−123.7, −111.5] (−64.7%)** |

### 13.4 MAC-2: decision engine on the Mac (re-run)

**Calibration (idle Mac, once):**

- spawn 13.3 ms
- create base 50.2 ms warm / 174.7 ms cold, 0.37 ms / MiB
- C1 compute: int8 20.7 vs fp32 18.0 ms

**Decisions:** 10 / 12 equal Part A's. Mid + early exit differs: the Mac chose mixedC2 sequential + pre-start + early exit, Part A mixedC2 resident + early exit.

**Memory:** 0 / 180 runs above the prediction (probe and upper bound). 10 / 18 plans are predicted exactly without the margin; 8 are over-predicted.

**Time: prediction error by shape** (negative = optimistic):

| Shape | Warm | Cold |
|---|---|---|
| sequential | +0.6% [−9.4, 5.6] | −1.9% [−13.3, −1.3] |
| resident | +5.3% [3.6, 7.1] | **+124.0%** [119.7, 124.3] |
| sequential + pre-start | −15.0% [−32.3, −10.2] | −22.7% [−40.8, −21.2] |
| hybrid | −19.6% [−24.0, −15.3] | −29.2% [−31.7, −27.0] |
| hybrid + pre-start | −17.8% [−20.8, −16.4] | −28.4% [−29.0, −26.4] |

**Regret:** in all 12 decisions the chosen plan was rank 1, with 0% regret; Spearman ρ 0.2–1.0. **Measured set:** each decision's **top-4 predicted plans** (narrower than Part A, which added the best plan of every family). mixedC2 resident, Part A's measured best for the mid profile, was **not measured on the Mac**.

### 13.5 MAC-5: F-14 fetch diagnostic (05:25 UTC)

| Round | 0 | 1 | 2 | 3 | 4 | 5 |
|---|---|---|---|---|---|---|
| int8 ms (MB/s) | 140 (480) | 73 (919) | 90 (749) | 196 (344) | 241 (279) | 70 (963) |
| fp32 ms (MB/s) | 356 (752) | 257 (1,043) | 280 (956) | 243 (1,102) | 261 (1,025) | 196 (1,366) |

- **F-14 (int8 736 ms > fp32 548 ms) is not reproduced.** int8 is faster in all 6 rounds.
- **Lower int8 byte rate reproduces** in all 6 rounds (1.1–3.7×).

### 13.6 The original run's MAC-2 / 3 / 4 (kept, not used)

- **MAC-2 timing invalid:** from 03:51:37 UTC to the end, Worker compute ran 6–17× slower in all 135 remaining runs. Cause not determined.
- **Overlap:** my aarch64 native runs (03:46–04:10) overlapped MAC-3 / 4 and the calibration (MAC-3 2.4–7.5% slower).
- **Preserved:** all rows are in the original file and in `analysis_mac.json`.
- **Re-run:** done with the foreground guard (0 pauses, 0 anomalous rows) on an idle Mac.

# Validation, verdicts, limitations

## 14. Validation outcomes (all stages)

| Stage | Checks | Outcome |
|---|---|---|
| Pilot (P-0) | throttle ±5%, determinism, probe vs browser measurement, CPU throttling on Workers | passed; CPU throttling dropped (F-33); 5 harness defects fixed |
| Suite smoke tests | 10 blocks, 1 rep | 10 / 10 valid after 6 preparation fixes (S-1 to S-6) |
| **Part A, Steps 1–13** | counts, page errors, outputs = reference (904 rows), cache state, bytes, origin, determinism, throttle gate | **13 / 13 valid; 0 failed runs; 1,310 browser runs + 249 offline passes** |
| **Part B, original run** | same + CPU stability | MAC-1 valid; **MAC-2 timing NOT valid** (reported, kept, not used) |
| **Part B, re-run** | same + foreground guard + relative and absolute CPU stability + expected reps (MAC-3 40, MAC-4 10, MAC-2 180) | **valid** |
| Disclosed validator changes | Mac cache-off criterion ("empty" → "unused"); refit target set (resident plans included) | both recorded |
| Report numbers | generated by `analyze.mjs` / `analyze_mac.mjs` from raw files; hand-written summaries cross-checked | 6 wording errors found and corrected (5 Part A, 1 Part B) |

## 15. Verdicts: cloud and Mac in separate columns

| Hypothesis | Part A: cloud / offline | Part B: Mac | Verdict |
|---|---|---|---|
| **H1** memory policies | sequential < chain < baseline (int8 80 < 111 < 180; fp32 283 < 403 < 656 MiB) | identical peaks | ✅ Supported |
| **H2** pre-start lowers TTFI | ≤ 6%, CI includes 0 in 6 / 8 cells; workload −18…−27% | not an experiment on the Mac | ❌ **Not supported** (throughput benefit) |
| **H3** latency / compute | −19…−20% resident, −5.7…−7.1% sequential | −21% resident, −12% sequential | ✅ Supported |
| **H3** bytes | −40…−63% / −9…−20% for early exits, **+1.8…+7% full path**, ≈ 0 per cached session | not measured | ⚠️ Partly supported |
| **H3** accuracy | −0.11 / −0.23 / −0.34 pt, p ≥ 0.55 | (device-independent) | Not significant |
| **H4** mixed precision | Pareto front; C2 recovers 77.8%; C0 fp32 lowers accuracy; p = 0.14 | (device-independent) | ⚠️ Descriptive only |
| **H5** cache | ×1.16 to ×78 | not measured | ✅ Supported |
| **H6** batch dependence | real; no growth with batch; sorting doesn't help | (CPU kernels; aarch64 native in Part A) | ⚠️ Partly supported |
| **F-5** | per platform: aarch64 1 flip, x86 1.20.1 0, x86 1.29 4; none significant | — | Reported per platform |
| **Engine:** memory | 0 / 200 underestimates | 0 / 180 | ✅ Safe |
| **Engine:** time | pre-start / pinned −28…−52%; cold resident +24% | pre-start / pinned −15…−29%; cold resident +124% | ⚠️ Same pattern; **future work** |
| **Engine:** regret | 10 / 12 rank 1; **mid (no early exit) 24% / 43%** | 12 / 12 rank 1 within top-4 predicted | ⚠️ Not met in Part A; not tested with the same set on the Mac |
| **E-F28** | (b) / (e) −56…−70% | (b) −64.7% | ✅ Supported |
| **F-13 / F-43** | int8 faster (cloud) | int8 never faster; 8 threads < 4 | Device-dependent |

## 16. Limitations (accepted 1 Nov 2026)

1. **Two machines, not a controlled CPU experiment.** They differ in OS, browser build, headless vs headed, and protocol. Simulated CPU throttling can't reach Workers (F-33).
2. **Mac protocol:** the tab reload keeps compiled WASM (F-37), so Mac creation and cold-start times aren't comparable with Part A.
3. **Time model:** optimistic for pre-start / pinned plans, pessimistic for cold resident plans, on both machines. The refit is a trade-off, not applied. **Future work; engine unchanged.**
4. **Mac regret:** measured on a narrower plan set; the mid-profile regret is confirmed in Part A only.
5. **Statistical power:**
   - n = 872 can't separate the precision settings (int8 vs fp32 p = 0.064) or the early-exit loss
   - n = 5 timing reps, so some wide CIs (e.g. Mac int8 4-thread [16.75, 24.06] ms)
6. **One model, task and data set** (DistilBERT-SST2). Cost model and accuracy table are model-specific; τ tuned on dev.
7. **Network:**
   - a token-bucket server on localhost (+3.2% at 50 Mbit/s; first-byte delay 20 ms), not a real network
   - fp32 at 5 Mbit/s omitted (decision 4)
   - no throttled network on the Mac
8. **Memory probe** covers WASM heaps only (JS +4–10 MiB per UA spot checks). Pre-start plans are reported with lower and upper bounds.
9. **Unexplained single observations, kept:**
   - I-4.8 (narrowed to a 9–12 s window)
   - F-14 (not reproduced)
   - pilot fp32 baseline 11.1 s TTFI (not reproduced)
   - the first Mac run's 6–17× slowdown
10. **Native int8 depends on CPU and ORT version** (F-34). Only WASM is portable.
11. **No real low-memory device**; profiles impose memory only as an engine budget.

## 17. Raw-data index (all preserved)

| Data | Location |
|---|---|
| Part A browser runs (1,310) | `results/phase7/{acc,ebrowser,e1,f28,eng,e3bytes,netcheck,net,e5x,g1}/runs.jsonl`; `eng/{calibration_cloud,decisions,decision_traces}.json`; `e3bytes/selection.json`; per-invocation `env_*.json` |
| Part A offline passes (249) | `results/phase7/wasm/` (90), `native-x86-ort1.20.1/` (77), `native-arm64-ort1.20.1/` (77), `native-x86-ort1.29.0/` (5) |
| Part B Mac | `results/phase7/mac/` (original run, re-run, MAC-5 transcription) |
| Analyses | `results/phase7/summary/analysis.json` (Part A), `analysis_mac.json` (original Mac run alone), `analysis_mac_final.json` (Part B final) |
| Pilot (not results) | `results/phase7/pilot/` |
| Smoke / self-tests (not results) | `results/phase7/_smoke/` |
| Workload | `results/phase7/workload_100.json` |
