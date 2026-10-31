# Progress Tracker — Adaptive Component-Level Model Loading

**Window:** 31 Oct – 30 Nov 2026 · **Last updated:** 31 Oct 2026 · **Today:** Day 1 of 30 · **Schedule:** 🟢 ~2 days ahead

Status key: ⬜ Not started · 🟦 In progress · 🟨 Done, awaiting approval · ✅ Approved · ⚠️ Blocked / slipped

| # | Phase | Planned dates | Actual | Status | Report |
|---|---|---|---|---|---|
| 0 | Planning and setup | 31 Oct – 1 Nov | 31 Oct | 🟨 (plan approved: "get started", 31 Oct) | `docs/phase-reports/PHASE_0_REPORT.md` |
| 1 | Model preparation (Python) | 2 – 6 Nov | 31 Oct | 🟨 All 10 validation checks passed | `docs/phase-reports/PHASE_1_REPORT.md` |
| 2 | Baseline browser inference | 7 – 9 Nov | — | ⬜ Ready to start once approved | — |
| 3 | Chunked execution and workers | 10 – 13 Nov | — | ⬜ | — |
| 4 | Storage and cache layer | 14 – 16 Nov | — | ⬜ | — |
| 5 | Resource monitor and decision engine | 17 – 20 Nov | — | ⬜ | — |
| 6 | npm package and demo | 21 – 23 Nov | — | ⬜ | — |
| 7 | Experiments | 24 – 27 Nov | — | ⬜ | — |
| 8 | Report and VIVA preparation | 28 – 30 Nov | — | ⬜ | — |

## Key results so far

| Metric | Value | Source |
|---|---|---|
| Baseline accuracy (SST-2 validation, 872 sentences) | 91.06% | `results/phase1/split_check.json` |
| Chained fp32 ONNX vs PyTorch | Δ = 2.4e-5, 100% agreement | `results/phase1/onnx_validation.json` |
| int8 accuracy | 90.37% (−0.69 points); 4× smaller (267.9 → 67.3 MB) | same |
| Exit heads E1 / E2 | 76.4% / 81.3% | `results/phase1/exit_heads.json` |
| Early exit at τ = 0.98 | 91.06%, 29% exit early, 5.22 of 6 layers on average | `results/phase1/onnx_validation.json` |

## Open items / blockers

| ID | Item | Owner | Status |
|---|---|---|---|
| B1 | Hugging Face blocked from both sandboxes | — | ✅ Resolved: `scripts/fetch_resources.sh`, run on macOS |
| B2 | Project folder | — | ✅ Connected (`Project - 1`) |
| B3 | Local environment | — | ✅ macOS 26.7.1 arm64; sandbox Python 3.10.12, Node 22 |
| I-0.1 | No git repository (the sandbox can't delete git lock files) | Mouli | Open: `git init` on macOS, or grant delete permission |
| I-1.7 | `_to_delete/` holds a stray 95 MB temporary file | Mouli | Open: delete in Finder |
| I-1.1 | The "C0 fp32" mixed-precision idea was disproven; replace with a sensitivity-driven mix | Claude | Planned for Phase 7 |
| I-1.3 | Tune τ on the dev split, not on validation | Claude | Planned for Phase 5 |

## Change log

| Date | Change |
|---|---|
| 31 Oct 2026 | Timeline compressed to 30 days; 4 chunks; early exit, workers and a scope-cut order added; causal model moved to future work. |
| 31 Oct 2026 | Phase 0 and Phase 1 completed and submitted for approval. Mixed-precision setting changed from "C0 fp32" to sensitivity-driven (C2 fp32) based on the Phase 1 results. |
