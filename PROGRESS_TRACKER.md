# Progress Tracker — Adaptive Component-Level Model Loading

**Window:** 31 Oct – 30 Nov 2026 · **Last updated:** 31 Oct 2026 · **Today:** Day 1 of 30 · **Schedule:** 🟢 ~9 days ahead (Phase 3 started on Day 1; planned start 10 Nov)

Status key: ⬜ Not started · 🟦 In progress · 🟨 Done, awaiting approval · ✅ Approved · ⚠️ Blocked / slipped

| # | Phase | Planned dates | Actual | Status | Report |
|---|---|---|---|---|---|
| 0 | Planning and setup | 31 Oct – 1 Nov | 31 Oct | ✅ Approved 31 Oct | `docs/phase-reports/PHASE_0_REPORT.md` |
| 1 | Model preparation (Python) | 2 – 6 Nov | 31 Oct | ✅ Approved 31 Oct · commit `437548f` | `docs/phase-reports/PHASE_1_REPORT.md` |
| 2 | Baseline browser inference | 7 – 9 Nov | 31 Oct | ✅ Approved 31 Oct after the Mac verification passed (all checks; int8 Δ = 0, fp32 2.6e-5) | `docs/phase-reports/PHASE_2_REPORT.md` (§14 = real device) |
| 3 | Chunked execution and workers | 10 – 13 Nov | 31 Oct → | 🟦 In progress | — |
| 4 | Storage and cache layer | 14 – 16 Nov | — | ⬜ | — |
| 5 | Resource monitor and decision engine | 17 – 20 Nov | — | ⬜ | — |
| 6 | npm package and demo | 21 – 23 Nov | — | ⬜ | — |
| 7 | Experiments | 24 – 27 Nov | — | ⬜ | — |
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
| I-1.1 | Mixed precision = C2 fp32, rest int8 | Claude | Phase 7 |
| I-1.3 | Tune τ on the dev split | Claude | Phase 5 |
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
