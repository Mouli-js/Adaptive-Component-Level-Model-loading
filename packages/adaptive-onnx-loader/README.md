# adaptive-onnx-loader

Run a transformer model in the browser **as independently managed parts** instead of one opaque blob.

The model is split into chunks (embeddings, layer groups, classifier head). Each chunk runs in **its own Web Worker**, so it can be loaded, kept, or **fully freed** independently: WebAssembly memory never shrinks, but terminating a Worker returns 100% of its heap. A **deterministic decision engine** picks the precision per chunk, which chunks stay resident, group size, pre-starting and (opt-in) early exit, from the device's memory budget, a required accuracy and a weighted cost. Chunks are cached in **IndexedDB**, addressed by SHA-256, and verified on every read.

Built on [`onnxruntime-web`](https://onnxruntime.ai/) 1.20.1 (WASM backend). The bundled cost model and accuracy table describe the **DistilBERT-SST2** chunks produced by this project's Python pipeline (see *Limitations*).

## Install

```bash
npm install adaptive-onnx-loader onnxruntime-web@1.20.1
```

## Serve with cross-origin isolation (required)

The page must be **cross-origin isolated**, which is what enables `SharedArrayBuffer` for onnxruntime-web and accurate memory measurement:

```
Cross-Origin-Opener-Policy: same-origin
Cross-Origin-Embedder-Policy: require-corp
```

`loadModel()` throws `NOT_ISOLATED` otherwise. Serve `.wasm` as `application/wasm`.

## Quick start (no bundler)

```html
<script type="importmap">
{ "imports": {
  "adaptive-onnx-loader": "/node_modules/adaptive-onnx-loader/src/index.js",
  "onnxruntime-web": "/node_modules/onnxruntime-web/dist/ort.wasm.min.mjs" } }
</script>
<script type="module">
  import { loadModel } from 'adaptive-onnx-loader';

  const model = await loadModel({ manifestUrl: '/models/onnx/manifest.json', profile: 'mid' });
  console.log(model.explainPlan().explanation.join('\n'));   // why this plan

  const r = await model.infer('a gorgeous, witty, seductive movie.');
  console.log(r);   // { label: 'POSITIVE', score: 0.99…, logits: [...], exitAt: 'full' }

  console.log(await model.getCacheStats());
  model.dispose();  // terminates every chunk Worker -> memory returned
</script>
```

`manifestUrl` points to the `manifest.json` produced by the Python pipeline. Chunk files, `vocab.txt` and `early_exit.json` are resolved relative to it.

## API

### `loadModel(options) → Promise<AdaptiveModel>`

| Option | Default | Meaning |
|---|---|---|
| `manifestUrl` | **required** | URL of `manifest.json` |
| `profile` | `null` (this browser's signals) | `'low'` / `'mid'` / `'high'`: simulated device profile |
| `overrides` | `{}` | `allowanceMiB`, `minAccuracy`, `reserveFraction` (0.15), `heapUncertainty` (1.10), `sentencesPerRequest` (1), `weights`, signal values |
| `earlyExit` | `false` | Allow early exit. **Changes predictions**; still subject to `minAccuracy` |
| `calibrate` | `false` | Measure this device's timings first (~7 s). Makes decisions device-specific (non-deterministic) |
| `cache` | `true` | IndexedDB chunk cache (persists across visits) |
| `verifyOnRead` | `true` | Re-hash cached chunks with SHA-256 on every read |
| `ortUrl` | `/node_modules/onnxruntime-web/dist/ort.wasm.min.mjs` | **Absolute** URL of onnxruntime-web inside Workers (import maps don't apply in Workers) |
| `wasmPaths` | directory of `ortUrl` | Where ORT finds its `.wasm` files |
| `workerUrl` | bundled `src/workers/chunkWorker.js` | Override for bundlers |
| `requireIsolation` | `true` | Throw if not cross-origin isolated |

### `AdaptiveModel`

| Member | Description |
|---|---|
| `plan` | The chosen plan: `{ id, precision, pinned, groupSize, prewarm, earlyExit }` |
| `explainPlan()` | The decision: one line per step (budget, rejections, choice, predicted memory and time, cost), plus budget, candidate counts, predicted metrics and runners-up |
| `infer(text \| texts)` | → `{ label, score, logits, exitAt }` (or an array). Calls are serialised; each sentence runs at batch size 1 |
| `getCacheStats()` | IndexedDB entries and usage, storage quota, live Workers, live / peak WASM memory, Worker starts |
| `replan(changes)` | Re-decide with a new `profile`, `overrides` or `earlyExit`; releases current Workers |
| `clearCache()` | Delete all cached chunks |
| `dispose()` | Terminate every Worker and close the cache |

Errors are `AdaptiveLoaderError`, each with a `code`: `BAD_OPTIONS`, `NOT_ISOLATED`, `NO_WORKERS`, `MANIFEST`, `NO_FEASIBLE_PLAN` (its message is the engine's explanation), `EARLY_EXIT_UNAVAILABLE`, `DISPOSED`.

## How a plan is chosen (deterministic, 7 steps)

1. Read browser signals (`deviceMemory`, `hardwareConcurrency`, `connection`, `storage.estimate()`, cached chunks) and apply the profile. Every value records its source.
2. **Usable memory = allowance × (1 − 15% reserve).** Disk (IndexedDB) is a separate resource.
3. Generate candidates: 3 precision plans × 16 pin sets × group sizes {1, 8, 32} × pre-start, giving 237 (474 with early exit).
4. **Reject** any plan whose predicted peak memory exceeds the usable budget, whose accuracy is below `minAccuracy`, or whose accuracy was never measured.
5. Estimate the cost of the remaining plans: **Cost = w_m·M̂ + w_t·T̂ + w_l·L̂ (+ w_n·N̂)**. Peak memory, per-sentence time, initial load and network are each normalised by the best feasible value.
6. Pick the lowest cost. Ties go to fewer Worker starts, then less network, then the plan id.
7. Return the plan with its explanation and predicted metrics.

| Profile | Allowance | Min accuracy | Weights m / t / l | Typical choice |
|---|---|---|---|---|
| low | 150 MiB | 0.900 | 0.6 / 0.2 / 0.2 | int8, one chunk Worker at a time |
| mid | 512 MiB | 0.905 | 0.34 / 0.33 / 0.33 | mixed precision (C2 fp32), all resident |
| high | 1536 MiB | 0.910 | 0.1 / 0.6 / 0.3 | fp32, all resident |

## Measured behaviour (from the project's experiments)

- Splitting is lossless (Δ = 0 vs the full model); int8 is bit-identical across x86 Chromium, ARM Node and Apple-Silicon Chrome.
- One-chunk-at-a-time execution cuts peak WASM memory by **57%** (fp32 656 → 280 MiB).
- `worker.terminate()` frees 100% of a chunk's memory; `session.release()` frees 0%.
- A warm IndexedDB cache makes a repeat request **12.8× (int8) / 37.8× (fp32)** faster on a 20 Mbit/s link and downloads 0 bytes.
- Cost model accuracy: memory exact on tested platforms (and never underestimated); time −12% … +4% for chosen plans.

## Limitations

- **Model-specific cost model.** Heap sizes, accuracies and default timings in `src/engine/measurements.js` describe the DistilBERT-SST2 chunks of this project. Another model needs its own measurements.
- Time predictions for hybrid and pre-start plans are 23–35% optimistic (CPU contention is a likely cause, not verified).
- `navigator.connection` and `measureUserAgentSpecificMemory` are Chromium-only; other browsers fall back to defaults.
- The WASM backend only (no WebGPU). int8 results differ from *native* ONNX Runtime int8 in 1 of 872 validation sentences (different kernels); they are consistent across WASM platforms.
- With early exit, sentences that exit at C1/C2 use the exit head's prediction (−0.11 to −0.35 accuracy points).

## Advanced

Building blocks are exported for experiments: `ChunkSession`, `ChainRunner`, `WorkerChunk`, `WorkerChainRunner`, `WorkerPool`, `PlanRunner`, `ChunkStore`, `ChunkLoader`, `MemoryLRU`, `decide`, `generateCandidates`, `readSignals`, `applyProfile`, `usableBudget`, `predictMemory`, `predictTime`, `calibrate`, `WordPieceTokenizer`, `installWasmMemoryProbe`, `measureMemory`.

## License

The package code is MIT © 2026 Moulieswaran M.

**Third-party components keep their own licences, and this MIT licence does not apply to them:**
- **Model weights** (DistilBERT fine-tuned on SST-2, Apache-2.0). Not included in this package. If you host or redistribute the derived ONNX files, include the Apache-2.0 licence and state the modifications (split into chunks, int8 quantization, added exit heads).
- **`onnxruntime-web`** (MIT, © Microsoft). A peer dependency, installed by your application; not bundled.
- **SST-2 evaluation data** (licence unknown). Not included.
