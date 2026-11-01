# Phase 7: Harness and Pilot Report (P-0)

**Date:** 31 Oct 2026 · **Status:** Pilot complete. **The full suite has not been started** and waits for your review.
**Scope approved:** harness build + reduced pilot (decision 6). Raw data: `results/phase7/pilot/`.

> **Read this first:** every pilot number below comes from **one repetition** on a reduced workload. These numbers check the harness and give an early look at the effects. **They are not experimental results**, and none of them will be quoted as a result in the final report.

---

## 1. Overview

**Purpose:** check that the harness measures what the plan says before hours of compute are spent. That means checking throttling, determinism, memory probes and timing, and finding design problems early.

**Outcome in brief:**

- All four measurement checks you asked about were done, with these results:

  | Check | Result |
  |---|---|
  | CPU throttling on Workers | **Does not apply** → dropped (your decision 2) |
  | Network throttle | **Within ±5%** at every rate |
  | Logit determinism | **Bit-identical** |
  | Worker memory probe | **Agrees with the browser** to within 3.2% |

- **Harness defects:** the pilot found 5 defects in my harness (1 of them in a Phase 4 bench file). All are fixed.
- **Unexpected result:** the "native" int8 reference depends on CPU architecture *and* ORT version. This changes how F-5 and E-B must be run.
- **The ±50% gate is triggered for two experiments.** E2 and E3, as designed, would take ~4–7× their estimates, because sequential G = 1 workloads reload every chunk for every sentence. A redesign is proposed in §7. It needs your approval.

## 2. Work completed

| Item | Files | Status |
|---|---|---|
| Experiment page: one run per call, public API + forced plans only; no engine/runtime change | `bench/phase7/runner.html`, `runner.js` | ✅ |
| Node harness: one browser process per run, cold = empty profile, warm = identical copy of a primed profile, resumable JSONL, seeded random order | `bench/phase7/lib.mjs` | ✅ |
| Raw CDP client (to address Worker targets for the throttling test) | `bench/phase7/cdp.mjs` | ✅ |
| CPU-throttling test page | `bench/phase7/cpu.html`, `busyWorker.js` | ✅ |
| Fixed 100-sentence workload (length quantiles) + 20-sentence pilot subset | `bench/phase7/workload.mjs` → `results/phase7/workload_100.json` | ✅ |
| WASM-in-Node runner (E4, E-B, F-5) | `bench/phase7/node_wasm.mjs` | ✅ |
| Native ORT runner (E-B, F-5), same batching/shuffle as Node | `bench/phase7/native_eb.py` | ✅ |
| Pilot driver (steps cpu, net, det, probe, e1, e2, e3, e5, eng, engstab, f28) | `bench/phase7/pilot.mjs` | ✅ |
| **Mac page (H-1)** | `bench/phase7-mac.html` | ❌ **Not built**: its contents depend on the §7 decisions, and your computer was not reachable at the end of the pilot. I'll build it after you approve §7. |

**Workload:** 100 validation sentences at evenly spaced token-length quantiles (mean 25.1 tokens, range 6–53, vs 25.2 / 4–55 for all 872). The pilot used every 5th of them (20 sentences, mean 25.1).

## 3. Your five questions

### 3.1 Does CPU throttling affect dedicated Workers? **No.**

Test: a fixed JS loop (2 × 10⁷ iterations, median of 5), throttling rate 4×, each condition in a new browser process. A Worker created *after* throttling was set is included, so lazily created Workers are covered.

| CDP throttling applied to | Main-thread slowdown | Worker slowdown |
|---|---|---|
| page target | **4.19×** | **1.00×** |
| each Worker target (auto-attach) | 1.00× | 1.00×. Chrome rejects it: *"Operation is only supported for pages, not workers"* |
| both | 4.19× | 1.01× |

On real inference (resident int8, compute timed *inside* the chunk Workers):

- **Compute inside the Workers:** ×1.00 / ×1.03.
- **Whole request:** ×1.06–1.08, which is only the main-thread part of a request.
- **Conclusion:** because all model compute runs in Workers, simulated CPU throttling would hardly change the measurements.

**Action (your decision 2):** simulated CPU throttling is **dropped**. Following your instruction 1, cloud vs Mac will be reported as a **comparison of two different machines, not a controlled CPU-only experiment**. Each machine's configuration is recorded separately:

| | CLOUD-HL-1T (x86) | MAC-CHROME-* (arm64) |
|---|---|---|
| CPU | Intel Xeon (model not exposed), 2 vCPU, AVX2 / AVX-512 / AVX-512-VNNI | Apple Silicon, `hardwareConcurrency` 8 |
| RAM | 7 GiB | `deviceMemory` 16 |
| OS / kernel | Linux 6.18 (VM) | macOS 26.7.1 |
| Browser | Chromium 153.0.8010.12, Playwright 1.63.0, headless | Google Chrome 155, headed, default flags |
| Threads per Worker | 1 | 1 (thread sweep 1/2/4/8 for the baseline only) |

They also differ in OS, browser build, headless vs headed, and thermal and power behaviour. So any timing difference can't be attributed to the CPU alone.

### 3.2 Pilot duration vs estimate

| | Estimate (plan §3) | Actual |
|---|---|---|
| Pilot compute (sum of run wall times) | ~30 min | **~21 min** (1,273 s) |
| Pilot wall clock incl. fixing the 5 harness defects | — | ~55 min (17:06–18:00 UTC), plus harness build before that |

Projection for the full suite, from the measured per-run times:

| Experiment | Plan estimate | Projected as designed | Δ | Gate (>+50%) |
|---|---|---|---|---|
| E1 memory policies | 1 h | ~0.5 h | −50% | — |
| **E2 pre-start** | 2 h | **~8.4 h** | **+320%** | **triggered** |
| **E3 early exit** | 0.75 h | **~5.6 h** | **+650%** | **triggered** |
| E4 mixed precision | 0.33 h | ~0.2 h | −40% | — |
| E5 cache / network | 1.5 h | ~2 h | +37% | — |
| E-B batch dependence | 2 h | ~2.4 h (+ the ARM native runs, §5) | +20% | — |
| E-ENG | 1.5 h | ~0.5 h (20 unique plans, not ~30) | −65% | — |
| E-F28 | 0.25 h | ~0.2 h | — | — |
| **Total** | **~10 h** | **~20 h** | | |
| **Total with the §7 redesign** | | **~8 h** | | |

**Why E2 and E3 explode:**

- A sequential plan with G = 1 reloads all four chunks for *every* sentence: 2.3 s per sentence (int8, from IndexedDB).
- 100-sentence workloads with G = 1 therefore take ~230–300 s per run.
- E2 has 80 such runs (≈ 6.8 h) and E3 has 30 (≈ 2.1 h). E3 also has six 872-sentence G = 1 accuracy runs at ≈ 33 min each (≈ 3.3 h).
- My estimate wrongly treated download time as the dominant cost.

### 3.3 Network throttle accuracy (target ±5%) — **all within**

14.28 MB file, RTT setting 40 ms; rate measured from first to last body byte.

| Set | Measured | Error |
|---|---|---|
| 50 Mbit/s | 51.55 | +3.10% |
| 20 Mbit/s | 20.24 | +1.20% |
| 10 Mbit/s | 10.06 | +0.59% |
| 5 Mbit/s | 5.00 | −0.03% |
| 20 Mbit/s, 2 concurrent fetches (shared link) | 20.12 aggregate | +0.61% |
| 20 Mbit/s, fetch from a Worker | 20.25 | +1.23% |

- **Positive bias at high rates:** this comes from the token bucket's initial burst (0.1 s of bandwidth). Over a whole 67 MB model it's smaller than in this 14 MB test.
- **RTT is mislabelled.** The server delays the first byte by RTT/2, so measured time-to-first-byte is **22–29 ms, not 40 ms**. I'll relabel it "first-byte delay 20 ms" in all Phase 7 results. The Phase 4 F-23 runs used the same server, so their "RTT 40 ms" label has the same meaning. No measurement there is wrong, only the label.

### 3.4 Logit determinism and Worker memory-probe verification

**Determinism:** all 872 sentences, resident plan, each repeat in a **new browser process**.

| Precision | Run 1 hash | Run 2 hash | Δ vs Phase 3 WASM reference | Accuracy | Run time |
|---|---|---|---|---|---|
| int8 | `1b4238164e7c…` | identical | **0** | 90.02% | 41–42 s |
| mixedC2 | `d5f82fe66511…` | identical | **0** | 90.83% | 49 s |
| fp32 | `c4b44bfd4fd8…` | identical | **0** | 91.06% | 62–65 s |
| int8 + early exit | `7f3fc934781b…` | — | **0**, exit points identical (0 mismatches) | 89.91% | 35 s |

The Node WASM runner gives the **same int8 hash** as the browser (`1b4238…`), so the Node runs for E4/E-B use the browser's exact kernels.

**Memory probe vs the browser's own measurement** (`measureUserAgentSpecificMemory`, ForceEager; 4 resident Workers alive):

| | Probe (Σ Worker heaps) | Browser-measured increase | Probe vs browser | Freed after `terminate()` |
|---|---|---|---|---|
| int8 | 214.06 MiB (77.19 + 45.25 + 45.25 + 46.38) | 221.17 MiB | −3.2% | 221.09 MiB (100%) |
| fp32 | 813.31 MiB | 820.42 MiB | −0.9% | 820.35 MiB (100%) |

- **All 4 Workers** reported a non-zero heap.
- **The remaining ~7 MiB** is the Workers' JS heaps, which the WASM probe doesn't cover by design (F-8).
- **The UA call took ~1 s here** (1 thread per Worker), not the ~60 s seen with multi-threaded ORT (F-7). So per-run UA spot checks are affordable in the suite.

**Pre-start blind spot, now bounded:** the probe sees a Worker only after its load reply (Phase 5). The harness now also computes an **upper bound** by counting each Worker's heap from the *start* of its spawn:

| Plan | Probe (lower bound) | Upper bound |
|---|---|---|
| int8 sequential, no pre-start | 77.19 MiB | 77.2 MiB |
| int8 sequential, pre-start | 77.19 / 91.63 MiB | **122.5 MiB** |

For pre-start plans, both bounds will be reported. The engine's prediction for the mid plan (mixedC2 sequential + pre-start) was 255.9 MiB, above the measured upper bound of 232.7 MiB, so it was not underestimated.

### 3.5 Failed checks and deviations

**Failed checks found by the pilot (all fixed and re-run):**

| # | Defect | Effect before the fix | Fix |
|---|---|---|---|
| P-1 | **`bench/throttledServer.mjs` (Phase 4 file): token-bucket capacity (0.1 s of bandwidth) was smaller than one 64 KiB write below ~5.24 Mbit/s** | Any download at ≤5 Mbit/s **stalled forever** | Capacity = max(0.1 s, 64 KiB). Phase 4 results are **not affected**: they used only 20 Mbit/s (capacity 250 KB). |
| P-2 | Upper memory bound: whole-ms timeline times vs fractional load times | +45 MiB "overlap" in a plan without pre-start | 1 ms tolerance; now equals the probe when there's no overlap |
| P-3 | E-ENG protocol: a separate first-sentence request before the measured workload | A sequential plan loaded everything twice, so the time "error" was −64…−69% **caused by the harness** | E-ENG measures exactly the one request the engine planned (`ttfi: false`) |
| P-4 | E-ENG analysis: the decision trace stores the pin *count*, which my code read as a list | Best hybrid always "none"; family counts wrong | Fixed; recounted |
| P-5 | One-line block comment swallowed a closing brace in `runner.js` | Page didn't load (caught at once) | Fixed |

**Deviations from the approved plan (need your OK):**

| # | Deviation | Reason |
|---|---|---|
| D-7.1 | **E1 runs with the cache OFF for every policy** (bytes from the localhost server), not "warm cache" | Baseline and chain have no IndexedDB tier. Cache-off is the only state all five policies share (the same fairness reasoning as your instruction 3). Cache effects are E5's job. |
| D-7.2 | **M4 has two forms, reported separately:** sentence-major plans → median single-request latency; chunk-major plans (G > 1) → amortised time per sentence | A chunk-major plan has no per-sentence latency. Mixing the two would be misleading. |
| D-7.3 | **Accuracy is measured once per precision × early exit, not once per plan** | Every plan's outputs equal its precision's reference (Δ = 0 here and in Phase 5), so accuracy can't depend on the plan. Every timing run still checks its outputs against the reference. |
| D-7.4 | **One fixed calibration file for all E-ENG decisions** | See §4 (decision instability). |
| D-7.5 | "RTT 40 ms" relabelled "first-byte delay 20 ms" | §3.3 |
| D-7.6 | **F-5 / E-B native runs on two CPU architectures with the pinned ORT 1.20.1** (+ ORT 1.29 as a supplementary row) | §5 |
| D-7.7 | Accuracy-scale analysis (§3.4) shows **UA-memory spot checks are cheap** with 1 thread per Worker: proposed on 1 rep of every E1/E-ENG configuration | — |

## 4. Early observations (one repetition each, **not results**)

These are recorded because you asked to keep unexpected results. Each will be re-measured with 5 repetitions.

| Exp. | Observation | Against the pre-registered prediction (plan §6) |
|---|---|---|
| E1 | Peak memory, int8: baseline 180.25 · chain 111.19 · resident 214.06 · hybrid (pin C0, G 8) 124.2 · sequential 78.66 MiB (incl. hidden states); fp32 656.38 / 403.44 / 813.31 / 467.01 / 281.6 | As predicted for H1 |
| E1 | **fp32 baseline: time to first inference 11.1 s once**, then 1.32 / 1.35 / 1.46 s in 3 re-runs | Unexplained outlier, the same kind as F-9. Kept, not dropped; per-load fetch/create split now logged on every row so the next one can be diagnosed. |
| E2 | int8, 20 Mbit/s, cold: pre-start changes TTFI by **−0.1 s of 29 s (−0.3%)**, but cuts the G = 32 workload **3.31 → 2.25 s (−32%)**. Peak memory with pre-start 91.63 (probe) / 122.5 MiB (bound) vs 77.19. | Matches the prediction (no TTFI benefit; throughput benefit at G = 32) |
| E3 | **Bytes for one cold sentence** (int8, nothing pinned): exits at E1 → **40.5 MB (−40%)**; at E2 → 57.2 MB (−15%); full path → **72.0 MB (+7%, the exit heads are extra)**; with pre-start the E1 saving shrinks to −15%. Resident latency with/without early exit: 49.8 vs 50.8 ms. | Bytes part is *partly* supported (better than I predicted), which is why the bytes question stays as you required. Latency gain looks small. |
| E5 | int8, 50 Mbit/s: cold 13.0 s → revisits 2.20 / 2.24 / 2.09 s (**×6.0**), 0 bytes, hit rate 100% | As predicted for H5 |
| E-ENG | **Decision instability:** with a fixed calibration, 3 repeats gave identical decisions for all 6 requests (the engine is deterministic). With **freshly measured** calibrations, *mid + early exit* switched between mixedC2 resident and mixedC2 sequential + pre-start. Its top-2 cost gap is only **0.27–1.22%** (others: 2.5–13%). | New. It means calibration noise can flip near-ties, so E-ENG must use one saved calibration (D-7.4) and report each decision's margin. |
| E-ENG | Decisions were **identical with an empty and a full cache** on localhost | The engine's cache term matters through download time, which is tiny on localhost. The suite will also decide under a throttled link to test this properly. |
| E-ENG | Mid plan time prediction (after fixing P-3): **−37% cold / −28.6% warm** (optimistic) | Matches F-32 (pre-start plans 23–35% optimistic), i.e. this is exactly what the I-5.1 refit is for |
| E-F28 | Creating the C1 Worker: **fast (112–181 ms) only when another Worker holds a live ORT WebAssembly instance** (with a session, or with its session released); **slow (367–463 ms)** with no other Worker, with one that has only imported ORT's JS, or with one just terminated | Consistent with the "compiled module is reused while an instance is alive" hypothesis. My first version of state (c) didn't create a WASM instance (`init` only imports ORT), so I added state (e). |

## 5. Unexpected result: the native int8 reference depends on platform and version

F-5 says native int8 = 90.14% vs WASM 90.02% (1 flip, sentence 702). The pilot re-ran native int8 at batch 1:

| Native run | ORT | CPU | Accuracy (batch 1) | Flips vs WASM | Batch 32 (dataset order) |
|---|---|---|---|---|---|
| Phase 1 (F-5) | 1.20.1 | **aarch64** (your Mac's Linux sandbox) | 90.14% | 1 | 90.37% |
| Pilot | 1.20.1 | **x86-64** (cloud, AVX-512-VNNI) | 90.02% | **0** (logits still differ, max Δ 0.62) | 90.71% |
| Pilot | **1.29.0** | x86-64 | 90.02% | 4 (max Δ 2.19) | **89.79%** |
| WASM (browser = Node) | web 1.20.1 | any | 90.02% | — | 90.71% |

What this shows:

1. **"Native" is not one reference.** Native int8 depends on CPU architecture *and* ORT version. A plausible cause is that int8 kernels differ per instruction set (e.g. VNNI on x86, dot-product on ARM). That's a hypothesis, not tested.
2. **WASM is the stable one:** it was bit-identical on every machine tested. This strengthens D-2.1 (WASM as the reference).
3. **The batch effect (F-6) differs by platform, and its sign isn't fixed:** +0.23 pt on ARM, +0.69 pt on x86 (native and WASM), −0.23 pt with ORT 1.29.

**Proposed change (D-7.6):** run the native side of F-5 and E-B on **both** architectures with the pinned 1.20.1. The ARM runs are on your Mac's Linux sandbox and need your computer reachable. ORT 1.29 x86 becomes a supplementary "version sensitivity" row. F-5's wording in `FINDINGS.md` will be updated to name its platform; the finding itself stands.

## 6. I-4.8 (Mac fp32 F4 run loaded from the network): still unexplained

Following your instruction 2, nothing has been reclassified.

| Check | Finding from the code |
|---|---|
| Cache key | Content-addressed (SHA-256 from the manifest). Identical for every run with the same manifest, so a key mismatch is impossible unless the manifest changed. |
| Cache lookup | `ChunkLoader.getBytes` → `ChunkStore.get(sha)`. Returns "miss" only if the blob or its metadata is absent **in that origin's** IndexedDB. |
| IndexedDB availability | If IndexedDB couldn't be opened, the Worker's `load` would **fail with an error**, not fall back to the network. So the run *did* open a store and found no fp32 entries. |
| Page actions that delete entries | F5 deletes each chunk and **immediately re-stores** it; F3 replaces one chunk and repairs it; with no budget there's no eviction. None of them can remove all four. |
| Network-fetch logs | Not recorded by the Phase 4 page. |

Remaining candidate explanations, none of which the data can confirm:

- **(a) A different origin.** `localhost:8080` and `127.0.0.1:8080` have separate IndexedDB stores, and the page didn't record its origin.
- **(b) Browser eviction** of best-effort storage (F-26: `persist()` = false).
- **(c) A different browser profile or window.**

**What would decide it:** the `date` field and `storeAfter` lists of the Mac fp32 F1/F3/F5/F4 JSON files, which are on your computer. I'll check them when it's reachable. **New:** every Phase 7 run now records its page origin and the cache contents before and after, so the suite can't produce an ambiguous case like this.

## 7. Decisions needed before the full suite

| # | Question | Recommendation |
|---|---|---|
| **R1** | **E2 redesign.** A single-sentence TTFI request is identical for G = 1 and G = 32, so measure cold TTFI once per (pre-start × link × precision) and the 100-sentence workload **only for G = 32**. G = 1 throughput is covered by one pilot-sized measurement (20 sentences). Effect: ~8.4 h → ~1.6 h. The H2 question is still answered in full. | Approve |
| **R2** | **E3 redesign.** Accuracy once per precision × early exit (D-7.3). Latency for resident and sequential G = 32. **The bytes test keeps full strength:** cold single-sentence requests on **30 sentences per precision, 10 from each exit class**, with early exit off / on / on + pre-start (bytes are deterministic, so 1 run each; TTFI from E2). Effect: ~5.6 h → ~0.5 h. | Approve |
| R3 | Deviations D-7.1 to D-7.7 (§3.5) | Approve |
| R4 | ARM native runs for F-5 / E-B need your computer reachable (~30 min of sandbox time, no action from you except keeping it online) | — |
| R5 | Mac page (H-1) built after R1–R3, so it matches the final design | Approve |

With R1–R3 the projected total is **~8 h of cloud compute**, about 1.5 days elapsed (sharded runs), plus ~40 min on your Mac. That's within the 24–27 Nov window.

## 8. Files

**New:**

- harness: `bench/phase7/{runner.html, runner.js, lib.mjs, cdp.mjs, cpu.html, busyWorker.js, workload.mjs, node_wasm.mjs, native_eb.py, pilot.mjs}`
- workload: `results/phase7/workload_100.json`
- pilot data: `results/phase7/pilot/*.json`, `det.jsonl`, `calibration_cloud.json`, and the `wasm/`, `native/`, `native120/` pass files

**Changed:** `bench/throttledServer.mjs` (P-1 fix, 4 lines + comment).

**Not changed:** the engine, the runtime, the package, the baseline, the demo.

## 9. Next step

Once you've reviewed §7: update the plan to v1.1, build the Mac page, then run the suite in this order:

1. E-B / F-5 cloud parts and E4 (Node / Python)
2. E1
3. E-F28
4. E-ENG
5. E3
6. E5
7. E2

Each experiment's results are checked before the next one starts.
