# Phase 3 — Chunked Execution and Workers: Completion Report

**Planned:** 10–13 Nov 2026 · **Actual:** 31 Oct 2026 (Day 1) · **Status:** 🟨 Complete and verified (cloud), **awaiting your approval**
**Recommended before approval:** a manual run on your Mac (§11). Same procedure as Phase 2.

---

## 1. Phase overview

**Objective:** Turn the 4 ONNX chunks from Phase 1 into **independently managed execution units** in the browser. First run them as separate sessions in one page, then as **one Web Worker per chunk**. Prove that the output is identical to the baseline, and show that terminating a Worker gives its memory back, which `session.release()` cannot do (F-4).

| Planned deliverable | Status |
|---|---|
| `ChunkSession` + `ChainRunner` (4 sessions, chained on the main thread) | ✅ |
| One Worker per chunk; tensors passed as transferable buffers | ✅ `chunkWorker.js`, `WorkerChunk`, `WorkerChainRunner` |
| SEQUENTIAL mode: load → run → terminate, at most one chunk alive | ✅ |
| Chained output = baseline (fp32 Δ < 1e-4; int8 Δ = 0 vs the WASM reference) | ✅ all modes, both precisions, all 872 sentences |
| Proof that terminating a Worker frees memory | ✅ 100% freed (browser's own memory API) |
| ORT's base overhead per Worker; cost of passing tensors between Workers | ✅ measured |
| Phase 2 baseline left unchanged | ✅ byte-identical to commit `a34a391`; regression test passes |

## 2. Headline results

All of these come from configuration **CLOUD-HL-1T** (headless Chromium 153, x86, 2 vCPU, 1 thread per session or Worker), 872 sentences at batch size 1. The baseline column is Phase 2's single-session model in the same configuration.

| | Baseline (1 session) | **A · Main-thread chain** (4 sessions, 1 heap) | **B · Workers, resident** (4 Workers alive) | **C · Workers, sequential** (≤ 1 Worker alive) |
|---|---|---|---|---|
| **fp32 peak WASM memory** | 656 MiB | **403.4 MiB (−38%)** | 813.3 MiB (+24%) | **280.1 MiB (−57%)** |
| **int8 peak WASM memory** | 180.3 MiB | **111.2 MiB (−38%)** | 214.1 MiB (+19%) | **77.2 MiB (−57%)** |
| Memory left after release / terminate | all retained | all retained | **0** | **0** |
| fp32 accuracy · Δ vs PyTorch | 91.06% · 2.6e-5 | 91.06% · 2.6e-5 | 91.06% · 2.6e-5 | 91.06% · 2.6e-5 |
| int8 accuracy · Δ vs WASM reference | 90.02% · 0 | 90.02% · **0** | 90.02% · **0** | 90.02% · **0** |
| fp32 time per sentence (p50 / mean) | 70.2 ms (p50) | 70.5 ms (p50) | 72.6 ms (mean) | 71.7 ms (mean, amortised) |
| int8 time per sentence | 43.1 ms (p50) | 42.0 ms (p50) | 45.4 ms (mean) | 46.8 ms (mean, amortised) |
| Load before the first result (fp32 / int8) | 1.57 s / 0.75 s | 2.36 s / 0.81 s | 3.81 s / 1.52 s | each chunk loads when it's needed (§5.4) |

Sequential mode also holds the intermediate hidden states of every queued sentence in the main thread: **64.3 MiB** for all 872 sentences (§5.4). Counting that, sequential uses 344 MiB for fp32 (−48%) and 141.5 MiB for int8 (−22%).

**Memory-release proof** (experiment D, measured by the browser's own `measureUserAgentSpecificMemory`, independent of my probe):

| Step | int8 page memory | fp32 page memory |
|---|---|---|
| 0 · page only | 2.8 MiB | 2.8 MiB |
| 1 · 4 chunk Workers loaded | 223.4 MiB | 822.7 MiB |
| 2 · `session.release()` in every Worker | 223.5 MiB (**0% freed**) | 822.7 MiB (**0% freed**) |
| 3 · `worker.terminate()` on all 4 | **2.8 MiB (100% freed)** | **2.8 MiB (100% freed)** |

**Answer to hypothesis H1** ("sequential load → run → release lowers peak memory, at a latency cost"): **supported for memory.** Peak WASM memory falls by 57% in both precisions. The latency cost depends on the workload:

- **Batch of sentences:** close to zero (fp32: 62.5 s sequential vs 67.1 s resident including load, for 872 sentences), because each chunk loads once and serves the whole batch.
- **Single interactive request:** large. Every request reloads all 4 chunks, about **2.0 s (int8) / 2.9 s (fp32)** extra here without a cache. That's exactly what the Phase 4 cache and the Phase 5 decision engine are for.

## 3. Five findings (added to `docs/FINDINGS.md`)

| ID | Finding |
|---|---|
| **F-17** | **Splitting alone lowers peak memory by 38%,** even with all 4 chunks resident in one page (fp32 656 → 403 MiB; int8 180 → 111 MiB) and with the same latency. The weights are identical, so the difference is load-time overhead. This is *consistent with* ORT holding a transient copy of the model file while building a session (a single 255 MiB copy for the full model vs at most 91 MiB per chunk). I haven't proven that mechanism; it would require instrumenting ORT's allocator. |
| **F-18** | **Each Worker has a fixed cost:** ~16–19 MiB of heap and ~300 ms of WASM start-up, even for a 0.6 MB graph (experiment E). Each Worker also needs ~2.9–3.4× its file size in heap, more than one shared heap (~1.6× for chain A). So 4 resident Workers cost **more** than the baseline (+19 to +24%). Isolation pays off only when Workers are actually **terminated**. |
| **F-19** | **Passing tensors between Workers is cheap:** 0.1–0.4 ms per chunk boundary, about 1.2–1.3 ms per sentence across 4 Workers. That's 2.6% of int8 time and 1.8% of fp32 time, thanks to transferable buffers. |
| **F-20** | **The int8 chain is bit-identical to the full int8 model** in the WASM engine (Δ = 0 on 872 sentences). Cutting the graph doesn't change dynamic quantization, because every quantize step works on the same tensor either way. |
| **F-21** | **In sequential mode the waiting hidden states grow with the batch:** 64.3 MiB for 872 sentences (~75 KiB per sentence). Without a limit this eats into the memory saving, so the batch needs a bound (I-3.2). |

## 4. Implementation details

### 4.1 Module map (all new, in `packages/adaptive-onnx-loader/src/`)

```
manifest.js          loadManifest(), precisionPlan(), chunkEntry()   ← reads models/onnx/manifest.json
tensors.js           plain-tensor format, fromOrt(), toOrt(), transferList(), sliceBatch()
chunks/
  chunkSession.js    ChunkSession  — ONE chunk = ONE InferenceSession
  chain.js           feedsFor() chaining rule, encodeToTensors(), logitsRows()
  chainRunner.js     ChainRunner   — 4 ChunkSessions in one context (experiment A)
workers/
  chunkWorker.js     the Worker script: hosts one ChunkSession, RPC protocol
  workerChunk.js     WorkerChunk   — main-thread handle (promise RPC, heap tracking, terminate)
  workerChainRunner.js WorkerChainRunner — resident & sequential modes (experiments B, C)
```

### 4.2 `ChunkSession`: the execution unit

`ChunkSession.create(ort, entry, {bytes?})` takes a manifest entry (`{name, precision, url, bytes, sha256, …}`). It fetches the bytes unless they're supplied (Phase 4's cache will supply them), **checks the byte length against the manifest**, and creates the session. `run(feeds)` converts plain tensors to `ort.Tensor`, runs the session, and returns plain tensors whose buffers the caller owns.

### 4.3 The chaining rule (`chain.js`)

```
c0_embed      { input_ids }                  -> { hidden }
c1, c2        { hidden_in, attention_mask }  -> { hidden }
c3            { hidden_in, attention_mask }  -> { logits }
```

The previous chunk's `hidden` becomes the next chunk's `hidden_in`. The same `attention_mask` goes to every layer chunk, because each attention layer needs it to ignore padding. There is a single function for this rule (`feedsFor`), used by every runner, so the main-thread and Worker versions can't drift apart.

### 4.4 Plain tensors and transferable buffers (`tensors.js`)

Across a Worker boundary, data is normally **copied** (the "structured clone" algorithm). A hidden state for one sentence is ~75 KiB, and up to ~0.4 MB for long sentences. Instead, every `postMessage` lists the tensors' `ArrayBuffer`s in its **transfer list**, which **moves** ownership in constant time: the sender's buffer becomes empty ("detached") and the receiver gets it without copying.

Two details this requires:

- `fromOrt()` copies an ORT output whenever its data is a view onto WASM memory. Such a view can't be transferred, and the next `run()` would overwrite it.
- The `attention_mask` is **cloned** before it's sent. It's reused by C1, C2 and C3, and transferring it to C1 would leave the main thread with a detached buffer for C2.

### 4.5 The Worker (`chunkWorker.js`) and its handle (`workerChunk.js`)

- **Message protocol:** `init` → `load` → `run`* → `release`. Each request carries an `id`, and the reply echoes it, so many requests can be in flight at once.
- **Why `init` passes ORT's URL:** import maps don't apply inside Workers, so the page passes ORT's absolute URL and the Worker loads it with `await import(ortUrl)`. This is the same dependency-injection idea as Phase 2.
- **Memory reporting:** the Worker installs the WASM-heap probe **before** ORT starts, so it can report its *own* heap size on every reply. `WorkerChunk` keeps the latest value.
- **The Worker fetches its own chunk.** The model bytes never pass through the page, which also avoids the transient JS-heap copy seen in F-15.
- **Releasing memory:** `terminate()` destroys the Worker, and the browser frees its entire WebAssembly memory. Experiment D measured this at 100%.

### 4.6 `WorkerChainRunner`: two execution orders

| Mode | Order | Workers alive | Memory | Cost |
|---|---|---|---|---|
| `resident` | **Sentence-major:** sentence 1 goes through C0 → C1 → C2 → C3, then sentence 2, … | 4 | Sum of all 4 heaps (+ fixed cost ×4) | Load once; no per-request cost |
| `sequential` | **Chunk-major:** spawn C0, run *every* sentence through it, terminate it; spawn C1, … | ≤ 1 | Largest single chunk + waiting hidden states | 4 loads per batch |

Every sentence always runs at **batch size 1**, even in chunk-major order. Batching would change int8 results (F-6); keeping batch 1 is why every mode is bit-identical to the baseline.

**Memory accounting:** `liveHeapBytes` = sum of the last heap reported by each Worker that hasn't been terminated. `mark()` records a timeline entry after every load, run and terminate, and keeps the peak. Example (fp32, sequential):

```
t=0.9 s  load C0  1 alive  280.1 MiB      t=21.4 s terminate C1  0 alive  0
t=1.1 s  ran  C0           280.1 MiB      t=22.0 s load C2       1 alive  186.3 MiB
t=1.1 s  terminate C0  0 alive  0         …
t=1.7 s  load C1  1 alive  186.3 MiB      t=62.6 s terminate C3  0 alive  0
```

### 4.7 Test page and harness

- `demo/phase3-chunks.html` + `.js`: buttons for experiments A–E with a copyable JSON result, plus `window.phase3.*` for automation.
- `bench/phase3_browser_test.mjs`: one **fresh browser per experiment**, and 48 gates across the three runs (correctness, release to 0, ≤ 1 live Worker, terminate frees ≥ 90%, release frees < 10%).
- `bench/gen_chain_refs.mjs`: per-sentence chain references from the WASM engine in Node.
- `test/chain.test.mjs`: Node unit tests. Precision plans, the chaining rule, tensor helpers, and 30 sentences checked bit-for-bit against the reference.

## 5. Detailed measurements

### 5.1 Heap per chunk (one Worker each, CLOUD-HL-1T)

| Chunk | fp32 file | fp32 Worker heap | Ratio | int8 file | int8 Worker heap | Ratio |
|---|---|---|---|---|---|---|
| C0 embed | 90.9 MiB | 280.1 MiB | 3.08× | 22.7 MiB | 77.2 MiB | 3.40× |
| C1 L0–1 | 54.1 MiB | 186.2 MiB | 3.44× | 13.6 MiB | 45.2 MiB | 3.32× |
| C2 L2–3 | 54.1 MiB | 186.2 MiB | 3.44× | 13.6 MiB | 45.2 MiB | 3.32× |
| C3 L4–5 + cls | 56.4 MiB | 160.7 MiB | 2.85× | 14.2 MiB | 46.4 MiB | 3.27× |
| Exit head E1 (experiment E) | 2.3 MiB | 19.3 MiB | — | 0.6 MiB | 16.0 MiB | — |

**C0 (embeddings) sets the peak in sequential mode.** It's the largest chunk, so a Phase 5 policy that keeps C0 in int8 lowers the sequential peak the most. (F-2 showed C0 is also the least affected by int8.)

### 5.2 Cost of passing tensors (mean per sentence, resident mode)

| Boundary into | int8 run / message overhead | fp32 run / message overhead |
|---|---|---|
| C0 | 0.19 / 0.22 ms | 0.25 / 0.24 ms |
| C1 | 14.67 / 0.30 ms | 23.56 / 0.36 ms |
| C2 | 14.62 / 0.31 ms | 23.61 / 0.37 ms |
| C3 | 14.73 / 0.34 ms | 23.79 / 0.38 ms |
| **Total per sentence** | **44.2 / 1.17 ms (2.6%)** | **71.2 / 1.34 ms (1.8%)** |

### 5.3 Load times (each Worker's fetch / create / spawn-and-init)

| | C0 | C1 | C2 | C3 | Sum |
|---|---|---|---|---|---|
| int8, sequential | 133 / 356 / 34 | 48 / 385 / 23 | 50 / 391 / 49 | 74 / 395 / 54 | **≈ 2.0 s** |
| fp32, sequential | 311 / 490 / 30 | 174 / 462 / 34 | 183 / 435 / 30 | 291 / 457 / 50 | **≈ 2.9 s** |

Session creation dominates: ~350–490 ms per Worker, of which ~300 ms is WASM start-up (F-18). The Phase 4 cache removes the fetch part. Pre-starting ("pre-warming") a Worker before it's needed would hide the start-up part; that's a Phase 5 decision-engine option.

### 5.4 Sequential mode: total time and waiting hidden states

| | Sequential (load + run, 872) | Resident (load + run, 872) | Waiting hidden states (max) |
|---|---|---|---|
| int8 | 40.8 s | 1.5 + 39.6 = 41.1 s | 64.3 MiB |
| fp32 | 62.5 s | 3.8 + 63.3 = 67.1 s | 64.3 MiB |

## 6. Technical decisions

| Decision | Alternatives | Why |
|---|---|---|
| **One Worker per chunk** | All chunks in one Worker; a Worker pool | Only terminating a Worker frees WASM memory (proven in D). Per-chunk Workers make each chunk's memory individually freeable. |
| **Each Worker fetches its own chunk** | Fetch in the page and transfer the bytes | Keeps model bytes out of the page's JS heap (F-15) and parallelises fetching in Phase 5 |
| **Transfer lists for tensors** | Structured clone (copy) | Copy-free hand-off; measured overhead 0.1–0.4 ms per boundary |
| **Batch size 1 in every mode** | Batch the sentences in sequential mode | Keeps int8 bit-identical to the baseline (F-6); batching is studied separately in E-B |
| **1 thread per Worker (this phase)** | ORT multi-threading in each Worker | 4 Workers × N threads would oversubscribe a 2-vCPU machine. Single-threaded Workers also keep the browser memory API fast (20–35 ms per call, vs ~60 s with ORT worker threads, F-7). Thread counts get swept in Phase 7. |
| **Chunk-major order for sequential** | Sentence-major with a reload per sentence | One load per chunk per batch instead of per sentence. The cost is the waiting hidden states (F-21). |
| **Independent memory check with the browser API (D)** | Trust the probe | The claim "terminate frees memory" is central to the project, so it's verified with a second, independent measurement |
| **New files only** | Extend `FullModelRunner` | You asked for the baseline to stay unchanged; the comparison stays clean |

## 7. Why it matters for the project

Phase 3 is the core of the research question. It shows that a model's components can be **independently loaded, executed and freed** in a browser, with **exactly** the baseline's output. That lets the same model run anywhere from 77 MiB (int8, sequential) to 813 MiB (fp32, resident) of peak WASM memory. The trade-offs between those options (latency per request, load time, fixed cost per Worker) are now measured. Those measurements are what the Phase 5 decision engine will choose between, and Phase 4's cache is designed to remove the biggest one (reload cost).

## 8. Files and components

**New**

| Path | Purpose |
|---|---|
| `packages/adaptive-onnx-loader/src/manifest.js` | Manifest helpers |
| `packages/adaptive-onnx-loader/src/tensors.js` | Plain-tensor format and transfer helpers |
| `packages/adaptive-onnx-loader/src/chunks/chunkSession.js`, `chain.js`, `chainRunner.js` | Chunk execution on one thread |
| `packages/adaptive-onnx-loader/src/workers/chunkWorker.js`, `workerChunk.js`, `workerChainRunner.js` | Worker execution |
| `packages/adaptive-onnx-loader/test/chain.test.mjs` | 4 new unit tests (8/8 total pass) |
| `demo/phase3-chunks.html`, `demo/phase3-chunks.js` | Experiment page A–E |
| `bench/phase3_browser_test.mjs` | Automated browser test (48 gates across 3 runs) |
| `bench/gen_chain_refs.mjs` | WASM chain references |
| `results/phase3/node_chain_{int8,fp32}.json` | Node chain vs full model |
| `results/phase3/cloud_ABC_int8.json`, `cloud_ABCD_fp32.json`, `cloud_D_int8_E.json` | Browser evidence |
| `data/sst2/wasm_chain_{int8,fp32}_logits.json` | References (git-ignored, regenerable) |

**Changed:** `packages/adaptive-onnx-loader/src/index.js`, +6 export lines only. The baseline page imports this file, so the Phase 2 browser test was re-run afterwards: 5/5 pass, Δ = 0. Every other Phase 2 file is byte-identical to commit `a34a391`.

## 9. Validation summary

| # | Test | Result |
|---|---|---|
| V1 | Node: int8 chain vs full int8 model, 872 sentences | ✅ Δ = 0, 100% |
| V2 | Node: fp32 chain vs PyTorch, 872 | ✅ Δ = 2.58e-5, 100% |
| V3 | Unit tests (`npm run test:unit`) | ✅ 8/8 |
| V4 | Browser A/B/C × int8: isolated, 100% agreement, Δ = 0, accuracy, release → 0, ≤ 1 Worker alive | ✅ 18/18 |
| V5 | Browser A/B/C/D × fp32: same gates + Δ vs PyTorch < 1e-4 + D gates | ✅ 25/25 |
| V6 | D int8 + E: no page errors, UA API available, terminate frees ≥ 90%, release frees < 10% | ✅ 5/5 (100% / 0%) |
| V7 | Phase 2 baseline regression after the `index.js` change | ✅ 5/5 |
| V8 | Baseline files unchanged vs `a34a391` | ✅ `git diff` empty |

**Total: 48/48 Phase 3 browser gates (18 + 25 + 5), 8/8 unit tests, 5/5 regression checks.**

## 10. Issues, limitations and deviations

| ID | Item | Severity | Action |
|---|---|---|---|
| I-3.1 | **All Phase 3 numbers are from the cloud (CLOUD-HL-1T).** Real-device numbers are pending. | Medium | Mac run (§11) |
| I-3.2 | **Sequential mode holds every waiting sentence's hidden state** (F-21). There's no limit yet. | Medium | Phase 5: add a `groupSize` limit and let the decision engine choose it (smaller groups mean more reloads) |
| I-3.3 | Only 1 thread per Worker was tested | Low | Phase 7 thread sweep, including on your Mac |
| I-3.4 | The F-17 mechanism (a transient copy of the model during session creation) is a hypothesis consistent with the data, not proven | Low | Reported as a hypothesis |
| I-3.5 | PIPELINED and EARLY_EXIT modes aren't built yet | — | As planned: Phase 5 (the decision engine selects policies) |
| I-3.6 | No mixed precision tested yet (`precisionPlan` supports it) | — | Phase 5/7 (I-1.1) |
| I-3.7 | Resident mode costs **more** memory than the baseline (+19 to +24%) | Finding, not a defect | Resident only makes sense when memory is plentiful; the decision engine must know this |

No planned requirement was skipped.

## 11. Manual check on your Mac (recommended, ~5 min)

With `npm run serve` running, open **http://localhost:8080/demo/phase3-chunks.html** in Chrome. Keep "Threads per Worker" at **1**, and **reload the page before each button**:

1. **int8, all 872:** **A**, reload, **B**, reload, **C**. Each result should show `"agreementWithChainRef": 1` and `"maxAbsDiffVsChainRef": 0`. Note `peakLiveHeapMiB` (B ≈ 214, C ≈ 77).
2. Reload, then **D** (int8). `steps[3].uaMiB` should drop back to roughly `steps[0].uaMiB`, and `steps[2]` should equal `steps[1]`. This step can take longer in a normal Chrome window.
3. Reload, then **E**.
4. Optional: repeat A–C with fp32.

Copy each JSON and send them to me. They'll be saved as configuration **MAC-CHROME-W1** (Workers, 1 thread each), separate from the cloud results.

## 12. Next phase: Phase 4, storage and cache layer (planned 14–16 Nov)

**Objective:** Make chunks **load fast a second time**, without re-downloading.

**Tasks:**

1. A `ChunkStore` in IndexedDB as the long-term ("cold") store, keyed by `sha256`.
2. An in-memory "hot" set with LRU eviction under a byte budget.
3. Integrity check: SHA-256 via `crypto.subtle.digest`, compared against the manifest. A corrupt entry is evicted and re-fetched.
4. Quota handling with `navigator.storage.estimate()` and `persist()`.
5. Wire it into `ChunkSession.create({bytes})` and the Workers. A Worker can open IndexedDB itself, so bytes still never pass through the page.
6. Measure cold vs warm load (H5) and the hit rate (M6). Re-check F-11 (slower re-fetch) once caching is in place.

**Dependencies:** Phase 3 ✅. **Viva topics coming:** IndexedDB transactions, the Cache API vs IndexedDB, LRU, content addressing by hash, storage quotas and eviction.
