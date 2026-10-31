# Phase 0 — Planning and Setup: Completion Report

**Dates:** 31 Oct 2026 (Day 1) · **Status:** Complete, awaiting your approval (submitted together with Phase 1)
**Approval of the plan:** You replied "get started" on 31 Oct. I treated that as approval of `00_MASTER_PLAN.md` v1.0.

---

## 1. Phase overview

**Objective:** Turn the project idea into an executable 30-day plan and set up a working development environment, so that Phase 1 can start without blockers.

## 2. Work completed

| Task | Result |
|---|---|
| Re-planned from 8–11 weeks to 30 days | `docs/00_MASTER_PLAN.md`: 9 phases (0–8), each with dates and a verifiable exit criterion |
| Defined the architecture | Offline Python build → ONNX chunks + manifest → browser runtime (orchestrator, decision engine, storage layer, worker pool) |
| Defined the evaluation | 6 metrics (M1–M6), 3 device profiles, 4 policies, 3 precision settings |
| Progress tracker | `PROGRESS_TRACKER.md` |
| Project skeleton | Folder layout below |
| Environment check | Cloud workspace and your Mac's Linux sandbox both inspected (results below) |
| Resolved the model-download blocker | `scripts/fetch_resources.sh`, run by you in macOS Terminal |
| Python environment | venv with pinned versions (`python/requirements.txt`) |

### Folder layout created

```
Project - 1/
├── PROGRESS_TRACKER.md
├── .gitignore
├── docs/                    00_MASTER_PLAN.md, phase-reports/
├── scripts/fetch_resources.sh
├── python/                  model pipeline (Phase 1)
├── models/hf/               downloaded checkpoint (not committed to git)
├── models/onnx/             exported ONNX artifacts + manifest.json
├── models/heads/            trained early-exit head weights (.pt)
├── data/sst2/               SST-2 train/validation parquet
├── tests/                   onnxruntime-web smoke test
├── packages/adaptive-onnx-loader/   npm package (Phase 6)
├── demo/  bench/  results/
└── _to_delete/              files I am not permitted to delete (see Issues)
```

## 3. Implementation details: environment

There are **two execution environments**, and this decides where each kind of work runs:

| Environment | What it is | Network | Used for |
|---|---|---|---|
| Your Mac's Linux sandbox (`device_bash`) | aarch64 Ubuntu 22.04, 4 vCPU, 3.9 GB RAM, Python 3.10.12, Node 22, mounts your `Project - 1` folder | PyPI ✅, npm ✅, GitHub ✅, **huggingface.co ❌** | All Python and Node work on your files |
| Cloud workspace | Linux, 2 vCPU, 7 GB RAM, Chromium + Playwright | npm ✅, huggingface.co ❌ | Headless browser tests (Phase 2+) when needed |
| Your macOS Terminal | macOS 26.7.1 arm64, Python 3.10.2 | Unrestricted | One-off downloads that the sandboxes cannot reach |

Pinned Python stack: `torch 2.5.1, transformers 4.46.3, onnx 1.17.0, onnxruntime 1.20.1, numpy 1.26.4`. Runtime target: `onnxruntime-web 1.20.1`. Pinning the versions means the ONNX opset and operator behaviour are identical across runs and machines.

## 4. Technical decisions

| Decision | Why |
|---|---|
| Downloads go through a script you run on macOS | The sandbox's egress policy blocks huggingface.co (HTTP 403 at the proxy). Your own Terminal is not restricted. A script keeps the step reproducible and records SHA-256 checksums. |
| The venv lives in the sandbox home, not in your folder | Linux aarch64 binaries inside a macOS folder would confuse any Mac-side tooling, and the venv is fully reproducible from `requirements.txt`. |
| No `git init` yet | The sandbox may not delete files, and git deletes its own lock files, so git commands would leave stale `.lock` files. See Issues. |

## 5. Validation

| Check | Result |
|---|---|
| Checkpoint downloaded | `model.safetensors` 267,832,558 bytes; SHA-256 `7c3919835e44…b8aa` recorded in `models/hf/SHA256SUMS.txt` |
| Dataset downloaded | train 67,349 rows, validation 872 rows (444 positive / 428 negative), columns `sentence, label, idx` |
| Python imports | torch / transformers / onnx / onnxruntime import and run (proven by Phase 1) |

## 6. Issues

- **I-0.1:** No version control yet. Recommendation: either run `git init` in macOS Terminal yourself, or allow me delete permission for this folder so git works from the sandbox.
- **I-0.2:** Long-running jobs. Each sandbox command is limited to about 3 minutes, and background processes are killed when the command ends. Every long job is therefore written to be resumable (see the Phase 1 feature extraction).

## 7. Outcome and next phase

The plan, tracker, skeleton and environment are all ready. Phase 1 started on the same day.
