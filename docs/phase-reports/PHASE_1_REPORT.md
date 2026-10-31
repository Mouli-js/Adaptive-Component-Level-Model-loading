# Phase 1 — Model Preparation Pipeline (Python): Completion Report

**Planned:** 2–6 Nov 2026 · **Actual:** 31 Oct 2026 (Day 1; 2 days ahead of schedule)
**Status:** 🟨 Complete and verified, **awaiting your approval** before Phase 2

---

## 1. Phase overview

**Objective:** Produce every model artifact the browser runtime will need, and prove that they are correct before any JavaScript is written.

Planned deliverables, and whether each was met:

| Deliverable | Status |
|---|---|
| Split DistilBERT-SST2 into 4 independently runnable chunks | ✅ |
| Export the full model and each chunk to ONNX (fp32) | ✅ |
| int8 variant of every graph | ✅ |
| Two early-exit heads (after C1, after C2), trained and exported | ✅ |
| `manifest.json` describing every artifact | ✅ |
| Validation: chained fp32 ONNX vs PyTorch, max abs diff < 1e-4 | ✅ 2.4e-5 |
| Validation: int8 accuracy drop measured | ✅ −0.69 points |
| Validation: exit-head accuracy reported | ✅ 76.4% / 81.3% |
| *Extra:* artifacts load and chain correctly in **onnxruntime-web** (WASM) | ✅ |

Prior work: the earlier `split_model.py` was not available, so the pipeline was rewritten from scratch in this phase.

---

## 2. Work completed: headline results

| Result | Value |
|---|---|
| Full-model SST-2 validation accuracy (PyTorch) | **91.06 %** (794 / 872); matches the published figure for this checkpoint |
| PyTorch chunk chain vs full model | max \|Δlogit\| = **0.0** (bit-identical), 100% prediction agreement |
| ONNX fp32 chain vs PyTorch | max \|Δlogit\| = **2.4 × 10⁻⁵**, 100% agreement, 91.06% accuracy |
| ONNX int8 chain | **90.37 %** (−0.69 points, i.e. 6 sentences), 98.4% agreement with fp32 |
| Total size: fp32 → int8 | 267.9 MB → **67.3 MB** (3.98× smaller) |
| Sum of chunks vs full model | 267.9 vs 267.9 MB (fp32); 67.3 vs 67.4 MB (int8). **Splitting costs no extra bytes.** |
| Early exit, τ = 0.98 | **91.06 %** accuracy (no loss); 29% of sentences exit early; average 5.22 of 6 layers run |
| Early exit, τ = 0.95 | 90.71 % (−0.35 points); 44% exit early; average 4.72 layers |
| onnxruntime-web (Node, WASM EP), "i love this movie" | Chain fp32 `[-4.3237, 4.6761]` = full model `[-4.3237, 4.6761]` |

### Artifacts (`models/onnx/`)

| Chunk | Contents | Inputs → Outputs | fp32 | int8 |
|---|---|---|---|---|
| `c0_embed` | Word + position embeddings, LayerNorm | `input_ids` → `hidden` | 95.3 MB | 23.8 MB |
| `c1_l0_1` | Transformer layers 0–1 | `hidden_in`, `attention_mask` → `hidden` | 56.7 MB | 14.3 MB |
| `c2_l2_3` | Transformer layers 2–3 | `hidden_in`, `attention_mask` → `hidden` | 56.7 MB | 14.3 MB |
| `c3_l4_5_cls` | Layers 4–5 + pre-classifier + classifier | `hidden_in`, `attention_mask` → `logits` | 59.1 MB | 14.9 MB |
| `e1_after_c1` | Exit head on the [CLS] vector after layer 1 | `hidden_in` → `logits` | 2.4 MB | 0.6 MB |
| `e2_after_c2` | Exit head on the [CLS] vector after layer 3 | `hidden_in` → `logits` | 2.4 MB | 0.6 MB |
| `full` | Unsplit baseline | `input_ids`, `attention_mask` → `logits` | 267.9 MB | 67.4 MB |

Shapes: `input_ids`, `attention_mask` int64 `[batch, seq]`; `hidden` float32 `[batch, seq, 768]`; `logits` float32 `[batch, 2]` (0 = NEGATIVE, 1 = POSITIVE).

---

## 3. Implementation details: how each step works

The pipeline is 7 steps. Each step is a separate script, so any one can be rerun on its own. `python/run_phase1.sh` runs them all in order.

### Step 1: Splitting (`adaptive_split/chunks.py`, `split_model.py`)

The DistilBERT classification forward pass is:

```
input_ids → Embeddings → Block0 … Block5 → hidden[:,0] (the [CLS] token) → pre_classifier → ReLU → classifier → logits
```

Each chunk is a small `nn.Module` that **wraps the original sub-modules**. The weights are not copied or modified:

```python
class LayerGroupChunk(nn.Module):
    def __init__(self, blocks): self.blocks = nn.ModuleList(blocks)
    def forward(self, hidden, attention_mask):
        for blk in self.blocks:
            hidden = blk(x=hidden, attn_mask=attention_mask)[-1]
        return hidden
```

`build_chunks(model)` returns `{"c0_embed": EmbeddingChunk, "c1_l0_1": LayerGroupChunk(layers[0:2]), …}`. `run_chain()` is the **reference implementation** of what the browser will do: run C0, pass `hidden` to C1, and so on.

**Proof that the split is lossless:** `split_model.py` runs all 872 validation sentences through both the original model and the chain. The maximum logit difference is **0.0**. The parameter counts per chunk (23,835,648 + 14,175,744 + 14,175,744 + 14,767,874) add up to exactly the model total of 66,955,010, so no weight is missing or duplicated.

### Step 2: ONNX export (`export_onnx.py`)

`torch.onnx.export` traces each module with example inputs and writes a self-contained graph containing **only that chunk's weights**. Settings:

- `opset_version=17`: includes the native `LayerNormalization` operator and is fully supported by onnxruntime-web 1.20.
- `dynamic_axes={batch, seq}`: one file works for any batch size and sentence length.
- `do_constant_folding=True`: pre-computes constant sub-expressions at export time.

### Step 3: int8 quantization (`quantize.py`)

This uses ONNX Runtime **dynamic quantization** (`quantize_dynamic`, `QInt8`, ops `MatMul` and `Gather`):

- Weights are stored as int8, with a scale and zero-point for each tensor: `w ≈ scale × (q − zero_point)`. That's 1 byte per weight instead of 4, which is where the 4× saving comes from.
- *Dynamic* means activations are quantized at runtime, separately for each input: `DynamicQuantizeLinear → MatMulInteger → rescale`. No calibration dataset is needed.
- Quantizing `Gather` also shrinks the embedding table, which is the largest single tensor (30,522 × 768).

The int8 `c1_l0_1` graph contains 8 `DynamicQuantizeLinear` and 12 `MatMulInteger` nodes. Four `MatMul` nodes stay in fp32: these are the attention-score products Q·Kᵀ and weights·V, which are activation × activation with no constant weight (`MatMulConstBOnly=True`).

### Step 4: Early-exit heads (`train_exit_heads.py`)

**Idea:** many sentences are easy. If an intermediate layer is already confident, skip the rest of the network.

**Method:**

1. **Frozen backbone.** The fine-tuned DistilBERT is never changed, so the main path keeps exactly its 91.06%.
2. **Extract features.** Run C0→C1→C2 over 20,000 randomly sampled training sentences (seed 0, max length 64) and cache the [CLS] vectors after C1 and after C2. This is the slow part (~5 min). It is **sharded in blocks of 5,000 and resumable**, because each sandbox command is limited to about 3 minutes.
3. **Train two small heads.** Each head is `Linear(768,768) → ReLU → Linear(768,2)`, the same shape as the final head and **initialised from it**. Training uses AdamW (lr 1e-4), 8 epochs, batch 128, with 0.1 dropout on the input features.
4. **Select the best epoch on a held-out dev split.** That split is the last 2,000 of the 20,000 training sentences. The SST-2 validation set is used **only** for the final reported numbers.

Results:

| Head | Validation acc. before training | Dev acc. | **Validation acc.** | Mean confidence |
|---|---|---|---|---|
| E1 (after 2 layers) | 49.2% (≈ chance) | 86.7% | **76.4%** | 0.80 |
| E2 (after 4 layers) | 77.9% | 91.5% | **81.3%** | 0.87 |
| Final head (6 layers) | — | — | **91.06%** | — |

The dev accuracy is much higher than validation accuracy. That's expected: the base model was fine-tuned on the SST-2 training set, so its intermediate features fit training sentences better. This is why model selection must not be confused with evaluation.

### Step 5: Head export (`export_heads.py`)

The trained heads are exported to ONNX (fp32), then quantized (`MatMul`, `Gemm`) to int8.

### Step 6: Validation in ONNX Runtime (`validate.py`)

All 872 validation sentences (batch 32, max length 128) run through ONNX Runtime on the CPU execution provider, comparing each configuration against the PyTorch logits.

**A. Equivalence and accuracy**

| Configuration | Accuracy | max \|Δlogit\| vs PyTorch | Agreement with PyTorch |
|---|---|---|---|
| full fp32 | 91.06% | 2.4e-5 | 100% |
| **chain fp32** | **91.06%** | **2.4e-5** | **100%** |
| full int8 | 90.37% | 2.25 | 98.39% |
| **chain int8** | **90.37%** | 2.25 | 98.39% (identical to full int8) |
| chain mixed (C0 fp32, rest int8) | 90.02% | 4.81 | 97.36% |

**B. Per-chunk quantization sensitivity** (only that one chunk is int8, the others fp32)

| Chunk quantized | Accuracy | Predictions flipped | Bytes saved |
|---|---|---|---|
| C0 embed | 90.60% | 4 / 872 | 71.5 MB |
| C1 L0–1 | 90.60% | 14 / 872 | 42.4 MB |
| C2 L2–3 | 90.60% | **20 / 872** (most sensitive) | 42.4 MB |
| C3 L4–5+cls | 90.94% | 5 / 872 | 44.2 MB |

**C. Early-exit threshold curve** (fp32). Rule: exit at E1 if its softmax confidence ≥ τ; otherwise at E2 if ≥ τ; otherwise run the full network.

| τ | Accuracy | Exit at E1 | Exit at E2 | Full | Avg. layers run |
|---|---|---|---|---|---|
| 0.50 | 76.38% | 100% | 0% | 0% | 2.00 |
| 0.80 | 85.89% | 55.7% | 24.5% | 19.7% | 3.28 |
| 0.90 | 88.65% | 35.2% | 24.8% | 40.0% | 4.10 |
| 0.95 | 90.71% | 20.1% | 24.0% | 56.0% | 4.72 |
| **0.98** | **91.06%** | 10.0% | 19.0% | 71.0% | **5.22** |
| 0.99 | 91.17% | 5.0% | 15.4% | 79.6% | 5.49 |
| never exit | 91.06% | 0% | 0% | 100% | 6.00 |

### Step 7: Manifest (`build_manifest.py`)

`models/onnx/manifest.json` is the **contract between the Python build and the browser runtime**. For every artifact and precision it lists the file path, byte size, SHA-256 hash, and input/output names, dtypes and shapes. It also records the chain order, the exit points, the labels and the tokenizer settings (WordPiece, lowercase, `[CLS]=101`, `[SEP]=102`, `[PAD]=0`, `[UNK]=100`). The browser never hard-codes model details; it reads them from the manifest. The storage layer (Phase 4) will use the SHA-256 hashes to detect corrupted cache entries.

### Extra check: onnxruntime-web (`tests/ortweb_chain_smoke.mjs`)

This loads each chunk with `ort.InferenceSession.create(bytes, {executionProviders:['wasm']})`, runs it, passes `hidden` to the next chunk, and calls `release()`. It's exactly the load → run → release pattern of the SEQUENTIAL policy. Results:

- fp32 chain = full model, to 4 decimal places.
- int8 chain works; the WASM backend supports `DynamicQuantizeLinear`, `MatMulInteger` and `DequantizeLinear`.

This removes the biggest technical risk for Phases 2–3 early.

---

## 4. Technical decisions

| Decision | Alternatives | Why |
|---|---|---|
| **4 chunks, embeddings separate** | 3 chunks (embed + 2 layers together) | Embeddings are 23.8M parameters, as much as 3.4 layers. Keeping them separate balances the chunks and makes C0 a natural candidate for int8 (biggest saving, least sensitive). |
| **Wrap the original modules, don't re-implement** | Rewrite attention by hand | Equivalence is guaranteed by construction (Δ = 0.0), and the code stays small. |
| **`attn_implementation="eager"`** | SDPA (PyTorch's default) | SDPA needs a 4-D mask prepared outside the blocks and exports to less portable ops. Eager attention takes the plain 2-D mask inside each block and exports to basic `MatMul`/`Softmax`/`Where`. |
| **Pass `attention_mask` to every chunk** | Pass it once | Every attention layer needs it to ignore `[PAD]` tokens. Without it, padded batches give wrong results. |
| **Boundary tensor named `hidden_in`/`hidden`** | Generic names | Lets the runtime chain any chunk to any other mechanically: output `hidden` → input `hidden_in`. |
| **opset 17** | 14 (older) / 18+ | Native `LayerNormalization`, and fully supported in ORT-web 1.20. |
| **Dynamic quantization** | Static (needs calibration data), QAT (needs training), fp16 | No calibration data, 4× smaller, supported by the WASM backend. fp16 gives only 2× and is mainly useful on WebGPU, which is out of scope. |
| **Exit heads on a frozen backbone, initialised from the final head** | Fine-tune the whole model with exits (DeeBERT-style) | Minutes of CPU instead of hours of GPU, and the main path's accuracy stays exactly 91.06%. |
| **Epoch selection on a train-dev split** | Select on validation | Avoids optimistic bias in the reported numbers. |
| **Shard-and-resume feature extraction** | One long process | Needed because of the ~3 min limit per command in the sandbox. It also makes the step robust in general. |

---

## 5. Why each part matters to the overall project

| Component | Role in the final system |
|---|---|
| Chunks C0–C3 | The independently managed **execution units** at the centre of the research question. They are what the cache stores, the decision engine selects, and workers execute. |
| int8 variants | The **second adaptivity axis** (precision). Under memory or network pressure the runtime picks int8 at 4× smaller size. |
| Exit heads | Make "load fewer chunks" meaningful. With early exit, C3 (and possibly C2) need **not be downloaded at all**. Without them, every inference needs every chunk. |
| `manifest.json` | Lets the runtime work from data, not hard-coded values, and provides the integrity hashes for the cache. |
| `validate.py` results | Supply the accuracy column of the final evaluation, and prove that splitting itself is free. Any later difference is due to policy, not to the split. |
| `tests/ortweb_chain_smoke.mjs` | Proves the artifacts are compatible with the target runtime before Phase 2. |

---

## 6. Files and components

**Created**

| Path | Purpose |
|---|---|
| `python/adaptive_split/__init__.py` | Package exports |
| `python/adaptive_split/chunks.py` | `CHUNK_SPEC`, `EXIT_POINTS`, `EmbeddingChunk`, `LayerGroupChunk`, `ClassifierChunk`, `ExitHead`, `build_chunks()`, `run_chain()` |
| `python/adaptive_split/load.py` | Offline model and tokenizer loading; `random=True` for smoke tests |
| `python/split_model.py` | Step 1: split + PyTorch equivalence check |
| `python/export_onnx.py` | Step 2: fp32 ONNX export |
| `python/quantize.py` | Step 3: int8 dynamic quantization |
| `python/train_exit_heads.py` | Step 4: `extract` (sharded, resumable) and `train` |
| `python/export_heads.py` | Step 5: heads → ONNX fp32/int8 |
| `python/validate.py` | Step 6: `acc` and `exit` parts |
| `python/build_manifest.py` | Step 7: manifest |
| `python/run_phase1.sh` | Runs the whole pipeline in order |
| `python/requirements.txt` | Pinned dependencies |
| `tests/ortweb_chain_smoke.mjs`, `tests/package.json` | onnxruntime-web smoke test (`cd tests && npm i && npm run smoke`) |
| `models/onnx/{fp32,int8}/*.onnx` (14 files), `models/onnx/manifest.json`, `models/onnx/vocab.txt` | Artifacts |
| `models/heads/e1_after_c1.pt`, `e2_after_c2.pt` | Trained head weights |
| `results/phase1/split_check.json`, `split_check_random.json`, `exit_heads.json`, `onnx_validation.json` | Raw validation evidence |

---

## 7. Validation summary

| # | Test | Criterion | Result |
|---|---|---|---|
| V1 | PyTorch chain vs full model (872 sentences) | Δ < 1e-5, 100% agreement | ✅ Δ = 0.0 |
| V2 | Parameters preserved | sum of chunks = model | ✅ 66,955,010 = 66,955,010 |
| V3 | Pipeline runs on random weights | passes | ✅ |
| V4 | ONNX fp32 chain vs PyTorch | Δ < 1e-4 | ✅ 2.4e-5 |
| V5 | ONNX fp32 accuracy = PyTorch accuracy | equal | ✅ 91.06% = 91.06% |
| V6 | int8 accuracy drop measured | reported | ✅ −0.69 points |
| V7 | int8 chain = int8 full model | equal | ✅ identical accuracy and agreement |
| V8 | Splitting adds no bytes | sum of chunks ≈ full | ✅ 267.9 = 267.9 MB |
| V9 | Exit-head accuracy reported | reported | ✅ 76.4% / 81.3% |
| V10 | onnxruntime-web loads and chains every fp32 and int8 chunk | runs; fp32 = full | ✅ |

---

## 8. Issues, limitations and deviations

| ID | Issue | Severity | Action |
|---|---|---|---|
| I-1.1 | **The planned "mixed" setting (C0 fp32, rest int8) was disproven.** It scored 90.02%, below all-int8 (90.37%). The sensitivity test shows C0 is the *least* sensitive chunk, and C2 the most. | Medium (plan change) | Replace it in Phase 7 with a **sensitivity-driven** mix: C0 int8, C1 int8, C2 fp32, C3 int8. To be measured; I'm not claiming a result yet. |
| I-1.2 | **Accuracy differences under 1 point are within noise.** With 872 sentences, 1 sentence = 0.115 points; int8's −0.69 is 6 sentences. | Medium (interpretation) | Report the prediction-flip counts alongside accuracy, and avoid strong claims from accuracy differences between int8 settings. Add a McNemar test in Phase 7. |
| I-1.3 | **τ was swept on the validation set.** Choosing "τ = 0.98" from this table would be optimistic. | Medium | In Phase 5, choose τ on the train-dev split. The curve above is reported as a descriptive trade-off, not a tuned result. |
| I-1.4 | **Early exit saves compute, but bytes only if C3 is never needed.** In a session, the first low-confidence sentence forces C3 to download. | Design note | Phase 5 decides this: under the "Low" profile the policy can *force* an exit (C3 never downloaded), with the accuracy cost reported. Under the others, C3 is lazy-loaded. |
| I-1.5 | Max sequence length was 64 when training the heads and 128 when validating | Low | SST-2 sentences are short, so truncation at 64 rarely applies. Keep 128 in the runtime. |
| I-1.6 | The feature cache is in the sandbox's scratch space, which is not persistent | Low | It is reproducible (`train_exit_heads.py extract`, ~5 min, resumable). The trained heads themselves are saved in `models/heads/`. |
| I-1.7 | **A stray 95 MB file is in `_to_delete/`.** It's a temporary file from my first quantization attempt; I can't delete files in your folder. | Low | Please delete `_to_delete/` in Finder. `quantize.py` now uses scratch space, so this won't happen again. |
| I-1.8 | No git repository yet (see I-0.1) | Medium | Your decision: run `git init` on macOS, or allow me delete permission. |
| I-1.9 | The timings in this phase (e.g. Node int8 chain 123 ms vs fp32 799 ms) are **one-off, not benchmarks** | Info | Proper benchmarking is Phase 7. |

No planned requirement was skipped.

---

## 9. Outcome

All model artifacts for the project exist, are described by a manifest, and are verified at three levels: PyTorch, ONNX Runtime (Python), and onnxruntime-web (WASM). Three findings will matter for the evaluation:

1. **Splitting is free:** no accuracy cost and no byte overhead.
2. **int8 costs 0.69 points** for a 4× size reduction, and quantization sensitivity differs between chunks (C2 is the most sensitive).
3. **Early exit gives a tunable trade-off:** up to 29% of sentences can exit early with no measured accuracy loss.

---

## 10. Next phase: Phase 2, baseline browser inference (planned 7–9 Nov; can start 1 Nov)

**Objective:** Run the unsplit model (`full.onnx`) end to end in a real browser page, as the baseline that every adaptive policy will be compared against.

**Tasks:**

1. Vite dev server with **COOP/COEP headers** (cross-origin isolation, required for `measureUserAgentSpecificMemory` and multi-threaded WASM).
2. JavaScript WordPiece tokenizer driven by `vocab.txt` and the manifest. Validate it against the Python tokenizer on all 872 sentences: token IDs must be identical.
3. Load `full.onnx` (fp32 and int8) with onnxruntime-web and classify the sentences; accuracy must equal the Python figures (91.06% / 90.37%).
4. Memory measurement harness, with a fallback to the WASM heap size.
5. Automate the run in headless Chromium (Playwright).

**Dependencies:** Phase 1 artifacts ✅; npm access ✅. One open question is whether Chromium can run inside your Mac's sandbox. If it can't, the browser checks run in the cloud workspace with the artifacts copied there.

**Knowledge-transfer topics for Phase 2:** WordPiece tokenization, cross-origin isolation, how ORT-web loads WASM, and measuring memory in a browser.
