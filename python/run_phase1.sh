#!/usr/bin/env bash
# Reproduce Phase 1 end to end (Linux/macOS). Prereq: scripts/fetch_resources.sh has been run.
# Each step is idempotent; feature extraction resumes from cached shards.
set -euo pipefail
cd "$(dirname "$0")"
export QUANT_SCRATCH="${QUANT_SCRATCH:-${TMPDIR:-/tmp}}" FEAT_CACHE="${FEAT_CACHE:-${TMPDIR:-/tmp}/adaptive_feat}"
python split_model.py                 # 1. PyTorch split equivalence + baseline accuracy
python export_onnx.py                 # 2. fp32 ONNX: full + 4 chunks
python quantize.py                    # 3. int8 dynamic quantization
python train_exit_heads.py extract    # 4a. cache [CLS] features (resumable; rerun if budget hit)
python train_exit_heads.py train      # 4b. train E1/E2 heads (frozen backbone)
python export_heads.py                # 5. heads -> ONNX fp32 + int8
python validate.py acc                # 6a. ONNX accuracy / equivalence / per-chunk int8 sensitivity
python validate.py exit               # 6b. early-exit threshold curve
cp ../models/hf/distilbert-sst2/vocab.txt ../models/onnx/vocab.txt
python build_manifest.py              # 7. manifest.json (sizes, sha256, I/O signatures)
