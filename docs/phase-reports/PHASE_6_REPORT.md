# Phase 6 — npm Package and Demo: Completion Report

**Planned:** 21–23 Nov 2026 · **Actual:** 31 Oct 2026 (Day 1) · **Status:** 🟨 Complete and verified (cloud), **awaiting your approval**

---

## 1. Phase overview

**Objective:** Turn Phases 1–5 into a library another developer can install and use through one small, documented API, without reading our code. The deciding test is a clean install of the **packed tarball** into an empty project, used only through that API.

| Deliverable | Status |
|---|---|
| `loadModel()` facade + `AdaptiveModel` (`infer`, `explainPlan`, `getCacheStats`, `replan`, `clearCache`, `dispose`) | ✅ `src/api.js` |
| Typed errors with codes | ✅ `AdaptiveLoaderError` (7 codes) |
| TypeScript types for the public API | ✅ `index.d.ts`; a strict consumer type-checks |
| Publishable package (`exports`, `types`, `files`, `sideEffects`, exact peer dependency, LICENSE) | ✅ 33.8 KiB tarball, 30 files |
| README (install, isolation headers, API, decision process, measured behaviour, limitations) | ✅ |
| Demo built only on the public API | ✅ `demo/index.html` (screenshot: `docs/images/demo_mid_profile.png`) |
| Pack → clean install → Node smoke → TypeScript check | ✅ 8/8 |
| Browser test of the **installed tarball** | ✅ 17/17 |
| Regressions | ✅ Phase 5 53/53 · Phase 3 (B, C, D) 17/17 · Phase 2 5/5 · unit 38/38 |

## 2. The public API

```js
import { loadModel } from 'adaptive-onnx-loader';
const model = await loadModel({ manifestUrl: '/models/onnx/manifest.json', profile: 'mid' });
model.explainPlan();                  // { planId, explanation[6], predicted, budget, candidates, runnersUp, … }
await model.infer('great film');      // { label, score, logits, exitAt }  (array in -> array out)
await model.getCacheStats();          // IndexedDB entries/usage/quota + live Workers, live/peak WASM, Worker starts
await model.replan({ profile: 'low' });
await model.clearCache(); model.dispose();
```

**Inside `loadModel()`:** it validates options and the environment (cross-origin isolation, Workers), loads the manifest, vocabulary and (if early exit is requested) `early_exit.json`, opens the IndexedDB store, then runs the Phase 5 engine via `replan()`. `AdaptiveModel` holds one `PlanRunner`, whose pinned Workers persist across `infer()` calls. `infer()` calls are **serialised** through a promise queue, so two calls can never drive the same Workers at once.

**Errors:** every failure is an `AdaptiveLoaderError` with a `code`.

| Code | When |
|---|---|
| `BAD_OPTIONS` | missing or invalid `manifestUrl`, `infer()` given something other than strings, or no `ortUrl` outside a page |
| `NOT_ISOLATED` | page lacks COOP/COEP (the message names the two headers) |
| `NO_WORKERS` | no Web Workers in this environment |
| `MANIFEST` | manifest can't be fetched or parsed |
| `NO_FEASIBLE_PLAN` | no plan fits; the message **is** the engine's explanation and `details.decision` has the full decision |
| `EARLY_EXIT_UNAVAILABLE` | early exit requested without its metadata |
| `DISPOSED` | the model has been disposed |

## 3. Technical decisions

| Decision | Alternatives | Why |
|---|---|---|
| **One facade** (`loadModel`) over the Phase 2–5 modules; the building blocks are still exported as "Advanced" | Expose only the low-level classes | A user needs 5 methods. Researchers can still reach every part. |
| **Calibration off by default** | Always calibrate | Calibration takes ~7 s and makes decisions device-specific. Off by default keeps decisions deterministic, as you required. |
| **Early-exit metadata shipped next to the model** (`models/onnx/early_exit.json`: τ and the measured per-plan accuracy) | Library reads `results/` | Results folders are a project detail; a library must only depend on model artifacts |
| **Worker URL from `new URL('./workers/chunkWorker.js', import.meta.url)`**; ORT URL as an option | Bundle ORT into the Worker | Import maps don't apply in Workers. Passing ORT's URL keeps `onnxruntime-web` a **peer dependency** (one copy, chosen by the app) |
| **Exact peer version** `onnxruntime-web 1.20.1` | `^1.20.0` | Every result (bit-identical int8, heap sizes) was measured on 1.20.1; a minor upgrade could change kernels |
| **Hand-written `index.d.ts`** | Migrate the code to TypeScript | Keeps the code as plain ES modules; the types describe exactly the public contract, and a strict consumer compile checks them |
| **`files` whitelist** | `.npmignore` | Only what's listed ships (no tests, fixtures or benchmarks) |
| **`sideEffects: false`** | — | Lets bundlers drop unused exports (e.g. the Advanced classes) |
| **MIT licence**, author Moulieswaran M | — | Already in `package.json` since Phase 2. **Please confirm or tell me which licence you want.** |

## 4. Validation

### 4.1 Packaging (`bench/phase6_pack_test.mjs`, run on your machine's sandbox)

| Check | Result |
|---|---|
| Tarball contains only `src/`, `index.d.ts`, `README.md`, `LICENSE`, `package.json` | ✅ 30 files, 33.8 KiB packed / 100.3 KiB unpacked |
| No tests, fixtures or `node_modules` | ✅ |
| Worker script included | ✅ |
| Installs by name into an empty project (with `onnxruntime-web@1.20.1`) | ✅ |
| Node: import by package name; tokenizer output | ✅ `[101,7592,1010,2088,999,102]` for "Hello, World!" |
| Node: decision engine through the package | ✅ Low → `int8\|sequential\|…` |
| Node: `loadModel` throws the typed `NOT_ISOLATED` | ✅ |
| **TypeScript strict consumer** (`tsc --noEmit`, `strict: true`) | ✅ no errors |

### 4.2 Browser test of the installed tarball (`bench/phase6_browser_test.mjs`, CLOUD-HL-1T)

The test builds a fresh consumer project from the **tarball**, copies only the model artifacts and the reference fixtures, serves it with the unchanged `demo/server.mjs`, and drives `bench/phase6_consumer/app.js`. That app imports **only** `loadModel` and `AdaptiveLoaderError` from `node_modules/adaptive-onnx-loader`.

| # | Check | Result |
|---|---|---|
| 1 | No page errors | ✅ |
| 2 | Low profile → int8 sequential | ✅ |
| 3 | Outputs = WASM reference (7 sentences, array and single string) | ✅ Δ = 0 |
| 4 | Labels and scores consistent; a single string returns an object | ✅ |
| 5 | 4 int8 chunks cached in IndexedDB | ✅ |
| 6 | Sequential leaves 0 live Workers between calls | ✅ (peak 77.19 MiB, 28 Worker starts) |
| 7 | `replan({profile:'high'})` → fp32 resident | ✅ |
| 8 | fp32 outputs = reference | ✅ Δ = 0 |
| 9 | 4 resident Workers, live WASM 813.31 MiB | ✅ |
| 10 | `replan({earlyExit:true})` without metadata → `EARLY_EXIT_UNAVAILABLE` | ✅ |
| 11 | `dispose()` → 0 live Workers; `infer()` → rejects with `DISPOSED` | ✅ |
| 12 | Early exit opted in (Low, floor 0.895, 32 sentences) → plan `…ee=1` | ✅ |
| 13 | Early-exit outputs **and exit points** = reference | ✅ Δ = 0, 0 mismatches (8 / 10 / 14 exits) |
| 14 | `clearCache()` empties IndexedDB | ✅ |
| 15 | Infeasible budget → `NO_FEASIBLE_PLAN`, message = explanation | ✅ |
| 16 | `cache:false` → nothing stored | ✅ |
| 17 | `loadModel({})` → `BAD_OPTIONS` | ✅ |

### 4.3 Two API bugs found by the consumer test (fixed, now unit-tested)

| Bug | Effect | Fix |
|---|---|---|
| `getCacheStats()` after `dispose()` threw `InvalidStateError` (IndexedDB connection closing) | A natural call sequence crashed | After `dispose()` it reports runtime state with `disposed: true` and doesn't touch IndexedDB (type updated) |
| `infer()` on a disposed model threw **synchronously** instead of returning a rejected promise | `model.infer(x).catch(…)` wouldn't catch it | `infer()` always reports errors through its promise; covered by unit test `api.test.mjs` #7 |

Each fix was followed by a fresh `npm pack`, clean install and the full 17-check browser run.

### 4.4 Demo (`demo/index.html`, public API only)

An automated walk-through in Chromium:

1. Load with the **Mid** profile, giving `mixedC2|resident|…`.
2. Classify 3 lines: POSITIVE 99.99%, NEGATIVE 99.98%, POSITIVE 99.99%.
3. Live state: 4 Workers, 355.06 MiB against a 435.2 MiB usable budget (82%).
4. Re-plan to **Low**, giving int8 one-at-a-time; classify.
5. **Dispose**, after which the status reads "all chunk Workers terminated, memory returned".

No page or console errors. Screenshot: `docs/images/demo_mid_profile.png`.

Two demo issues were found and fixed:

- **Opening the demo at `/` failed to load its script.** A relative script path resolved against `/` instead of `/demo/`; the path is now absolute.
- **Scores showed 100.0%.** One decimal place hid the model's real confidence; two decimals now show it. The model is very confident on these sentences (DistilBERT-SST2 is known to be over-confident).

## 5. Files and components

**New:**

- `packages/adaptive-onnx-loader/src/api.js`, `index.d.ts`, `README.md`, `LICENSE`, `test/api.test.mjs` (7 tests)
- `demo/index.html`, `demo/index.js`
- `bench/phase6_pack_test.mjs`, `bench/phase6_browser_test.mjs`, `bench/phase6_consumer/{index.html,app.js}`, `bench/build_early_exit_meta.mjs`
- `models/onnx/early_exit.json` (tracked)
- `docs/images/demo_mid_profile.png`
- `results/phase6/{pack_test,consumer_browser_test,regression_*}.json`
- The tarball `results/phase6/adaptive-onnx-loader-0.1.0.tgz` is kept locally but **git-ignored** (`*.tgz`); it can be rebuilt with `npm pack`.

**Changed:** `packages/adaptive-onnx-loader/package.json` (metadata), `src/index.js` (+1 export line). **The baseline and Phase 3–5 modules are unchanged.**

## 6. Issues and limitations

| ID | Item | Severity | Action |
|---|---|---|---|
| I-6.1 | **The cost model and accuracy table are specific to this model** (`measurements.js`). The package as published only "knows" DistilBERT-SST2. | Medium (scope) | Documented in the README. Generalising means a measurement step per model (future work). |
| I-6.2 | The default `ortUrl` assumes `/node_modules/…` on the page's origin | Low | Documented option; bundler users pass `ortUrl` and `workerUrl` |
| I-6.3 | The demo's predicted "initial load" uses the **profile's simulated link** (e.g. Mid: 10 Mbit/s cold → 89.8 s), not this machine | Low | The explanation names the profile; choose "this browser" to use real signals |
| I-6.4 | Package not published to the npm registry | — | Publishing is your decision (name availability, licence, account) |
| I-6.5 | Bundler integration (Vite, webpack) not tested | Low | Phase 7, optional |
| I-6.6 | Licence choice (MIT) needs your confirmation | — | §3 |
| I-5.1 (carried) | Hybrid / pre-start time predictions 23–35% optimistic | Medium | Phase 7 |

## 7. Recommended Mac check (~2 min)

`npm run serve`, then open **http://localhost:8080/** (the demo is now the home page):

1. **Load model**, then **Classify**.
2. Switch the profile to **low**, then **Re-plan**, then **Classify**.
3. **Dispose**.

Tell me if anything looks wrong. A screenshot of the "Why this plan" panel with **Profile = this browser** would show what the engine picks for your real Mac.

## 8. Next phase: Phase 7, experiments (planned 24–27 Nov)

The full evaluation matrix from the master plan (§5):

- 6 metrics × 3 device profiles × policies × precision settings, with ≥ 5 repetitions
- **E-B** (batch-size dependence, F-6) and the **F-5** native-vs-WASM table (both required)
- a time-model refit for hybrid and pre-start plans (I-5.1)
- a thread sweep on your Mac (F-13)
- the network sweep (I-4.4)

I'll propose the exact run matrix and its estimated duration before starting, because part of it needs your Mac.

---

## 9. Addendum: demo explainability improvements after your review (31 Oct 2026)

You reviewed the demo on your Mac (screenshots: High profile with early exit requested; "this browser" with early exit used) and asked for six additions plus an "alternatives considered" box, with **all values from the engine or runtime**, diagnostics collapsible, and the layout and style unchanged.

### 9.1 What was added (in your priority order)

| # | Request | Implementation | Source of the values |
|---|---|---|---|
| 1 | Explain why early exit isn't used; show τ when it is | Note under the plan id. **Not used:** names the hard constraint and numbers, e.g. *"no early-exit plan satisfies the hard constraints (237 rejected for accuracy — best early-exit accuracy 90.71% < 91.0% floor; 0 for memory). Running full inference instead."* If early-exit plans were feasible but ranked lower, it says so with costs. **Used:** shows τ = 0.95 and that it was tuned on the dev split. | `explainPlan().earlyExit`, derived from the engine's per-candidate trace |
| 2 | Predicted vs measured memory | Table in *Live state*: predicted peak (all components, ×1.1 margin), predicted Worker WASM without margin, **measured** peak Worker WASM, prediction error, usable budget. Like-for-like rows are labelled explicitly. | `explainPlan().predicted.memory`, `getCacheStats().runtime.peakWasmMiB` |
| 3 | Per-sentence execution details | Each result expands to show label, model confidence, **execution path** (e.g. C0 → C1 → C2 → exit head E2), where it stopped, time inside the Workers plus transfer, and logits | `infer()` → `path`, `exitAt`, `computeMs`, `transferMs` |
| 5 | Profile comparison | "Same model, different devices": Low / Mid / High / this browser, each with usable memory, selected plan, predicted peak, ms/sentence, accuracy and feasible count. **Previews only**, and **refreshed after every action** (see 9.3). | `model.previewPlan({ profile })` (new; pure) |
| 6 | Experiment / debug view (collapsed) | Device signals **with the source of each value**; calibration values; candidates generated and rejected by reason; predicted vs measured time; Worker starts | `explainPlan()` (`context`, `calibrationValues`, `candidates`), `infer()`, `getCacheStats()` |
| 4 | Confidence ≠ accuracy | Column header "Label · model confidence ⓘ" with a tooltip explaining the difference; "(not accuracy)" in each detail | text only |
| + | Alternatives considered | A scrolling box in *Why this plan*: one row per plan family (3 precisions × 3 modes × early exit on/off). Each row shows **chosen**, **feasible** (best plan, rank, cost) or **rejected** (the hard constraint, e.g. "accuracy 90.71% < 91.0% floor"), plus how many candidates the family has. | `explainPlan().alternatives` |

### 9.2 Instrumentation added to the library (output-only, verified)

The engine and runner already computed this information internally but didn't return it. Rebuilding it in the demo would have meant duplicating engine logic, so the values would no longer have "come from the engine". So I added three things, none of which changes behaviour:

- **`decide({ …, trace: true })`** returns one record per candidate: status, rejection reason and detail, predicted memory, accuracy, cost and rank. **Unit test:** for every profile, with and without early exit, the decision is **byte-identical** with and without `trace`, and the trace's counts equal the engine's counts.
- **`PlanRunner`** records, for each sentence, the chunks visited, the time inside the Workers and the transfer time. **Check:** the full Phase 5 suite still passes **53/53** (outputs and exit points identical to the references), and the consumer test confirms the outputs again.
- **API:** `infer()` results gain `path`, `computeMs` and `transferMs`. `explainPlan()` gains `earlyExit`, `alternatives`, `context` and `calibrationValues`, plus `{ full: true }` for the raw trace. There's a new `previewPlan()` that changes nothing. All of it is typed in `index.d.ts`.

### 9.3 Two pitfalls found while building the demo, and how they're shown honestly

| Pitfall | What happened | Resolution |
|---|---|---|
| **A preview can go stale** | The comparison table showed Mid → mixedC2 …, but re-planning to Mid a moment later chose fp32 …. In between, the High run had cached the fp32 chunks, and the engine (correctly) counts cached chunks as cheaper to load. | The table refreshes after every action and states that it depends on the current cache contents. Re-test: the preview immediately before re-planning matches the chosen plan. |
| **Wall time ≠ predicted compute** | The debug view first showed predicted 217.5 ms next to measured wall time 3,587 ms, which looks like a 16× error. The wall time included 4 Worker starts. | It now shows like-for-like rows: predicted compute + transfer vs measured compute + transfer (fp32 resident: 217.5 vs 165.5 ms, +31% on 3 short sentences). Wall time is listed with the number of Worker starts it included, and the initial-load prediction is labelled as using the **profile's** simulated link. |

**Interpreting the compute error with early exit.** In the Mid + early-exit screenshot the error is +67%. The prediction is an *expectation* over the validation set's exit rates (59% of sentences reach C3), but none of these 3 sentences reached C3 (1 exited at E1, 2 at E2). That's a small-sample effect, not a model fault. Phase 7 measures time over the full validation set.

### 9.4 Validation after the changes

| Test | Result |
|---|---|
| Unit tests (incl. new trace-is-output-only and alternatives tests) | ✅ **40/40** |
| Pack → clean install → Node → strict TypeScript | ✅ 8/8 (tarball 36.1 KiB) |
| **Installed-tarball browser test**, extended with 5 checks (paths, alternatives cover all 237 candidates, early-exit status, `previewPlan` changes nothing, τ and exit-head paths) | ✅ **22/22** |
| Phase 5 suite (regression for the runner instrumentation) | ✅ 53/53 |
| Demo walk-throughs (High + early exit requested → not used; Mid + early exit → used), no page errors | ✅ screenshots `docs/images/demo_high_earlyexit_requested.png`, `docs/images/demo_mid_earlyexit_used.png` |

No new charts, animations or decorative elements were added, and the layout and visual style are unchanged.

## 10. Licence decision (31 Oct 2026)

- **Your confirmation:** package `adaptive-onnx-loader`, **MIT**, copyright holder and author **Moulieswaran M** (`packages/adaptive-onnx-loader/LICENSE`).
- **Kept separate, as you asked:** a repository-level **`THIRD_PARTY_NOTICES.md`**, plus a short note in the package README. The licences were checked on 31 Oct 2026 against the sources, not stated from memory:

| Component | Licence (source) | Relationship to the package |
|---|---|---|
| DistilBERT-SST2 weights and our derived ONNX / int8 / exit-head files | Apache-2.0 (model card) | Not in the package; git-ignored. If redistributed: include the Apache-2.0 licence and state the modifications. |
| SST-2 data | **unknown** (dataset card) | Evaluation only; git-ignored; not redistributed; Socher et al. 2013 cited |
| onnxruntime-web 1.20.1 | MIT, © Microsoft (package.json) | Peer dependency; not bundled |
| fake-indexeddb 6.0.0 | Apache-2.0 (package.json) | devDependency; not in the tarball |

The tarball was rebuilt for the README change. Unpacking both tarballs and diffing them shows **only `README.md` differs**, so the 22/22 installed-tarball result applies to the committed code. Packaging was re-run (8/8) and unit tests (40/40).

