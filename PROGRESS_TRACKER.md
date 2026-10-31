# Progress Tracker — Adaptive Component-Level Model Loading

**Window:** 31 Oct – 30 Nov 2026 · **Last updated:** 31 Oct 2026 · **Today:** Day 1 of 30 · **Schedule:** 🟢 ~21 days ahead (Phases 0–6 done on Day 1)

Status key: ⬜ Not started · 🟦 In progress · 🟨 Done, awaiting approval · ✅ Approved · ⚠️ Blocked / slipped

| # | Phase | Planned dates | Actual | Status | Report |
|---|---|---|---|---|---|
| 0 | Planning and setup | 31 Oct – 1 Nov | 31 Oct | ✅ Approved 31 Oct | `docs/phase-reports/PHASE_0_REPORT.md` |
| 1 | Model preparation (Python) | 2 – 6 Nov | 31 Oct | ✅ Approved 31 Oct · commit `437548f` | `docs/phase-reports/PHASE_1_REPORT.md` |
| 2 | Baseline browser inference | 7 – 9 Nov | 31 Oct | ✅ Approved 31 Oct after the Mac verification passed (all checks; int8 Δ = 0, fp32 2.6e-5) | `docs/phase-reports/PHASE_2_REPORT.md` (§14 = real device) |
| 3 | Chunked execution and workers | 10 – 13 Nov | 31 Oct | ✅ Approved 31 Oct · commit `b5ba76e` | `docs/phase-reports/PHASE_3_REPORT.md` |
| 4 | Storage and cache layer | 14 – 16 Nov | 31 Oct | ✅ Approved 31 Oct · commit `8433ae0` | `docs/phase-reports/PHASE_4_REPORT.md` (§13 = Mac) |
| 5 | Resource monitor and decision engine | 17 – 20 Nov | 31 Oct | ✅ Approved 31 Oct · commit `54945c3` | `docs/phase-reports/PHASE_5_REPORT.md` |
| 6 | npm package and demo | 21 – 23 Nov | 31 Oct | ✅ Approved 31 Oct (commit below) | `docs/phase-reports/PHASE_6_REPORT.md` |
| 7 | Experiments | 24 – 27 Nov | — | 🟨 **Experiment plan drafted, awaiting your review** (no experiments run) | `docs/PHASE_7_EXPERIMENT_PLAN.md` |
| 8 | Report and VIVA preparation | 28 – 30 Nov | — | ⬜ | — |

## Key results so far

| Metric | Value | Source |
|---|---|---|
| Baseline accuracy (PyTorch, SST-2 validation) | 91.06% | `results/phase1/split_check.json` |
| Chunk chain vs full model | Δ = 0.0 (PyTorch), 2.4e-5 (ONNX) | `results/phase1/` |
| int8 size | 4× smaller (267.9 → 67.3 MB) | `results/phase1/onnx_validation.json` |
| Early exit at τ = 0.98 | 91.06%, 29% exit early | same |
| **Browser fp32** | 91.06%, load 1.6 s, p50 70 ms (1 thread) / 37 ms (2 threads), **WASM heap 656 MiB** | `results/phase2/browser_baseline_fp32.json` |
| **Browser int8** | 90.02%, load 0.75 s, p50 43 ms / 28 ms, **WASM heap 180 MiB** | `results/phase2/browser_baseline_int8.json` |
| WASM heap after `release()` | Unchanged (does not shrink), cloud + Mac → motivates Worker-per-chunk | same + `mac_*_4t.json` |
| **Mac (MAC-CHROME-4T)** | int8 p50 16.0 ms, fp32 p50 16.8 ms; heap 181.5 / 696.9 MiB retained after release | `results/phase2/mac_*_4t.json` |
| Native vs WASM int8 kernels | 1 prediction flip in 872 (sentence 702) | `results/phase2/int8_parity_diagnosis.json` |
| **Phase 3: peak WASM memory, fp32** | baseline 656 · chain in one page 403 (−38%) · resident Workers 813 (+24%) · **sequential Workers 280 MiB (−57%)** | `results/phase3/cloud_ABCD_fp32.json` |
| **Phase 3: peak WASM memory, int8** | baseline 180 · chain 111 (−38%) · resident 214 (+19%) · **sequential 77 MiB (−57%)** | `results/phase3/cloud_ABC_int8.json` |
| **terminate() vs release()** | terminate frees 100%, release frees 0% (browser memory API) | `results/phase3/cloud_*` (D) |
| **Phase 4: warm vs cold at 20 Mbit/s** | int8 29.1 → 2.27 s (×12.8), fp32 110.4 → 2.92 s (×37.8), 0 bytes on revisit | `results/phase4/throttled_*` |
| **Phase 4: LRU under small budgets** | 0% hit rate (cyclic access, F-24) | `results/phase4/cloud_*` |

## Open items / blockers

| ID | Item | Owner | Status |
|---|---|---|---|
| D-2.1 | int8 gate: WASM-kernel reference instead of native Python | Mouli | ✅ Approved 31 Oct; native difference mandatory in final report (F-5) |
| F-6 | Batch-size dependence of dynamic int8 → experiment E-B in Phase 7 | Claude | Planned (`docs/FINDINGS.md`) |
| I-2.1 | Manual browser verification on your Mac | Mouli | ✅ Passed 31 Oct (`results/phase2/mac_*_4t.json`) |
| I-2.7 | Mac run of `bench/diag-fetch.html?threads=4` to explain F-14 (int8 fetch slower than fp32 on the Mac) | Mouli | **Open** (doesn't block Phase 3) |
| I-2.6 | Commit the Phase 2 files | Claude | ✅ Committed 31 Oct |
| I-2.5 | Stray empty file `.git/tD4w3kG` | Claude | ✅ Deleted 31 Oct (delete permission granted for this session) |
| I-2.2 | UA memory API takes ~60 s with worker threads → WASM probe is the main metric | Claude | Applies from Phase 3 |
| I-3.1 | Mac run of the Phase 3 page (MAC-CHROME-W1) | Mouli | You report it as successful (31 Oct); **result JSONs not received yet**, so no real-device Phase 3 numbers are recorded |
| I-3.2 | Sequential mode needs a `groupSize` limit on waiting hidden states (F-21) | Claude | ✅ Resolved in Phase 5 (group size is a plan dimension) |
| I-4.1 | Eviction strategy for small budgets (LRU 0% hit, F-24) | Claude | ✅ Resolved in Phase 5 (pinning + chunk-major plans chosen by the engine) |
| I-4.2 | Session creation 63–72% of a warm request → keep Workers alive / pre-start | Claude | ✅ Resolved in Phase 5 (resident / pinned / pre-start plans) |
| I-5.1 | Hybrid / pre-start time predictions 23–35% optimistic (F-32) | Claude | Phase 7 refit |
| I-5.3 | Mac run of `demo/phase5-engine.html` | Mouli | Recommended |
| I-6.6 | Package licence | Mouli | ✅ MIT, © Moulieswaran M (31 Oct). Third-party licences kept separate in `THIRD_PARTY_NOTICES.md` |
| I-6.4 | Publish to the npm registry? | Mouli | Optional, your decision |
| I-6.1 | Cost model / accuracy table are model-specific (DistilBERT-SST2) | — | Documented limitation |
| I-4.7 | Mac run of `demo/phase4-cache.html` | Mouli | ✅ Received 31 Oct: every check passed; recorded as MAC-CHROME-W1 (Phase 4 report §13) |
| I-4.8 | Why did the Mac fp32 F4 'unlimited' run load from the network? (Was the cache cleared?) | Mouli | Question |
| I-1.1 | Mixed precision = C2 fp32, rest int8 | Claude | ✅ Measured: 90.83% (F-30); in the engine |
| I-1.3 | Tune τ on the dev split | Claude | ✅ τ = 0.95 on dev (F-31) |
| I-0.1 | Git repository | — | ✅ Initialised; first commit `437548f` |
| I-1.7 | `_to_delete/` | Mouli | Optional (ignored by git) |

## Change log

| Date | Change |
|---|---|
| 31 Oct 2026 | Timeline compressed to 30 days; 4 chunks; early exit, Workers and a scope-cut order added. |
| 31 Oct 2026 | Phases 0–1 completed. Mixed precision changed to "C2 fp32" based on the sensitivity results. |
| 31 Oct 2026 | Git initialised (commit `437548f`). Phases 0–1 approved. |
| 31 Oct 2026 | Phase 2 completed. Vite replaced by a Node isolation server. int8 reference changed to the WASM kernels (D-2.1, pending approval). WASM heap probe adopted as the main memory metric. |
| 31 Oct 2026 | D-2.1 approved. F-5 and F-6 made mandatory findings (`docs/FINDINGS.md`, master plan v1.2, experiment E-B). Page fixes: UA memory opt-in, thread lock, copy button; re-check 10/10. `.git/tD4w3kG` deleted. Manual verification guide written. |
| 31 Oct 2026 | Mac verification passed (MAC-CHROME-4T, registered in `bench/configs.json`). Phase 2 approved and committed. Fetch-timing investigation (F-11, F-12, F-14 open); retention and latency recorded (F-4, F-13, F-15, F-16). Phase 3 started. |
| 31 Oct 2026 | Phase 3 completed: ChunkSession/ChainRunner, one Worker per chunk (resident + sequential), memory-release proof, F-17 to F-21. Baseline unchanged (only `index.js` exports added; regression passes). Awaiting approval. |
| 31 Oct 2026 | Phase 3 approved and committed (`b5ba76e`); you report the Mac run as successful (data not attached). Phase 4 started. |
| 31 Oct 2026 | Phase 4 completed: ChunkStore (IndexedDB, SHA-256 content addressing), ChunkLoader integrity, MemoryLRU, WorkerPool hot tier, throttled server; F-22 to F-26. Phase 3 code changed additively only (opt-in cache); regressions pass. Awaiting approval. |
| 31 Oct 2026 | Mac Phase 4 results recorded (MAC-CHROME-W1): all checks pass; F-22/F-24 confirmed on a real device; F-27 (heap sizes identical across platforms). Fixed 2 bugs found through them (pool timeline order, page label); int8 suite re-run 26/26. |
| 31 Oct 2026 | Phase 4 approved and committed (`8433ae0`). Next: Phase 5 (resource monitor and decision engine). |
| 31 Oct 2026 | Phase 5 completed with your 5 adjustments: deterministic 7-step engine, weighted cost, hard constraints separate from preferences, 15% reserve + heap ×1.10, separate memory/time components, disk vs residency separated, early exit opt-in (τ on dev). Calibration rebuilt twice (F-28, F-29). Awaiting approval. |
| 31 Oct 2026 | Phase 5 approved and committed (`54945c3`). Phase 6 started. |
| 31 Oct 2026 | Phase 6 completed: `loadModel` facade, typed errors, `index.d.ts`, README, LICENSE, demo (public API only); tarball tested in a clean consumer project (8/8 + 17/17); 2 API bugs found by the consumer test and fixed. Awaiting approval. |
| 31 Oct 2026 | Demo improved after your review: early-exit status, predicted vs measured memory, per-sentence path/time, profile comparison (`previewPlan`), alternatives box, collapsible debug view. Output-only trace added to `decide()` and per-sentence records to `PlanRunner` (decisions byte-identical; Phase 5 53/53). |
| 31 Oct 2026 | Phase 6 approved: licence MIT © Moulieswaran M; `THIRD_PARTY_NOTICES.md` added (DistilBERT Apache-2.0, SST-2 licence unknown, onnxruntime-web MIT). Phase 6 committed. Phase 7 experiment plan drafted for review; no experiment run. |
