# Findings Register

Every experimental finding made during development is recorded here, with its evidence and how it will appear in the final evaluation. Entries are never deleted. If a later phase overturns a finding, the entry is updated and marked **Superseded**.

**Status values:**

- **Observed:** measured once in development.
- **Planned experiment:** a controlled measurement is scheduled for Phase 7.
- **Mandatory in final report:** you require it to be reported.

| ID | Finding | Phase | Evidence | Status | Final-evaluation treatment |
|---|---|---|---|---|---|
| F-1 | Layer-group splitting is lossless: PyTorch chain Δ = 0.0, ONNX fp32 chain Δ = 2.4e-5, and the chunk files add up to the full model with no byte overhead | 1 | `results/phase1/split_check.json`, `onnx_validation.json` | Observed | Shown as a baseline fact before the adaptive results |
| F-2 | int8 sensitivity differs per chunk: C2 flips 20/872 predictions, C0 only 4/872 | 1 | `results/phase1/onnx_validation.json` | Observed → planned experiment | Basis for the "mixed" setting (C2 fp32); evaluated in Phase 7 |
| F-3 | A model's WASM heap is ~2.6–2.8× its file size (fp32 255.5 MiB → 656 MiB; int8 64.2 MiB → 180 MiB) | 2 | `results/phase2/browser_baseline_*.json` | Observed | Explains why peak memory, not file size, is the constraint |
| F-4 | The WASM heap does not shrink after `session.release()`. Confirmed on a real device: MAC-CHROME-4T int8 181.5 → 181.5 MiB, fp32 696.9 → 696.9 MiB. A reload in the same page reuses the freed space without growing the heap. | 2 | same (`memLoaded` = `memReleased`); `results/phase2/mac_*_4t.json` | Observed (cloud + real device) | Motivates Worker-per-chunk; Phase 3 tests whether terminating a Worker frees memory |
| **F-5** | **Native vs WASM int8 kernels differ.** Python ONNX Runtime (native CPU EP) int8: 90.14%; onnxruntime-web WASM int8: 90.02%. 1 prediction flip in 872 (sentence 702), mean \|Δlogit\| 0.018, max 1.21. Not caused by graph optimisation. WASM is bit-identical across x86 Chromium and ARM Node. | 2 | `results/phase2/int8_parity_diagnosis.json` | **Mandatory in final report** (D-2.1, approved 31 Oct) | Separate table in the evaluation: native vs WASM accuracy, flips and logit differences for full-int8 and the chunked int8 settings. Browser int8 is validated against the WASM reference. |
| **F-6** | **With dynamic int8 quantization, a prediction depends on the batch.** Native int8 full model: 90.37% at batch 32 (padded) vs 90.14% at batch 1. One activation scale is computed per tensor, so other sentences and the padding change the quantization of each sentence. fp32 is unaffected. | 1–2 | `results/phase1/onnx_validation.json` (batch 32) vs `data/sst2/py_ort_int8_logits.json` (batch 1) | **Planned experiment E-B** (you require it to be kept as an explicit finding) | Phase 7 experiment E-B below |
| F-7 | `measureUserAgentSpecificMemory()` is missing from Playwright's headless shell, waits ~16 s for GC without `ForceEagerMeasureMemory`, and takes ~60 s per call once ORT worker threads exist | 2 | Phase 2 report §3.4 | Observed | Methodology section: why the WASM-heap probe is the primary memory metric |
| F-8 | The WASM-heap probe agrees with the browser's whole-page measurement to within ~5 MiB | 2 | `results/phase2/browser_baseline_*.json` (`wasmHeapBytes` vs `uaBytes`) | Observed | Validates metric M3 |
| F-9 | Load time on the shared cloud machine varies widely between runs (int8: 752 ms vs 6,365 ms for the same file) | 2 | `browser_baseline_int8.json` vs `browser_baseline_recheck.json` | Observed | Methodology: ≥5 repetitions, report mean ± std and the median |
| F-11 | Reloading the same model in the same page after `release()` makes the fetch slower: 6/6 pairs (int8 ×1.2–1.4, fp32 ×2.2–2.7), while session creation becomes much faster (int8 645 → 85 ms, fp32 1,317 → 189 ms) | 2 | `results/phase2/diag_fetch_cloud_{cold,warm}.json` (T2) | Observed | Load-time results must state whether a load is first or repeated; Phase 4 should avoid re-fetching |
| F-12 | The first large fetch in a fresh page pays a ~600 ms penalty that persists with a warm OS cache (int8: 987 / 793 ms vs ~150 ms afterwards) | 2 | same (T1, round 0) | Observed; cause not determined | Phase 7 cold-start measurements include it and report it separately |
| F-13 | On MAC-CHROME-4T, int8 latency ≈ fp32 (p50 16.0 vs 16.8 ms); in the cloud, int8 was clearly faster (1 thread 43 vs 70 ms; 2 threads 28 vs 37 ms) | 2 | `results/phase2/mac_*_4t.json`, `browser_baseline_*.json` | Observed → Phase 7 thread sweep | int8's benefit is reported as size and memory, with speed depending on device and thread count |
| **F-14** | **On MAC-CHROME-4T, the int8 fetch (67 MB) took 736.5 ms vs 548.4 ms for fp32 (268 MB), a 5× lower byte rate.** It does **not** reproduce in the cloud: int8 was faster in 12/12 controlled rounds. Explanations (a)–(e) were tested in the cloud and none explains it. | 2 | `mac_*_4t.json`; `diag_fetch_cloud_*.json`; Phase 2 report §14.5 | **Open, cause not determined** (needs a Mac diagnostic run, I-2.7) | Reported as an unexplained single observation unless the Mac diagnostic explains it |
| F-15 | After loading, the JS heap still holds the downloaded model bytes (+67.4 / +268.0 MB, equal to the file size), still present when `release()` returns. fp32 page total ≈ 964 MiB (WASM 697 + JS 267) before GC. | 2 | `mac_*_4t.json` (`jsHeapUsedBytes`) | Observed | Peak-memory accounting = WASM heap + transient JS bytes; Phase 3 Workers transfer bytes instead of copying them |
| F-16 | MAC-CHROME-4T reports `navigator.deviceMemory` = 16 (older specifications capped this at 8). Chrome's UA string reports "Intel Mac OS X 10_15_7" on Apple Silicon. | 2 | `mac_*_4t.json` | Observed | Phase 5 resource monitor reads real values and must not infer the CPU architecture from the UA string |
| F-10 | Early exit after 4 layers keeps 91.06% accuracy at τ = 0.98 with 29% of sentences exiting early (τ swept on validation, so optimistic) | 1 | `results/phase1/onnx_validation.json` | Observed → τ re-tuned on dev in Phase 5 | Early-exit results use the τ chosen on the dev split |

## Planned experiment E-B: batch-size dependence of dynamic int8 (F-6)

**Question:** How much does an int8 prediction depend on which sentences are batched with it, and does the chunked chain behave the same way as the full model?

**Design (Phase 7):**

| Factor | Levels |
|---|---|
| Runtime | Native ONNX Runtime (Python CPU EP); onnxruntime-web WASM (browser) |
| Model | full int8; chained int8 (C0–C3 all int8) |
| Batch size | 1, 4, 8, 16, 32 |
| Batch composition | (a) dataset order; (b) shuffled, 5 seeds; (c) length-sorted (minimal padding) |
| Control | fp32 at the same batch sizes; expected to be invariant within ~1e-5 |

**Metrics:**

- Accuracy, plus the number of predictions flipped relative to batch size 1
- Mean and max \|Δlogit\| relative to batch size 1
- For (b), the spread of accuracy across seeds

**Expected outcome (hypothesis H6):** int8 flips grow with batch size and padding; length-sorted batching reduces them; fp32 shows none.

**Why it matters for the system:** if F-6 is confirmed, the runtime should either use batch size 1 for int8 or sort batches by length. That's a concrete design rule the npm package will document.

## Rule for the final evaluation

F-5 and F-6 must appear as **named findings with their own tables** in `docs/FINAL_REPORT.md` and be referenced in `docs/VIVA_PREP.md`. Neither may be folded into averages.
