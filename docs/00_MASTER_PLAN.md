# Adaptive Component-Level Model Loading in the Browser — Master Plan

**Project:** MCA Project 1 · Moulieswaran M
**Window:** 31 Oct 2026 – 30 Nov 2026 (30 days)
**Status:** APPROVED (31 Oct 2026, "get started")
**Version:** 1.1 (31 Oct 2026). Change: the mixed-precision setting is now C2 fp32 / rest int8, based on the Phase 1 sensitivity results (see PHASE_1_REPORT I-1.1).

---

## 1. Problem statement

Browser inference libraries such as Transformers.js load a model as a single opaque unit. The whole model is downloaded, parsed and kept in memory before the first inference, whatever the device's memory, network or workload.

**Research question:** Can exposing a transformer model's components as *independently managed execution units* reduce memory use and transfer overhead in the browser, through adaptive loading and precision selection, while keeping accuracy within an acceptable bound?

**Hypotheses to test in Phase 7:**

| ID | Hypothesis |
|---|---|
| H1 | Sequential load→run→release of chunks lowers **peak memory** compared with loading the full model, at a measurable latency cost. |
| H2 | Pipelined chunk loading (download chunk *k+1* while chunk *k* computes) lowers **time to first inference** on slow networks. |
| H3 | Early exit after intermediate chunks lowers **bytes downloaded** and latency, and the accuracy loss can be quantified. |
| H4 | Mixed per-chunk precision (fp32/int8) gives a better accuracy/size trade-off than uniform int8. |
| H5 | A chunk cache in IndexedDB makes warm starts much faster than cold starts. |

## 2. Scope

### In scope

- DistilBERT (`distilbert-base-uncased-finetuned-sst-2-english`), sentiment classification on SST-2.
- Python pipeline: split into 4 chunks, export each to ONNX, produce an int8 variant of each, and train 2 early-exit heads.
- Browser runtime built on **onnxruntime-web** (WASM backend). Each chunk is its own `InferenceSession`.
- Chunk isolation with Web Workers, so that releasing a chunk actually frees memory.
- Storage layer: IndexedDB cold store, in-memory hot set, LRU eviction.
- Decision engine: device profile → loading policy plus per-chunk precision.
- npm package with a clean API, plus a demo web page.
- Experiments across 6 metrics, with results tables and charts.
- Phase reports, final project report and a VIVA preparation document.

### Out of scope (future work)

- Generative/causal models (DistilGPT2) and KV-cache handover between chunks.
- The WebGPU backend (int8 operator support there is inconsistent, and mixing backends would muddy the comparisons).
- Training or fine-tuning the base model (only the small early-exit heads are trained).

## 3. Architecture

```
┌──────────────────────── Python (offline, build time) ────────────────────────┐
│ HF DistilBERT-SST2 ──► split_model.py ──► export_onnx.py ──► quantize.py     │
│                         (4 chunks)         (fp32 .onnx)       (int8 .onnx)    │
│                                  └─► train_exit_heads.py (exit after C1, C2) │
│                                  └─► validate.py (chunk chain == full model) │
│                       output: models/ + manifest.json (sizes, hashes, I/O)   │
└───────────────────────────────────────────────────────────────────────────────┘
                                     │ static hosting
┌──────────────────────────────── Browser (runtime) ────────────────────────────┐
│  Public API (npm)  loadModel() · infer() · getCacheStats() · setPolicy()     │
│        │                                                                     │
│  Orchestrator ── Decision engine ◄── Resource monitor (deviceMemory,         │
│        │              │               connection, storage.estimate, profile) │
│        │         policy + precision plan                                     │
│        ▼                                                                     │
│  Chunk manager ──► Storage layer (hot: memory / cold: IndexedDB / network)   │
│        │                                                                     │
│  Worker pool:  [C0 emb] → [C1 L0-1] → [C2 L2-3] → [C3 L4-5+cls]              │
│                            ↘ exit-1     ↘ exit-2                             │
│  (tensors move between workers as transferable ArrayBuffers)                 │
└───────────────────────────────────────────────────────────────────────────────┘
```

### Chunk layout

| Chunk | Contents | Inputs → Outputs | ≈ fp32 | ≈ int8 |
|---|---|---|---|---|
| C0 | Word + position embeddings, LayerNorm | `input_ids` → `hidden[B,S,768]` | 94 MB | 24 MB |
| C1 | Transformer layers 0–1 | `hidden`, `attention_mask` → `hidden` | 57 MB | 14 MB |
| C2 | Transformer layers 2–3 | `hidden`, `attention_mask` → `hidden` | 57 MB | 14 MB |
| C3 | Layers 4–5 + pre-classifier + classifier | `hidden`, `attention_mask` → `logits[B,2]` | 57 MB | 15 MB |
| E1, E2 | Early-exit heads (after C1, C2) | `hidden` → `logits` | <3 MB | <1 MB |

The sizes are estimates and will be replaced by measured values in Phase 1. Embeddings get a chunk of their own because the embedding table is about 1.6× the size of two transformer layers.

### Loading policies (decision engine output)

| Policy | Behaviour | Optimises |
|---|---|---|
| `FULL` | Load every chunk, keep all of them resident | Warm latency |
| `SEQUENTIAL` | Load → run → release, one chunk at a time | Peak memory |
| `PIPELINED` | Prefetch chunk *k+1* while chunk *k* computes | Time to first inference |
| `EARLY_EXIT` | Stop at E1 or E2 if the confidence is ≥ τ, or if the profile forbids more | Bytes and latency |

The precision axis is chosen per chunk from {fp32, int8}, which gives 2⁴ = 16 combinations. The experiments will evaluate 3 of them: all fp32, all int8, and a mixed setting (C2 fp32, the rest int8). This was changed in v1.1: Phase 1 showed that C0 is the least sensitive chunk to quantization and C2 the most.

## 4. Phase plan (30 days)

Each phase follows this cycle: **Define → Execute → Validate → Log issues → Phase report → your approval.** Please plan for a review turnaround of 1 day or less, because the schedule has no room for long waits.

| # | Phase | Dates | Days | Key deliverables | Exit criterion (must be verified) |
|---|---|---|---|---|---|
| 0 | Planning and setup | 31 Oct – 1 Nov | 2 | Master plan, tracker, repo skeleton, environment check | Plan approved; repo builds; Python env and HF access confirmed on your machine |
| 1 | Model preparation (Python) | 2 – 6 Nov | 5 | 8 chunk .onnx files, 2 exit heads, `manifest.json`, validation script | fp32 chain vs PyTorch: max abs diff < 1e-4; int8 SST-2 accuracy drop measured; exit-head accuracy reported |
| 2 | Baseline browser inference | 7 – 9 Nov | 3 | Unsplit model running in ORT-web, JS tokenizer, COOP/COEP dev server | Browser SST-2 accuracy = Python accuracy (±0.1%); `measureUserAgentSpecificMemory` works |
| 3 | Chunked execution and workers | 10 – 13 Nov | 4 | 4-session chain on the main thread, then one worker per chunk | Chained logits = baseline (diff < 1e-4); worker termination shows a memory drop |
| 4 | Storage and cache layer | 14 – 16 Nov | 3 | IndexedDB store, hot set, LRU, integrity via SHA-256 from the manifest | Unit tests: hit/miss/evict/quota/corrupt-entry paths pass |
| 5 | Resource monitor and decision engine | 17 – 20 Nov | 4 | Signal collector, simulated profiles, 4 policies, precision planner, early exit | Each profile produces the expected plan (table-driven tests); every policy gives correct output |
| 6 | npm package and demo | 21 – 23 Nov | 3 | `adaptive-onnx-loader` package, TypeScript types, README, demo page with live stats | `npm pack` + install in a clean project works; demo runs end to end |
| 7 | Experiments | 24 – 27 Nov | 4 | Automated benchmark harness (Playwright + throttling), results CSV, charts | 3 profiles × 4 policies × 3 precisions, ≥5 runs each, mean ± std |
| 8 | Report and VIVA preparation | 28 – 30 Nov | 3 | Final report, diagrams, VIVA Q&A document, demo script | All documents complete and consistent with the code and results |

### Critical path and buffer

1 → 2 → 3 → 5 → 7 is the critical path. Phase 4 (storage) can overlap with Phase 3 if Phase 3 runs ahead of schedule.

There is no dedicated buffer week. If a phase slips, scope is cut in this order:

1. Drop the PIPELINED policy (keep FULL, SEQUENTIAL, EARLY_EXIT).
2. Reduce the precision axis to all fp32 and all int8.
3. Reduce the experiment runs from 5 to 3.

Correctness and documentation are **never** cut.

## 5. Evaluation design

| # | Metric | How it is measured |
|---|---|---|
| M1 | Bytes downloaded | Sum of fetched chunk sizes (network log plus manifest) |
| M2 | Time to first inference (cold) | `performance.now()` from `loadModel()` to the first logits |
| M3 | Peak memory | `performance.measureUserAgentSpecificMemory()` sampled during the run; cross-checked with Chrome Task Manager |
| M4 | Warm inference latency | Median over 100 sentences after warm-up |
| M5 | Accuracy | SST-2 validation set (872 sentences) |
| M6 | Cache hit rate | Hits / lookups across 3 simulated revisits |

**Device profiles (simulated):**

- Low: 1 GB / Slow 3G / 6× CPU
- Mid: 4 GB / Fast 4G / 4× CPU
- High: 8 GB / no throttling

## 6. Technology choices (summary; details are explained per phase)

| Choice | Reason |
|---|---|
| onnxruntime-web over Transformers.js | Gives direct control over `InferenceSession` objects, one per chunk. Transformers.js hides model loading behind a high-level API. |
| DistilBERT (encoder-only) | A clean single forward pass with no KV cache to hand between chunks. It is small enough to iterate on in 30 days. |
| Layer-group splitting | Structural, component-level units, which are the core of the research question. |
| Dynamic int8 quantization | Needs no calibration data and is supported by the ORT WASM backend. Gives roughly 4× smaller files. |
| Web Workers per chunk | WebAssembly memory never shrinks. Terminating a worker is the only reliable way to free a chunk's memory. |
| IndexedDB | Large binary storage that persists across sessions and is available in every major browser. |
| WASM backend only | Consistent operator support for int8, which keeps comparisons fair. |

## 7. Risks

| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|
| Hugging Face is unreachable from the cloud workspace (confirmed blocked) | Certain | High | Run model download and export on your machine; the cloud workspace handles browser and JS work |
| int8 drops accuracy more than expected | Medium | Medium | Measure the drop per chunk; use mixed precision |
| `measureUserAgentSpecificMemory` is unavailable or noisy | Medium | High | Set up COOP/COEP in Phase 2; fall back to WASM `memory.buffer.byteLength` per worker plus Task Manager readings |
| Tensor-transfer cost between workers dominates | Medium | Medium | Use transferable buffers; report the overhead as a finding |
| Review delays | Medium | High | Keep each phase report self-contained so it can be reviewed in under 30 minutes |
| ONNX export of a partial model fails on the attention-mask path | Low | High | Wrap each chunk in an `nn.Module` with explicit mask expansion; validate per chunk |

## 8. Deliverables at 30 Nov

1. `python/` model pipeline plus validated ONNX artifacts
2. `packages/adaptive-onnx-loader/` npm package
3. `demo/` web application
4. `bench/` experiment harness and `results/` (CSV plus charts)
5. `docs/phase-reports/PHASE_0..8.md`
6. `docs/FINAL_REPORT.md`
7. `docs/VIVA_PREP.md`
8. `PROGRESS_TRACKER.md` (updated after every phase)
