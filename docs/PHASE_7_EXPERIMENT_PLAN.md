# Phase 7 Experiment Plan

**Status:** **v1.2 (final for execution)**, 1 Nov 2026. v1.1 decisions (§0) + pilot proposals **R1–R5 approved** (1 Nov). Pilot: `docs/phase-reports/PHASE_7_PILOT_REPORT.md`. Execution checklist: `docs/PHASE_7_EXECUTION_CHECKLIST.md`. **The full suite has not started.**
**Author:** Claude for Moulieswaran M · **Implementation baseline:** commit `caae0e9` (Phase 6)

## 0. Your decisions (31 Oct 2026) and how they are applied

| # | Decision | Applied as |
|---|---|---|
| 1 | Test H3 as written, **including bytes downloaded**; report latency, compute and byte savings **separately**; don't rewrite the hypothesis | §4.3 unchanged in substance; three separate result tables |
| 2 | Test whether CDP throttling affects Workers in the pilot; if not, drop it | Pilot: it does **not** (main thread 4.19×, Workers 1.00×) → **dropped** |
| 3 | Replace the 3 × 4 × 3 grid with E1 + E-ENG | Done (§4.1) |
| 4 | Skip fp32 at 5 Mbit/s; **document the omission** | Omitted from E2/E5; listed in §8 and in the final report |
| 5 | Measure the I-5.1 refit before/after; **don't change the engine automatically**; bring proposals back | §4.8; any engine change is a separate approval |
| 6 | Build the harness and run the reduced pilot; stop and report | Done; the report is the pilot report |
| 7 | I-4.8: you did not clear the cache | Kept as an **unexplained observation** (pilot report §6) |

**Additional instructions:**

1. **Cloud vs Mac** is a comparison of two machines, **not a controlled CPU-only experiment**. Hardware and browser configurations are recorded separately (pilot report §3.1).
2. **I-4.8:** the cache lookup, key, IndexedDB availability and fetch logs are checked before any conclusion; there's no retrospective "cold run" label without evidence.
3. **E-ENG fairness:** identical cache state for every candidate. Warm = an identical copy of one primed profile; cold = empty. The cache state is recorded per run, and cold and warm results are reported separately.

**Your conditions for execution (1 Nov):**

1. No engine change from the refit without your approval.
2. All unexpected and negative findings are preserved.
3. Cloud and Mac results are kept separate.
4. Each experiment is validated before the next one starts.
5. No additional features or scope.

Unsupported hypotheses and unexpected results stay in the final report.

---

## 1. What Phase 7 has to show

The project claims three things. Phase 7 has to produce evidence for or against each one:

1. **Splitting plus Workers changes the memory/latency trade-off in a controllable way** (H1, H2).
2. **Optional techniques have measurable, honest costs and benefits:** early exit, mixed precision and caching (H3, H4, H5).
3. **The decision engine picks a good plan for a device and can explain why.** Good means close to the best plan that was actually measured, and its predictions are accurate enough to rely on (E-ENG).

The plan also covers the findings you made mandatory (F-5 native vs WASM, F-6/E-B batch dependence) and the open items that need data (I-5.1, I-5.3, F-13, F-14, F-27, F-28).

## 2. Common methodology

| Topic | Rule (v1.2) |
|---|---|
| **Configurations** | Every row names one configuration from `bench/configs.json`. Cloud and Mac are never averaged together; native platforms are never merged. Cloud: `CLOUD-HL-1T` (unthrottled, port 8790), `CLOUD-HL-1T-NET-{50,20,10,5}`. Mac: `MAC-CHROME-W1`, `MAC-CHROME-T{1,2,4,8}`. Offline: `NODE-WASM-X86`, `NATIVE-X86-ORT1.20.1`, `NATIVE-ARM64-ORT1.20.1`, `NATIVE-X86-ORT1.29.0` (supplementary). |
| **Process isolation** | Cloud: one browser **process** per run. Mac: one **page reload** per run in one tab. Because of that difference, creation and cold-start times are not compared across the two (F-37). |
| **Repetitions** | Timing: 5 per configuration. Accuracy: 1 run per precision × early exit, plus 1 determinism repeat (D-7.3). Bytes in E3: 1 run (deterministic). E-F28: 10. R1's G = 1 throughput: n = 1, labelled indicative. |
| **Order** | Seeded random order within each repetition; the seed and order index are stored in every row. |
| **Cache state** (your instruction 3) | Stated per block, and **recorded in every row** as the cache entry count before/after, plus the origin. **off** = no IndexedDB tier (E1, MAC-1/3). **cold** = empty profile. **warm** = an identical copy of one primed master (10 entries: every chunk of both precisions + both heads), or a revisit of the same profile. Origins are fixed per link (F-36). Cold and warm results are never pooled. |
| **Output check on every run** | Workload outputs vs the precision's WASM reference: int8 Δ = 0, fp32 / mixed Δ < 1e-4, identical exit points. |
| **Warm-up** | M4 discards the first 5 requests (kept in the raw data). |
| **Workload** | `results/phase7/workload_100.json`: 100 sentences at token-length quantiles, plus the 20-sentence subset used for E-ENG requests. |
| **Statistics** | Median, IQR, mean ± std; bootstrap 95% CI (10,000 resamples) for differences; no p-values on n = 5 timings. Accuracy pairs: exact McNemar with flip counts. |
| **Failures** | A failed attempt stays in the file; the key is retried as a new row with `retryOf`. Nothing is deleted. |
| **Validation** | `bench/phase7/validate.mjs <block>` after every block. A block is valid only if all its checks pass. Hypothesis outcomes are **reported, never used to fail a block**. |
| **Engine** (condition 1) | The engine, runtime, package, baseline and demo are not modified. The I-5.1 refit produces a *proposal* only. |

**Metrics:**

| # | Metric | Definition |
|---|---|---|
| M1 | Bytes downloaded | Server-side byte count per run (`*.onnx`), cross-checked with each chunk's `source` |
| M2 | Time to first inference | Fresh runner → first logits (`ttfiMs`); in E-ENG the planned request itself |
| M3 | Peak memory | WASM probe (Σ live Worker heaps, or page heap) + waiting hidden states. Pre-start plans also report the **lifetime-overlap upper bound**. UA spot check on rep 1 of baseline / chain / resident (E1) and pinned plans (E-ENG). |
| M4 | Latency (D-7.2) | **Sentence-major** plans: median single-request latency (after 5 warm-up). **Chunk-major** plans: amortised time per sentence. The two are reported separately. |
| M5 | Accuracy | 872 validation sentences |
| M6 | Cache hit rate | IndexedDB hits / lookups over 3 revisits |

## 3. Harness (built and validated)

| Item | File |
|---|---|
| Runner page (one run per call) | `bench/phase7/runner.html`, `runner.js` |
| Cloud suite (blocks below), resumable, time-budgeted, profiles deleted after each run | `bench/phase7/suite.mjs`, `lib.mjs` |
| Validator | `bench/phase7/validate.mjs` |
| Offline passes (E4, E-B, F-5) | `bench/phase7/offline.mjs`, `node_wasm.mjs`, `native_eb.py` |
| Mac page + self-test | `bench/phase7-mac.html`, `bench/phase7/mac.js`, `mac_selftest.mjs` |

## 4. Experiment matrix (v1.2)

### 4.1 E1: memory policies (H1). Block `e1` (shared with E3 latency)

- **Question:** how much does each policy lower peak memory vs the full model, and at what load / latency cost?
- **Independent variables:**
  - policy: baseline · chain in page · resident Workers · sequential G 32 · hybrid (pin C0, G 32, pre-start off: the engine's best hybrid pin set and group size in the pilot; pre-start is E2's question)
  - precision: int8 · mixedC2 · fp32
  - That gives 14 configurations (no single-file mixed baseline, by design).
- **Dependent variables:** M3 (main), M2, M4, Worker starts, UA spot check.
- **Conditions:** CLOUD-HL-1T, cache **off** (D-7.1), w100, 5 reps.
- **Runs:** 14 × 5 (+ E3's 6 early-exit configurations × 5 in the same randomised block = 100 runs).

### 4.2 E2: pre-start (H2). Block `net` (R1), plus block `g1`

- **Question:** does pre-starting the next chunk Worker lower time to first inference, and how does that depend on the link?
- **Independent variables:**
  - pre-start: off / on
  - link: unthrottled · 20 · 5 Mbit/s
  - precision: int8 · mixedC2 · fp32 (fp32 not at 5 Mbit/s, decision 4)
  - That gives 8 cells × 2 = 16 configurations.
- **Each run:**
  - **cold** profile, sequential G 32
  - **TTFI** = one sentence (G is irrelevant for one sentence, R1)
  - then the w100 workload (G 32) on the now-filled cache
- **Dependent variables:** M2 (cold), workload time, M3 probe + upper bound, M1.
- **Runs:** 80.
- **G = 1 throughput:** block `g1`, one 20-sentence measurement per pre-start setting (int8, warm), labelled indicative (n = 1).
- **Prediction (pre-registered):** no TTFI benefit; a throughput benefit at G 32.

### 4.3 E3: early exit (H3, tested as written; decision 1). Blocks `acc`, `e1`, `e3bytes`

Latency, compute and bytes are reported separately.

| Part | Design | Runs |
|---|---|---|
| **Accuracy** (`acc`) | 872 sentences, early exit off/on × 3 precisions, resident; McNemar on/off per precision; 1 determinism repeat each | 12 |
| **Latency / compute** (`e1`) | resident and sequential G 32 × 3 precisions with early exit ON; the OFF counterparts are the E1 runs of the same randomised block. Reported: M4, compute inside the Workers (trace), exit rate per head, latency of exited vs full-path sentences | 30 (+30 shared) |
| **Bytes** (`e3bytes`) | **cold single-sentence requests**, sequential G 1, nothing pinned; per precision **30 sentences = 10 per exit class** (e1 / e2 / full by that precision's reference, evenly spaced); conditions: early exit off · on · on + pre-start; 1 run each (deterministic) | 270 |
| **τ curve** | from the saved exit logits, on **dev** (validation for reference only); no new inference | — |

Session-level bytes follow from the runtime model and are shown next to the measured single-request bytes. The validator compares every served byte count with that model and *reports* any mismatch.

### 4.4 E4: mixed precision (H4). Offline `wasm`

- **Design:** all 16 per-chunk precision combinations, chain, batch 1, 872 sentences, Node WASM (1 run each, deterministic).
- **Browser cross-check:** the 3 main combinations' hashes are compared with block `acc`.
- **Outputs:** accuracy, flips vs fp32 / int8, McNemar, bytes, predicted resident heap from the per-chunk heaps measured in E1.

### 4.5 E5: cache revisits (H5). Blocks `net` + `e5x`

- **Links:** unthrottled · 50 · 20 · 10 · 5 Mbit/s × 3 precisions (fp32 not at 5).
- **Cold visits:** a cold visit = the E2 pre-start-OFF cold run (links ∞/20/5, shared, R1) or an `e5x` cold run (50/10, TTFI only).
- **Revisits:** 3 per profile, each a new process on the **same origin**, exactly one request each.
- **Dependent variables:** M1, M2, M6, speed-up, creation share.
- **Runs:** net 120 revisits; e5x 6 cells × 5 × 4 = 120.

### 4.6 E-B: batch dependence of dynamic int8 (F-6, mandatory). Offline `wasm`, `native-x86`, `native-arm64`; block `ebrowser`

| Factor | Levels |
|---|---|
| Runtime / platform | WASM (Node = browser kernels) · native ORT 1.20.1 **x86-64** · native ORT 1.20.1 **aarch64** (R4) · native ORT 1.29.0 x86-64 (supplementary, 5 passes) |
| Model | full · chain |
| int8 | batch 1 once (order is irrelevant at batch 1); batch 4 / 8 / 16 / 32 × {dataset order, length-sorted, shuffled seeds 0–4} |
| fp32 control | batch 1; batch 4 / 8 / 16 / 32 × {order, shuffled seed 0} |
| Browser spot check | Chromium chain int8, batch 1 and 32, hash = Node WASM |

- **Passes:** 77 per native platform; WASM 90, which includes E4's 16 combinations.
- **Dependent variables:** accuracy, flips vs batch 1, mean / max |Δlogit|, spread across seeds, **per platform**.
- **Prediction H6:** int8 flips grow with batch and padding; sorted batches reduce them; fp32 is invariant (|Δ| ≲ 1e-5).
- **Already seen in the pilot:** the batch-32 effect differs by platform and even changes sign (F-34). That is reported, not averaged.

### 4.7 F-5: native vs WASM (mandatory)

From the batch-1 passes: full int8, chain int8, mixedC2 and the fp32 control, per native platform vs WASM. Reported per platform:

- accuracy
- flips and McNemar
- mean / max |Δlogit|

The aarch64 row reproduces the original F-5 numbers; the x86-64 and ORT 1.29 rows show how much "native" depends on platform (F-34).

### 4.8 E-ENG: decision engine + I-5.1 refit. Block `eng`

1. **One calibration**, measured once in a warm copy and saved (D-7.4).
2. **Decisions:** 3 profiles × early exit × {cold, warm} cache, sentencesPerRequest 20. Each decision records its margin to #2. The same decisions are also made **decision-only** under a 20 Mbit/s link.
3. **Measured set:** chosen + top 5 feasible + best per family, per decision (20 unique plans in the smoke test). Each plan × 5 reps × {warm, cold}.
4. **Each run:** exactly the planned request (one call, 20 sentences), with the prediction computed under that run's cache state.
5. **Outcomes:**
   - memory: never underestimated (probe and upper bound)
   - time error per plan shape
   - Spearman rank correlation, predicted vs measured
   - regret and rank of the chosen plan, using the profile's weights
6. **Refit:** hybrid / pre-start terms fitted on reps 1–2, evaluated on reps 3–5, error reported before and after. The result is **a proposal for your approval**; the engine is not edited.

### 4.9 E-F28: session creation. Block `f28`

- **States:**
  - (a) no other Worker alive
  - (b) another chunk Worker with a session
  - (c) ORT's JS imported only
  - (d) other Worker just terminated
  - (e) another Worker holds a live WASM instance with its session released (added in the pilot because (c) turned out not to instantiate WASM)
- **Also varied:** 4 chunks × 2 precisions × 10 reps.
- **Isolation:** each creation runs in a fresh browser process from a primed copy, so bytes come from IndexedDB and only creation differs. 400 runs.

### 4.10 Mac (MAC-CHROME-*), `bench/phase7-mac.html` (R5)

| Step | Covers | Design |
|---|---|---|
| MAC-1 | F-13 thread sweep | baseline int8 / fp32 × page threads 1 / 2 / 4 / 8 × 5 reps (w100) + 1 accuracy run each |
| MAC-3 | E1 / E3 subset | int8, mixedC2 × resident / sequential G 32 × early exit off/on × 5 reps, cache off |
| MAC-4 | E-F28 | states (a), (b), c1 int8, 5 reps, warm |
| MAC-2 | I-5.3 engine on a real device | Mac calibration (once), decisions cold + warm, chosen + next 3 per decision × 5 × {warm, cold} |
| MAC-5 | F-14 / I-2.7 | existing `bench/diag-fetch.html?threads=4` (manual) |

## 5. Time budget (from pilot and smoke-test timings)

| Block | Runs | Cloud | Mac |
|---|---|---|---|
| acc | 12 | ~10 min | — |
| e1 (E1 + E3 latency) | 100 | ~20 min | — |
| f28 | 400 | ~20 min | — |
| eng | ~200 + decisions | ~25 min | — |
| e3bytes | 270 | ~15 min | — |
| netcheck | 4 | ~1 min | — |
| net (E2 + E5 at ∞/20/5) | 200 | ~1.7 h | — |
| e5x | 120 | ~40 min | — |
| g1 | 2 | ~2 min | — |
| ebrowser | 2 | ~2 min | — |
| offline wasm | 90 | ~1.7 h | — |
| offline native x86 (1.20.1 + 1.29) | 82 | ~10 min | — |
| offline native aarch64 | 77 | — | ~20 min sandbox (no action from you) |
| Mac page | ~220 steps | — | **~25–30 min of your time** |
| **Total** | | **~5.8 h** | |

That's ~2 h less than the pilot's projection: the E-ENG plan set is smaller, and revisits are one request each.

## 6. Pre-registered predictions

| H | Supported if | Not supported if | Prediction |
|---|---|---|---|
| H1 | sequential < chain < baseline peak, CI excludes 0 | sequential ≥ chain | Supported |
| H2 | pre-start TTFI lower on slow links, CI excludes 0 | CI includes 0 | **Not supported for TTFI**; throughput benefit at G 32 |
| H3 | latency / compute lower; accuracy loss quantified; bytes lower | — (three separate verdicts) | Latency: small benefit; bytes: lower for e1 / e2 exits (−40% / −15% in the pilot), **higher** for full-path sentences (+7%), cancelled by pre-start; accuracy −0.11…−0.35 pt |
| H4 | a mixed combination on the Pareto front between int8 and fp32 | all dominated | Supported; C2 expected to be the best single fp32 chunk |
| H5 | warm ≪ cold, speed-up grows as the link slows | no speed-up | Supported |
| H6 | int8 flips grow with batch / padding; fp32 invariant | no batch effect | Supported, **platform-dependent** (F-34) |
| Engine | regret ≤ 10%, chosen plan in the measured top 3, 0 memory underestimates | otherwise | Memory safe; pre-start time 23–37% optimistic until the refit |

## 7. Decision history

- v1.0: Q1–Q7 (31 Oct)
- v1.1: decisions 1–7 + instructions 1–3 (§0)
- v1.2: R1–R5 approved (1 Nov) + conditions 1–5

## 8. Omissions and out of scope (stated in the final report)

- **fp32 at 5 Mbit/s** (E2, E5): omitted by decision 4.
- **Simulated CPU throttling:** dropped, because it doesn't reach Workers (F-33).
- **E2 G = 1 workload at 5 reps:** replaced by one indicative measurement (R1).
- **Accuracy per plan:** replaced by accuracy per precision (D-7.3; outputs are checked on every run).
- **Mac:** no throttled network; creation and cold-start times not compared with the cloud (F-37).
- **Other:** other models, WebGPU, real low-memory devices, and new runtime features (e.g. parallel chunk download) are out of scope; noted as future work only.
