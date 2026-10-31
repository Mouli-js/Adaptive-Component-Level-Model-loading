#!/usr/bin/env bash
# Run this in macOS Terminal (NOT inside Claude's VM, which cannot reach huggingface.co).
# Downloads the pretrained DistilBERT-SST2 checkpoint and the SST-2 validation set.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
REPO="https://huggingface.co/distilbert/distilbert-base-uncased-finetuned-sst-2-english/resolve/main"
M="$ROOT/models/hf/distilbert-sst2"; D="$ROOT/data/sst2"
mkdir -p "$M" "$D"
for f in config.json model.safetensors tokenizer_config.json vocab.txt; do
  echo "-> $f"; curl -fL --retry 3 -o "$M/$f" "$REPO/$f"
done
# tokenizer.json is not in this repo; it is rebuilt from vocab.txt later.
echo "-> SST-2 validation"
curl -fL --retry 3 -o "$D/validation.parquet" \
  "https://huggingface.co/datasets/nyu-mll/glue/resolve/main/sst2/validation-00000-of-00001.parquet" \
 || curl -fL --retry 3 -o "$D/validation.parquet" \
  "https://huggingface.co/datasets/stanfordnlp/sst2/resolve/main/data/validation-00000-of-00001.parquet"
echo "-> SST-2 train (used only to train the small early-exit heads)"
curl -fL --retry 3 -o "$D/train.parquet" \
  "https://huggingface.co/datasets/nyu-mll/glue/resolve/main/sst2/train-00000-of-00001.parquet" \
 || curl -fL --retry 3 -o "$D/train.parquet" \
  "https://huggingface.co/datasets/stanfordnlp/sst2/resolve/main/data/train-00000-of-00001.parquet"
echo; echo "Done. Sizes:"; ls -lh "$M" "$D"
shasum -a 256 "$M"/* "$D"/* > "$ROOT/models/hf/SHA256SUMS.txt"; cat "$ROOT/models/hf/SHA256SUMS.txt"
