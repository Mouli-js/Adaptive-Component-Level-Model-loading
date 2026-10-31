"""
Phase 2 — fixtures for browser-side validation (git-ignored under data/).

data/sst2/validation.json      : [{sentence, label}]  (872)    -> browser accuracy test
data/sst2/py_token_ids.json    : Python tokenizer output for every sentence (max_length 128)
                                  -> the JS tokenizer must reproduce these IDs exactly
data/sst2/py_logits.json       : PyTorch logits per sentence -> numeric comparison in browser
data/sst2/py_ort_int8_logits.json : Python onnxruntime int8 full-model logits (batch 1)
                                  -> reference for the browser int8 run (same graph, different runtime)
"""
import numpy as np, onnxruntime as ort
import json
import pandas as pd, torch
from adaptive_split import load_model, load_tokenizer
from adaptive_split.load import ROOT

def main():
    val = pd.read_parquet(ROOT / "data/sst2/validation.parquet")
    tok, model = load_tokenizer(), load_model()
    rows = [{"sentence": s, "label": int(l)} for s, l in zip(val.sentence, val.label)]
    ids = [tok(s, truncation=True, max_length=128)["input_ids"] for s in val.sentence]
    logits = []
    with torch.no_grad():
        for s in val.sentence:  # batch size 1: no padding, identical to what the browser test runs
            enc = tok(s, truncation=True, max_length=128, return_tensors="pt")
            logits.append([round(float(x), 6) for x in model(**enc).logits[0]])
    sess = ort.InferenceSession(str(ROOT / "models/onnx/int8/full.onnx"), providers=["CPUExecutionProvider"])
    int8 = []
    for i in ids:
        a = np.array([i], dtype=np.int64)
        int8.append([round(float(x), 6) for x in sess.run(None, {"input_ids": a, "attention_mask": np.ones_like(a)})[0][0]])
    d = ROOT / "data/sst2"
    (d / "py_ort_int8_logits.json").write_text(json.dumps(int8))
    acc8 = sum((l[1] > l[0]) == bool(r["label"]) for l, r in zip(int8, rows)) / len(rows)
    print(f"batch-1 Python ORT int8 acc {acc8:.4f}")
    (d / "validation.json").write_text(json.dumps(rows))
    (d / "py_token_ids.json").write_text(json.dumps(ids))
    (d / "py_logits.json").write_text(json.dumps(logits))
    acc = sum((l[1] > l[0]) == bool(r["label"]) for l, r in zip(logits, rows)) / len(rows)
    print(f"{len(rows)} sentences; max len {max(map(len, ids))}; batch-1 PyTorch acc {acc:.4f}")
    # tokenizer edge cases worth knowing about
    special = [s for s in val.sentence if any(ord(c) > 127 for c in s)]
    print(f"{len(special)} sentences contain non-ASCII characters, e.g. {special[:2]}")

if __name__ == "__main__":
    main()
