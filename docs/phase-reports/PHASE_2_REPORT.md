# Phase 2 — Baseline Browser Inference: Completion Report

**Planned:** 7–9 Nov 2026 · **Actual:** 31 Oct 2026 (Day 1) · **Status:** 🟨 Complete and verified, **awaiting your approval**
**One deviation needs your sign-off:** the int8 acceptance criterion (§8, D-2.1).

---

## 1. Phase overview

**Objective:** Run the conventional approach (the whole model, one `InferenceSession`) in a real browser, and prove it is correct. This is the **baseline** that every adaptive policy in Phases 3–7 will be compared against, so it has to be correct, measurable and reproducible.

| Planned deliverable | Status |
|---|---|
| Static server with COOP/COEP (cross-origin isolation) | ✅ `demo/server.mjs` (a plain Node server replaced Vite; see D-2.2) |
| JS WordPiece tokenizer identical to Python | ✅ 26/26 edge cases, 872/872 SST-2 sentences |
| `full.onnx` fp32 + int8 running in onnxruntime-web | ✅ |
| Browser accuracy = reference accuracy | ✅ fp32 91.06% = 91.06%; int8 90.02% = 90.02% (WASM reference, see D-2.1) |
| `measureUserAgentSpecificMemory` working | ✅ (requires full Chromium; see §4) |
| Automated headless-Chromium test | ✅ `bench/phase2_browser_test.mjs`, 20/20 checks pass |

## 2. Headline results

Measured in headless Chromium 153 on the cloud workspace (x86-64, 2 vCPU), cross-origin isolated, 872 sentences at batch size 1, after 3 warm-up runs.

| Config | Accuracy | vs reference | Download | Load total (fetch + session) | p50 / p90 latency | WASM heap | Page memory (UA API) |
|---|---|---|---|---|---|---|---|
| fp32, 1 thread | **91.06%** | max \|Δ\| 2.6e-5 vs PyTorch, 100% agree | 267.9 MB | 1569 ms (684 + 884) | 70.2 / 105.8 ms | **656 MiB** | 661 MiB |
| fp32, 2 threads | **91.06%** | same | 267.9 MB | 1793 ms (904 + 889) | **37.1** / 55.7 ms | 657 MiB | 661 MiB |
| int8, 1 thread | **90.02%** | Δ **0.0** vs WASM reference, 100% agree | 67.4 MB | 752 ms (169 + 583) | 43.1 / 65.4 ms | **180 MiB** | 185 MiB |
| int8, 2 threads | **90.02%** | same | 67.4 MB | 948 ms (309 + 638) | **27.6** / 42.5 ms | 181 MiB | 185 MiB |

Raw data: `results/phase2/browser_baseline_fp32.json`, `results/phase2/browser_baseline_int8.json`.

**Four findings that shape the rest of the project:**

1. **The model's memory footprint is ~2.6–2.8× its file size.** The 255.5 MiB fp32 file needs 656 MiB of WASM heap; the 64.2 MiB int8 file needs 180 MiB. The bytes are held in more than one form during loading: the fetched buffer, a copy inside WASM, and the parsed and optimised weights.
2. **The WASM heap never shrinks.** After `session.release()` the heap stays at 656 / 180 MiB. In one page, "unloading" a model frees nothing the OS can see. This is the direct evidence for running each chunk in its own **Worker** in Phase 3, because terminating a Worker does free its heap.
3. **int8 is ~3.6× lighter in memory and loads ~2× faster,** at a cost of 1.04 accuracy points in the browser.
4. **The WASM-heap probe is a valid memory metric.** It agrees with Chrome's own whole-page measurement to within ~4–5 MiB. This matters because the official API becomes very slow once Workers exist (§4).

## 3. Implementation details

### 3.1 Tokenizer (`packages/adaptive-onnx-loader/src/tokenizer/wordpiece.js`)

The model only understands token IDs, so the browser must turn text into **exactly** the IDs Python produced during training. One wrong ID silently changes predictions.

`WordPieceTokenizer` re-implements Hugging Face's `BertTokenizerFast` (uncased) with no dependencies. The steps, in order:

| Step | Method | What it does | Example |
|---|---|---|---|
| 1. Clean | `normalize()` | Drops NUL, U+FFFD and control/format chars (`\p{C}`); maps every whitespace char (`\t \n \r`, `\p{Zs}`) to a space | `"zero​width"` → `"zerowidth"` |
| 2. CJK | `normalize()` | Puts spaces around CJK ideographs so each one becomes a word | `"中文"` → `" 中  文 "` |
| 3. Strip accents | `normalize()` | Unicode NFD, then removes combining marks (`\p{Mn}`) | `"amélie"` → `"amelie"` |
| 4. Lowercase | `normalize()` | `toLowerCase()` | |
| 5. Pre-tokenize | `preTokenize()` | Splits on spaces; every punctuation char becomes its own token. BERT counts **all non-alphanumeric ASCII** as punctuation (`$ ^ \``), plus Unicode `\p{P}` | `"don't"` → `don ' t` |
| 6. WordPiece | `wordPiece()` | Greedy **longest-match-first** against the 30,522-token vocab. Pieces after the first get a `##` prefix. If any part can't be matched, the **whole word** becomes `[UNK]`. Words over 100 chars → `[UNK]` | `"emoji"` → `em ##oj ##i` |
| 7. Specials | `encode()` | `[CLS] … [SEP]`, truncated to 128 | |
| Batch | `encodeBatch()` | Pads to the longest sequence with `[PAD]`=0 and builds `attention_mask`. Returns `BigInt64Array`s, because ONNX `int64` maps to JS `BigInt` | |

Important details:

- `for (const ch of text)` iterates by **code point**. Emoji such as 😀 are two UTF-16 units but one character to the tokenizer.
- `Array.from(word)` keeps WordPiece slicing on code points too.

**Tests** (`test/tokenizer.test.mjs`, run with `npm run test:unit`, 4/4 pass):

- vocab size 30,522 and special IDs `[PAD]=0 [UNK]=100 [CLS]=101 [SEP]=102`
- 26 hand-picked edge cases (accents, ß, ligatures, İ, CJK, emoji, tabs and newlines, zero-width chars, NUL, U+FFFD, a 150-char word, `$ ^ \` ~ { }`, typographic quotes, Arabic digits, full-width letters, 200-word truncation) compared against Python's IDs (`python/export_tokenizer_edge_cases.py`)
- all 872 validation sentences compared against Python's IDs
- batch padding and mask correctness

### 3.2 Server (`demo/server.mjs`)

This is a ~50-line static file server. Its one important job is to send two headers:

```
Cross-Origin-Opener-Policy: same-origin
Cross-Origin-Embedder-Policy: require-corp
```

Together they make the page **cross-origin isolated** (`self.crossOriginIsolated === true`). Browsers only allow `SharedArrayBuffer` in isolated pages, a protection against Spectre-style attacks. onnxruntime-web needs `SharedArrayBuffer` to run WASM on several threads, and `measureUserAgentSpecificMemory()` also requires isolation.

The server also sets correct MIME types (`.wasm` must be `application/wasm`) and blocks `../` path traversal. `NO_CACHE=1` adds `Cache-Control: no-store`, so tests always measure real downloads.

### 3.3 Baseline runner (`src/baseline/fullModel.js`)

`FullModelRunner.create(ort, url)` does three things: fetches the bytes (timed as `fetchMs`), calls `ort.InferenceSession.create(bytes, {executionProviders:['wasm'], graphOptimizationLevel:'all'})` (timed as `createMs`), and returns the runner. `classify(tokenizer, texts)` builds the two `int64` tensors and calls `session.run()`.

The `ort` object is **injected** as a parameter instead of imported. That lets the same class run in a page, in a Worker (Phase 3) and in Node (tests) without changing any import paths.

### 3.4 Memory measurement (`src/metrics/memory.js`)

There are three sources, because no single one is good enough:

| Source | Covers | Caveat found in this phase |
|---|---|---|
| `performance.measureUserAgentSpecificMemory()` | Whole page incl. WASM | Missing from Playwright's default headless *shell*. Waits ~16 s for a GC unless launched with `--enable-blink-features=ForceEagerMeasureMemory`. **Takes ~60 s per call once ORT's worker threads exist.** |
| **WASM heap probe** (`installWasmMemoryProbe()`) | ORT's linear memory | Wraps the `WebAssembly.Memory` constructor **before** ORT starts, keeps a reference to each memory it creates, and reads `buffer.byteLength`. Instant, works in any context, agrees with the UA API to within ~5 MiB. |
| `performance.memory.usedJSHeapSize` | JS heap only | **Useless here:** Chrome rounds it (it reported exactly 10,000,000), and it excludes WASM memory. |

### 3.5 Demo page and automated test

- `demo/phase2-baseline.html` + `.js`: interactive page (choose precision and threads, load, classify any sentence, show tokens, run the full validation). It exposes `window.phase2.benchmark()` for automation.
- `bench/phase2_browser_test.mjs`: starts the server, then runs each configuration in a **fresh browser process**. That's necessary because the heap never shrinks, so a second run in the same page would inherit the first run's memory. It runs all 872 sentences and checks 5 criteria per configuration.

## 4. Technical decisions

| Decision | Alternatives | Why |
|---|---|---|
| **Own tokenizer** instead of Transformers.js's | Transformers.js `AutoTokenizer` | ~200 lines, no dependency, proven identical on 898 inputs. It also keeps the project's claim clean: no high-level library anywhere in the pipeline. |
| **Plain Node server** instead of Vite | Vite + plugin for headers | Vite's dependency pre-bundling is known to clash with onnxruntime-web's `.wasm`/`.mjs` loading, and a dev server adds nothing here. The Node server makes the isolation headers explicit and easy to explain. (D-2.2) |
| `ort.wasm.min.mjs` + import map | The full `ort.min.mjs` bundle | WASM backend only (WebGPU is out of scope), so the download is smaller. The import map keeps the source free of hard-coded paths. |
| Batch size 1 for validation | Batch 32 | Matches the real interactive use case. Avoids padding effects, which matter for int8 (§5). |
| Fresh browser per config | Reuse one page | The heap never shrinks, so reuse would contaminate memory figures. |
| Full Chromium (`channel:'chromium'`) + `ForceEagerMeasureMemory` | Default headless shell | Needed for the UA memory API to exist and return quickly. |
| `wasmHeapBytes` as the primary memory metric from Phase 3 on | UA API | Instant and accurate, and works inside Workers. The UA API takes ~60 s per call once workers exist. |

## 5. The int8 investigation (why the criterion changed)

The first full run **failed** one check: browser int8 accuracy was 90.02%, but native Python ONNX Runtime int8 gave 90.14%. That's a difference of exactly **one sentence** out of 872. I investigated before changing anything (`python/diag_int8_parity.py`, `bench/diag_int8_parity.mjs`, results in `results/phase2/int8_parity_diagnosis.json`):

| Comparison (872 sentences) | Mean \|Δlogit\| | Max \|Δlogit\| | Prediction flips |
|---|---|---|---|
| Native CPU, optimisations on vs off | 0.0014 | 0.23 | 0 |
| WASM, optimisations on vs off | 0.0010 | 0.24 | 0 |
| **Native CPU vs WASM** | 0.018 | 1.21 | **1** (sentence 702) |
| Browser WASM (x86 Chromium) vs Node WASM (ARM) | **0** | **0** | 0 |

**Conclusions:**

- Graph optimisation is **not** the cause. The difference comes from the **int8 kernel implementations**: native ONNX Runtime uses CPU-specific code paths, while the WASM build uses portable WASM SIMD code. They round quantized activations and accumulations differently.
- ORT-web's WASM int8 output is **bit-identical across platforms**: x86 browser and ARM Node produce exactly the same results.
- Sentence 702 ("…pinocchio… borders on the grotesque", label negative) sits right on the boundary. Native int8 scores it −1.69 and WASM +0.008. **fp32 also gets it wrong** (+4.23), so native int8 got it right by chance.

**Second finding (dynamic quantization depends on the batch):** native int8 scores 90.37% at batch size 32 (Phase 1) but 90.14% at batch size 1. Dynamic quantization computes **one** activation scale per tensor, and with batching that tensor includes the other sentences and the padding. So with int8 a sentence's prediction can depend on what it's batched with. fp32 doesn't have this property. The runtime should therefore use batch size 1 or report the effect.

## 6. Why each part matters

| Component | Role later |
|---|---|
| `WordPieceTokenizer` | Shared by every policy; goes straight into the npm package (Phase 6) |
| `FullModelRunner` | The **FULL** baseline in the Phase 7 experiments |
| `installWasmMemoryProbe` / `wasmHeapBytes` | Primary memory metric (M3) for chunk Workers in Phase 3 |
| Isolation server | Required for threads and memory measurement in every later phase |
| Playwright harness | Becomes the experiment runner in Phase 7 (add throttling, profiles, policies) |
| Baseline numbers (§2) | The comparison point for every hypothesis H1–H5 |

## 7. Files and components

**Created**

| Path | Purpose |
|---|---|
| `package.json`, `package-lock.json` | Root workspace: `onnxruntime-web 1.20.1`; scripts `serve`, `test:unit`, `test:browser` |
| `packages/adaptive-onnx-loader/package.json` | The library package (ES module, `onnxruntime-web` as a peer dependency) |
| `packages/adaptive-onnx-loader/src/index.js` | Public exports |
| `packages/adaptive-onnx-loader/src/tokenizer/wordpiece.js` | Tokenizer |
| `packages/adaptive-onnx-loader/src/baseline/fullModel.js` | Baseline runner |
| `packages/adaptive-onnx-loader/src/metrics/memory.js` | Memory measurement |
| `packages/adaptive-onnx-loader/test/tokenizer.test.mjs` | Tokenizer tests (Node test runner) |
| `packages/adaptive-onnx-loader/test/fixtures/tokenizer_edge_cases.json` | 26 Python-generated edge cases (tracked) |
| `demo/server.mjs` | Isolation server |
| `demo/phase2-baseline.html`, `demo/phase2-baseline.js` | Baseline page |
| `bench/phase2_browser_test.mjs` | Automated browser test |
| `bench/diag_int8_parity.mjs`, `python/diag_int8_parity.py` | int8 diagnosis |
| `python/export_browser_fixtures.py`, `python/export_tokenizer_edge_cases.py` | Fixture generators |
| `results/phase2/browser_baseline_{fp32,int8}.json`, `results/phase2/int8_parity_diagnosis.json` | Evidence |
| `data/sst2/{validation,py_token_ids,py_logits,py_ort_int8_logits,wasm_int8_logits_all,wasm_int8_logits_disabled}.json` | Fixtures (git-ignored, regenerable) |

No Phase 0–1 file was modified.

## 8. Validation summary

| # | Test | Result |
|---|---|---|
| V1 | Tokenizer unit tests (4) incl. 26 edge cases and 872 sentences | ✅ 4/4 |
| V2 | Server sends COOP/COEP/CORP, correct `.wasm` MIME type, blocks traversal | ✅ (checked with `curl`) |
| V3–V7 | Browser fp32, 1 and 2 threads: isolated · tokenizer parity · accuracy 91.06% · \|Δ\| 2.6e-5 · 100% agreement | ✅ 10/10 |
| V8–V12 | Browser int8, 1 and 2 threads: isolated · tokenizer parity · accuracy 90.02% · \|Δ\| 0.0 · 100% agreement | ✅ 10/10 |
| V13 | WASM probe vs UA API | ✅ within 4–5 MiB |
| V14 | Heap after `release()` | Confirmed it does **not** shrink (656 → 656 MiB) |

## 9. Issues, limitations and deviations

| ID | Item | Severity | Status / action |
|---|---|---|---|
| **D-2.1** | **Changed int8 criterion.** The plan said browser accuracy must equal "Python accuracy". For int8, Python's native kernels differ from WASM's (§5). The new gate is "identical to onnxruntime-web's WASM kernels" (Node reference); this passes with Δ = 0.0. The native difference (1 sentence, 0.11 points) is reported, not hidden. | Medium | **Needs your approval** |
| D-2.2 | Vite replaced by a plain Node server | Low | Reason in §4 |
| I-2.1 | **All numbers come from the cloud workspace's headless Chromium (2 vCPU, x86), not your Mac.** Absolute latencies will differ on your machine. | Medium | Please run the manual check below; real-device numbers are in Phase 7 anyway |
| I-2.2 | `measureUserAgentSpecificMemory` takes ~60 s per call when worker threads exist | Medium | From Phase 3 on, use the WASM probe as the main metric and call the UA API only at a few checkpoints |
| I-2.3 | The heap baseline (ORT's own overhead before any model) wasn't separated out | Low | Measure it in Phase 3 (create a tiny session first) |
| I-2.4 | The 2-thread speedup (~1.9×) was measured on a 2-vCPU machine; more threads weren't tested | Low | Phase 7 tests on your Mac |
| I-2.5 | One stray empty file, `.git/tD4w3kG`, left over from `git init` | Info | Safe to delete in Finder/Terminal |
| I-2.6 | Phase 2 files are not committed yet | — | Commit after your approval (command below) |

## 10. Manual check on your Mac (recommended, ~2 min)

The sandbox can't run a browser, so please confirm on your real machine. In **macOS Terminal**:

```bash
cd ~/"Project - 1"
node -v                # needs Node 18+; if missing: brew install node
npm run serve          # starts http://localhost:8080
```

Open **http://localhost:8080/demo/phase2-baseline.html** in Chrome. "Cross-origin isolated" should say **yes**. Click **Load model**, then **Classify**, then **Run SST-2 validation**: int8 accuracy should be 0.9002 and fp32 0.9106. Paste me the JSON output if you'd like your Mac's numbers added to the report.

## 11. Outcome

The conventional approach now runs correctly in the browser and has been measured. The two main results are a **656 MiB heap for a 268 MB model** and a **heap that never shrinks**. Together they quantify the problem this project addresses, and they justify the Worker-per-chunk design.

## 12. Next phase: Phase 3, chunked execution and Workers (planned 10–13 Nov)

**Objective:** Run the 4 chunks as separate sessions, first on the main thread and then **one Worker per chunk**. Prove the output equals the baseline exactly, and show that terminating a Worker really frees memory.

**Tasks:**

1. `ChunkSession` and `ChainRunner`: load 4 sessions from the manifest, pass `hidden` → `hidden_in`, compare against the baseline (fp32 Δ < 1e-4; int8 Δ = 0 vs the WASM reference).
2. Worker version: `chunkWorker.js` hosts one session; tensors move between workers as **transferable `ArrayBuffer`s** (no copying).
3. SEQUENTIAL mode: load → run → terminate one worker at a time, recording the peak total WASM heap. Hypothesis H1: the peak falls from ~656 MiB to roughly the largest single chunk (C0: 95 MB file).
4. Measure ORT's base heap overhead (I-2.3) and the cost of passing tensors between workers.

**Dependencies:** Phase 1 chunk artifacts ✅, the Phase 2 tokenizer, probe, server and harness ✅. The 4 fp32 + 4 int8 chunks (~335 MB) must be copied to the cloud workspace for the browser tests.

**Viva topics coming in Phase 3:** Web Workers and message passing, transferable objects, why terminating a worker is the only way to return WASM memory, and pipeline parallelism.

---

## 13. Addendum after review (31 Oct 2026)

**Your decisions:**

- **D-2.1 approved.** Browser int8 stays validated against the WASM-kernel reference. The native-vs-WASM difference is recorded as finding **F-5** and is mandatory in the final evaluation (`docs/FINDINGS.md`, master plan v1.2 §5).
- **Batch-size dependence kept** as finding **F-6**, with its own Phase 7 experiment **E-B** and hypothesis H6.
- Phase 2 is approved only after the manual verification on your Mac passes (`docs/MANUAL_VERIFICATION_PHASE2.md`).

**Changes made after the review (verified):**

| Change | Why | Verification |
|---|---|---|
| Deleted `.git/tD4w3kG` | You asked; it was an empty leftover from `git init` | Size checked as 0 bytes before `rm`; `git fsck` clean afterwards |
| Page: the UA memory measurement is now **opt-in** (checkbox; `benchmark({uaMemory})`, default `false`) | In a normal Chrome every call waits for a GC (20–60 s), and the benchmark makes 4 calls, so the manual run would look frozen | Re-ran the automated test with `uaMemory: true`: **10/10 checks pass** (`results/phase2/browser_baseline_recheck.json`). A UI walk-through with the checkbox off finished in 24 s with 90.02% and no page errors. |
| Page: threads are locked after the first load, with a clear error if changed | onnxruntime-web fixes `numThreads` when its WASM module starts and silently ignores later changes, which would mislabel results | UI walk-through: the selector is disabled and shows "(fixed until page reload)" |
| Page: **Copy results** button; result JSON now includes `page`, `date`, `precision`, `threads`, `uaMemory` | Makes the manual results easy to return and self-describing | UI walk-through |
| Page: memory label changed from "MB" to "MiB" | The value was computed in MiB (÷ 1,048,576) | Display text only |
| Test harness passes `uaMemory: true` | Keeps the automated memory checks | Re-run above |

**New observation:** load time on the cloud machine varied from 752 ms to 6,365 ms between runs of the same int8 file (**F-9**). This confirms that Phase 7 needs repeated runs.

---

## 14. Real-device measurements: configuration MAC-CHROME-4T (31 Oct 2026)

**These numbers are kept separate from the cloud benchmarks (§2). They come from a different machine, browser and procedure, and are never averaged with the cloud results.** The configuration is registered in `bench/configs.json`; the raw results are `results/phase2/mac_int8_4t.json` and `mac_fp32_4t.json`, saved exactly as you sent them.

| Property | MAC-CHROME-4T |
|---|---|
| Device | Your Mac, Apple Silicon (arm64). `hardwareConcurrency` = 8, `deviceMemory` = 16 |
| OS / browser | macOS 26.7.1 · Google Chrome 155, normal window, default flags |
| Threads | 4 |
| Procedure | Manual, following `docs/MANUAL_VERIFICATION_PHASE2.md`; UA memory API off |
| **Important:** | **The benchmark's load was the 2nd load of the file in that page** ("Load model" was clicked first). This is proven by `memBefore.wasmHeapBytes` being non-zero, because ORT's heap only exists after a session has been created. Load and session-creation times are therefore second-load times. |

*Aside:* Chrome's user-agent string says "Intel Mac OS X 10_15_7" even on Apple Silicon. Chrome freezes that part of the string for privacy, so it can't be used to identify the device. `deviceMemory` = 16 is above the value of 8 that older specifications capped this API at. This matters for the Phase 5 resource monitor: the value must be read, not assumed.

### 14.1 Correctness: all checks passed

| Check | int8 | fp32 |
|---|---|---|
| Cross-origin isolated | ✅ true | ✅ true |
| Tokenizer mismatches | ✅ 0 | ✅ 0 |
| Accuracy | ✅ **0.9002293577981652** (= WASM reference) | ✅ **0.9105504587155964** (= PyTorch) |
| Agreement with reference | ✅ 100% | ✅ 100% |
| max \|Δlogit\| vs reference | ✅ **0** (bit-identical) | ✅ 2.58e-5 (same value as the cloud) |
| Agreement with native Python int8 (F-5) | 99.885% (the documented 1 sentence) | — |

**WASM int8 results are bit-identical across a third platform:** x86 Chromium (cloud), ARM Node (sandbox) and Apple Silicon Chrome all give exactly the same logits. The thread count (1, 2, 4) doesn't change them either.

### 14.2 Load time (second load in the page)

| | File | fetch | session create | total load | Effective fetch rate |
|---|---|---|---|---|---|
| int8 | 67.4 MB | **736.5 ms** | 93.4 ms | 830.0 ms | 91 MB/s |
| fp32 | 267.9 MB | 548.4 ms | 185.7 ms | 734.1 ms | 489 MB/s |

For a like-for-like comparison, the cloud's **second-load** values from the replay diagnostic (§14.5, T2, load #2) are: int8 fetch 185–212 ms with create 72–103 ms; fp32 fetch 1,509–1,998 ms with create 189 ms. Session creation is **much faster on a second load** in both environments (cloud int8 645 → 85 ms, fp32 1,317 → 189 ms). That's why the Mac's 93 / 186 ms must not be compared with the cloud's first-load 583 / 884 ms in §2.

### 14.3 Inference latency (warm, batch 1, 872 sentences)

| | mean | p50 | p90 | p99 | min | max |
|---|---|---|---|---|---|---|
| int8 | 17.0 ms | **16.0 ms** | 25.3 ms | 40.7 ms | 4.1 ms | 136.7 ms |
| fp32 | 17.8 ms | **16.8 ms** | 26.8 ms | 37.1 ms | 4.1 ms | 113.1 ms |

**Observation (F-13):** on this device with 4 threads, int8 is **not meaningfully faster** than fp32 (p50 16.0 vs 16.8 ms, −5%). In the cloud int8 was clearly faster (1 thread: 43.1 vs 70.2 ms; 2 threads: 27.6 vs 37.1 ms). So int8's main benefit on a capable device is **size and memory, not speed**. I'm not claiming a cause; the Phase 7 thread sweep (1, 2, 4, 8 threads on your Mac) will measure whether the gap closes as threads increase.

### 14.4 Memory retention after `session.release()`

| | WASM heap with model loaded | WASM heap after `release()` | JS heap before load | JS heap after load | JS heap after `release()` |
|---|---|---|---|---|---|
| int8 | 190,316,544 B (**181.5 MiB**) | 190,316,544 B (**181.5 MiB**), unchanged | 10.7 MB | 78.1 MB (+67.4 MB) | 80.7 MB, unchanged |
| fp32 | 730,791,936 B (**696.9 MiB**) | 730,791,936 B (**696.9 MiB**), unchanged | 11.0 MB | 279.0 MB (+268.0 MB) | 280.2 MB, unchanged |

What this shows:

1. **The WASM heap is fully retained after `release()`:** 0 bytes returned, in both precisions. This confirms F-4 on a real device.
2. **The heap is reused, not grown, on a reload in the same page.** The benchmark's second load started with the heap already at 181.5 / 696.9 MiB and ended at exactly the same size. Freed space *inside* the heap is reused. The cloud replay (T2) shows the same thing.
3. **The JS heap also keeps the downloaded model bytes.** The increase after load (+67.4 MB int8, +268.0 MB fp32) equals the file size to within 0.1 MB. It was still there when `release()` returned, because nothing forces garbage collection. **For fp32, the two probes together show ≈ 964 MiB held after `release()`**: 696.9 MiB of WASM heap plus 267 MiB of JS heap. The JS part becomes reclaimable once garbage collection runs; the WASM part never does. (F-15)
4. Heap ÷ file size on this device: int8 **2.83×**, fp32 **2.73×** (cloud fresh-page fp32: 2.57×). The Mac fp32 heap (696.9 MiB) is larger than the cloud's fresh-page fp32 heap (656 MiB) but identical to the cloud replay's fp32 heap (697 MiB). I haven't determined whether threads, platform or load history causes the difference. Phase 3 will measure heap size against thread count and load order.

### 14.5 Investigation: why was the int8 fetch slower than the fp32 fetch? (open, cause not yet determined)

**Observation:** on your Mac, int8 (67.4 MB) took 736.5 ms to fetch while fp32 (267.9 MB) took 548.4 ms. That's **~5× slower per byte** (91 vs 489 MB/s). It's one sample of each.

**Method:** a separate diagnostic page (`bench/diag-fetch.html`, `bench/diag-fetch.js`) that reuses `FullModelRunner` unchanged. The baseline was not modified. It runs three tests:

- **T1, raw fetch:** 6 rounds, alternating file order, `cache:'no-store'`, unique URLs. Resource Timing splits each fetch into queue / TTFB / body download / last-byte-to-ArrayBuffer.
- **T2, replay:** reproduces the manual procedure exactly (load → classify → release → load).
- **T3, after compute:** fetch immediately after 20 inferences vs after 3 s idle.

It ran twice in the cloud, once with the OS file cache **dropped** (`results/phase2/diag_fetch_cloud_cold.json`) and once with it **warm** (`diag_fetch_cloud_warm.json`).

**Results (cloud, Chromium 153, 2 threads):**

| Test | Cold OS cache | Warm OS cache |
|---|---|---|
| T1 median fetch, int8 / fp32 (n = 6 each) | **178 / 1,770 ms** | **158 / 1,655 ms** |
| T1 first fetch in the page (int8) | 987 ms (68 MB/s) | 793 ms (85 MB/s) |
| T1 later int8 fetches | 144–185 ms (364–468 MB/s) | 135–164 ms (410–500 MB/s) |
| fp32 last-byte → ArrayBuffer time | 150–1,299 ms | 120–1,259 ms |
| int8 last-byte → ArrayBuffer time | 32–315 ms (315 only on the first fetch) | 32–315 ms (same pattern) |
| T2 load #1 → load #2 fetch, int8 | 147 → 200, 135 → 193 ms | 157 → 185, 150 → 212 ms |
| T2 load #1 → load #2 fetch, fp32 | 903 → 1,998 ms | 567 → 1,509 ms |
| T3 int8: after inference vs idle (medians) | 154 vs 149 ms | 179 vs 174 ms |

**What the evidence supports:**

| Candidate explanation | Verdict | Evidence |
|---|---|---|
| (a) The int8 file is inherently slower to fetch | **Not supported** | In all 12 alternating rounds (2 runs × 6), int8 was faster than fp32 |
| (b) Cold OS file cache | **Not supported as the main factor** | The first-fetch penalty persists with a warm cache (987 → 793 ms) |
| (c) ORT's threads still busy from a just-finished inference | **Not supported (cloud)** | T3: 154 vs 149 ms, and 179 vs 174 ms |
| (d) A first-large-fetch-in-the-page penalty | **Observed (F-12), but doesn't explain the Mac result** | ~600 ms extra on the first fetch. On the Mac, the measured int8 fetch was the *second* in its page. |
| (e) Second load of the same file after `release()` is slower | **Observed in 6/6 pairs (F-11), but doesn't explain the inversion** | It slows fp32 just as much (×2.2–2.7) as int8 (×1.2–1.4) |
| (f) Run-to-run variance on the Mac (single sample) | **Can't be ruled out** | No repeated Mac measurement exists yet |

**Conclusion:** the inversion **does not reproduce** under controlled, repeated measurement in the cloud. **Its cause on your Mac is not yet determined.** I'm not attributing it to any of the factors above. To close it, please run the same diagnostic on your Mac (§14.6). Its timing breakdown will show which phase of the fetch was slow.

**Two side findings for Phase 4 (cache layer):**

- For large files, the step from "last byte received" to "`ArrayBuffer` available" can cost as much as the download itself (fp32: up to ~1.3 s).
- A reload after `release()` is consistently slower.

Both suggest the cache layer should keep **chunk bytes** in IndexedDB and hand them to ORT directly, rather than re-fetching.

### 14.6 Pending: Mac diagnostic run (I-2.7, ~2 minutes)

With `npm run serve` running, open a **fresh tab** at **http://localhost:8080/bench/diag-fetch.html?threads=4**, click **Run diagnostics**, wait for "done", click **Copy results**, and paste the JSON to me. Its T1/T2/T3 rows will be added here as configuration MAC-CHROME-4T-DIAG.
