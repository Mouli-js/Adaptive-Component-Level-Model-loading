# Phase 7: Final Execution Checklist

**Date:** 1 Nov 2026 · **Plan:** `docs/PHASE_7_EXPERIMENT_PLAN.md` v1.2 · **Status: ready, NOT started.** Waiting for your go-ahead.

## A. Readiness (all done and checked)

| # | Item | Evidence |
|---|---|---|
| A1 | R1–R5 + D-7.1 to D-7.7 written into the plan (v1.2, §2–§8) | plan |
| A2 | Cloud suite: 10 blocks, exact matrices, resumable, randomised order, time-budgeted, failed attempts kept and retried as `retryOf` rows | `bench/phase7/suite.mjs` |
| A3 | Validator per block (counts, page errors, outputs = reference on every run, cache state, bytes, origin, determinism); outcomes reported, never used to fail a block | `bench/phase7/validate.mjs` |
| A4 | Every block smoke-tested (1 rep, ≤ 2 configs) **and validated: 10/10 VALID** | `results/phase7/_smoke/` (not results) |
| A5 | Offline passes listed: WASM 90, native x86 77, native aarch64 77, ORT 1.29 x86 5 | `bench/phase7/offline.mjs --list` |
| A6 | aarch64 native environment on your Mac's Linux sandbox reproduces the Phase 1 native file (max Δ 5e-7, 90.14%) | `results/phase7/_smoke/native-arm64/` |
| A7 | Mac page built and self-tested end-to-end in the cloud (quick mode, served as on your Mac): 21/21 steps, 0 failures, 0 page errors, cache state correct before every run | `results/phase7/_smoke/mac_selftest.json` |
| A8 | Network throttle re-checked in the smoke test: +3.12 / +1.25 / +0.67 / +0.17% | `_smoke/netcheck/` |
| A9 | Engine, runtime, package, baseline and demo **unchanged** (condition 1) | `git diff` (only `bench/`, `docs/`, `results/` change) |

**Problems found while preparing the suite, all fixed and re-validated:**

| # | Problem | Fix |
|---|---|---|
| S-1 | Temporary browser profiles were never deleted: 28 GB filled the workspace disk and IndexedDB writes failed with IOError | Every run's profile is deleted after it (revisit profiles after the last revisit); disk is checked between blocks |
| S-2 | **Random server port per invocation → IndexedDB (per origin) looked empty in the next invocation, so "warm" runs would silently have been cold** (caught by the validator) | Fixed port per link; primed profiles record their origin and are rebuilt if it differs (F-36). The pilot's warm runs were unaffected, because each primed and measured within one invocation. |
| S-3 | E5 revisits ran their one sentence twice (first request + 1-sentence workload) | `firstRequestOnly`: a revisit is exactly one request |
| S-4 | A failed row (interrupted run) blocked its own retry | Failed rows are kept; the key is retried as a new row with `retryOf` |
| S-5 | UA spot check on sequential plans waits ~60 s and measures nothing (no Workers alive) | Spot check only where Workers stay alive (as E1 already did) |
| S-6 | A test pass was written into the real aarch64 results folder | Moved to `_smoke/`; the real folder doesn't exist yet |

**Observation preserved (condition 2):** on the Mac page, state (a) created a session in 96 ms; in the cloud's fresh process it takes ~415 ms. A same-tab reload evidently keeps the compiled WASM module (F-37). Mac creation and cold-start times are therefore **not** compared with the cloud's (condition 3).

## B. Execution order (each block is validated before the next starts, condition 4)

| Step | Command (cloud unless noted) | Runs | Time | Validation gate |
|---|---|---|---|---|
| 1 | `offline.mjs native-x86`, then `native-x86-129` | 82 | ~10 min | 82 files, no failures.log |
| 2 | `offline.mjs native-arm64` (your Mac's sandbox, ~9 calls of 150 s, no action from you) | 77 | ~20 min | 77 files; batch-1 full int8 = Phase 1 file |
| 3 | `offline.mjs wasm` (E4 + E-B + F-5) | 90 | ~1.7 h | 90 files; chain int8 batch-1 hash = browser hash `1b4238…` |
| 4 | `suite.mjs acc` → `validate.mjs acc` | 12 | ~10 min | determinism (equal hashes), Δ = 0, exit points identical |
| 5 | `suite.mjs ebrowser` → validate | 2 | ~2 min | browser hash = Node WASM hash at batch 1 and 32 |
| 6 | `suite.mjs e1` → validate | 100 | ~20 min | 100 rows, cache off, outputs = reference, UA ≥ probe |
| 7 | `suite.mjs f28` → validate | 400 | ~20 min | identical primed cache, all bytes from IndexedDB |
| 8 | `suite.mjs eng` → validate | ~200 | ~25 min | one calibration file; warm = 10 entries & 0 bytes; cold = 0 entries |
| 9 | `suite.mjs e3bytes` → validate | 270 | ~15 min | every run cold; exit path = expected class |
| 10 | `suite.mjs netcheck` → validate | 4 | ~1 min | **±5% gate before any network block** |
| 11 | `suite.mjs net` → validate | 200 | ~1.7 h | cold visits from an empty cache; revisits 0 bytes, same origin; no fp32 at 5 Mbit/s |
| 12 | `suite.mjs e5x` → validate | 120 | ~40 min | as step 11 |
| 13 | `suite.mjs g1` → validate | 2 | ~2 min | warm copy, 0 bytes |
| 14 | **You:** Mac page (§C) | ~220 steps | ~25–30 min | after you send the JSON: same reference / cache checks per row |

**Total:** ~5.8 h of cloud compute (sharded into ≤ 10-min calls), ~20 min on your Mac's sandbox, ~30 min of your time. The disk is checked between blocks.

**If a block fails validation:** I stop, report the failing check and its cause, and don't start the next block until it's fixed and the block is re-run (as new rows). Failed attempts stay in the data.

## C. Your Mac run (step 14, any time after step 2)

1. Mac on power; close other tabs and heavy apps; keep the display awake.
2. In Terminal, from the project folder: `NO_CACHE=1 node demo/server.mjs`
3. In Chrome open **`http://localhost:8080/bench/phase7-mac.html`** (use `localhost`, not 127.0.0.1) and click **Start**.
4. Leave the tab in front. It reloads itself before every run (~25–30 min). If it stops, open the same URL again and click **Resume**.
5. When it says *Finished*, click **Download results JSON**. Then open the MAC-5 link on the page (`/bench/diag-fetch.html?threads=4`), run it and copy its JSON.
6. Send me both files.

## D. After the runs (no new scope)

1. **Analysis per experiment:**
   - medians, IQR and bootstrap CIs
   - McNemar tests
   - the E-ENG regret / rank / Spearman measures
   - the I-5.1 refit before/after (**a proposal for your approval, not applied**)
2. **Phase 7 report:** every hypothesis gets a verdict, including the unsupported ones. Unexpected results stay in. Cloud, Mac and each native platform are reported in separate tables.
3. **Your review** of the report before Phase 8.

## E. What I need from you

- **Go-ahead to start steps 1–13.**
- The Mac run (§C) whenever convenient.
