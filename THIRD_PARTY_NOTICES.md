# Third-Party Notices

The **`adaptive-onnx-loader` package code** (everything under `packages/adaptive-onnx-loader/`) is licensed under the
**MIT licence, © 2026 Moulieswaran M** (see `packages/adaptive-onnx-loader/LICENSE`).

**That MIT licence does not apply to the third-party components below.** They keep their own licences. This file lists what the project uses, how it is used, and what that implies. Licences were checked on 31 Oct 2026 against the sources named in each section.

---

## 1. DistilBERT fine-tuned on SST-2 (model weights)

- **Source:** https://huggingface.co/distilbert/distilbert-base-uncased-finetuned-sst-2-english
- **Licence:** **Apache License 2.0**, from the model card (`license: apache-2.0`; "License: Apache-2.0").
- **How it is used:** the downloaded checkpoint (`models/hf/`, git-ignored) is converted by `python/` into derived artifacts:
  - ONNX chunk graphs (`models/onnx/fp32/*.onnx`)
  - dynamically quantized int8 graphs (`models/onnx/int8/*.onnx`)
  - two early-exit heads, trained on top of the frozen model (`models/heads/`, `models/onnx/*/e*_after_*.onnx`)
  - a copy of `vocab.txt`
- **Modifications:** the model was split into 4 graphs at layer boundaries and exported to ONNX (opset 17), with int8 dynamic quantization. Small classifier heads were added and trained on intermediate layers. The weights of the original layers are unchanged.
- **Not redistributed by this repository:** all `*.onnx`, `*.pt`, `*.safetensors` files and `vocab.txt` are git-ignored. **If you redistribute the model artifacts** (e.g. host them with the demo, or publish them), Apache-2.0 requires you to include a copy of the Apache-2.0 licence, keep any NOTICE provided upstream, and state that the files were modified (as described above).
- **Not covered by the package's MIT licence.** The npm package does not contain any model files.

## 2. SST-2 / Stanford Sentiment Treebank (evaluation data)

- **Source used:** the GLUE SST-2 parquet files on Hugging Face (`nyu-mll/glue`, fallback `stanfordnlp/sst2`).
- **Licence:** **not stated.** The `stanfordnlp/sst2` dataset card gives `license: unknown` ("Licensing Information: Unknown").
- **How it is used:** evaluation and training of the small exit heads only. Files are under `data/`, which is **git-ignored and never redistributed**. The package contains no dataset content. Reference fixtures derived from it (logits, token ids) are also git-ignored. The only tracked results are aggregate metrics.
- **Citation (as given on the dataset card):** Socher, R. et al. (2013). *Recursive Deep Models for Semantic Compositionality Over a Sentiment Treebank.* EMNLP 2013.
- Because the licence is unknown, **do not redistribute the dataset or per-sentence derivatives** without checking the original terms.

## 3. ONNX Runtime Web (`onnxruntime-web` 1.20.1)

- **Source:** https://github.com/microsoft/onnxruntime · npm `onnxruntime-web`
- **Licence:** **MIT**, © Microsoft Corporation (`package.json` → `"license": "MIT"`).
- **How it is used:** a **peer dependency**. The application installs it, and the package loads it at runtime. **It is not bundled** in `adaptive-onnx-loader`, so its licence travels with its own npm package.

## 4. Development and test dependencies (not shipped)

| Component | Licence | Use |
|---|---|---|
| `fake-indexeddb` 6.0.0 | Apache-2.0 | IndexedDB in Node unit tests (devDependency of the package; not in the tarball) |
| `typescript` 5.6.3 | Apache-2.0 | Type-checking a consumer file in `bench/phase6_pack_test.mjs` (temporary project only) |
| Playwright / Chromium | Apache-2.0 / BSD-style | Automated browser tests in the cloud workspace (not a project dependency) |
| PyTorch, Hugging Face `transformers`, `onnx`, `onnxruntime` (Python), NumPy, pandas, pyarrow, scikit-learn | BSD-3-Clause / Apache-2.0 / MIT / BSD | Offline model pipeline (`python/requirements.txt`); not shipped |

Licences in section 4 are the projects' published licences, listed for completeness. They aren't redistributed by this repository.
