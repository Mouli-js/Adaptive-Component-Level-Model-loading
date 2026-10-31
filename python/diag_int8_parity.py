"""Diagnostic: why does browser int8 differ from Python int8 by one sentence?
Compares per-sentence logits: Python ORT (native CPU EP, opt ALL / DISABLED) vs ORT-web WASM.
Writes results/phase2/int8_parity_diagnosis.json"""
import json, platform
import numpy as np, onnxruntime as ort
from adaptive_split.load import ROOT

D = ROOT / "data/sst2"
rows = json.loads((D / "validation.json").read_text()); ids = json.loads((D / "py_token_ids.json").read_text())
y = np.array([r["label"] for r in rows]); fp32 = np.array(json.loads((D / "py_logits.json").read_text()))

def py_int8(level):
    o = ort.SessionOptions(); o.graph_optimization_level = level
    s = ort.InferenceSession(str(ROOT / "models/onnx/int8/full.onnx"), o, providers=["CPUExecutionProvider"])
    return np.array([s.run(None, {"input_ids": np.array([i], np.int64), "attention_mask": np.ones((1, len(i)), np.int64)})[0][0] for i in ids])

L = {"py_cpu_opt_all": py_int8(ort.GraphOptimizationLevel.ORT_ENABLE_ALL),
     "py_cpu_opt_disabled": py_int8(ort.GraphOptimizationLevel.ORT_DISABLE_ALL),
     "wasm_opt_all": np.array(json.loads((D / "wasm_int8_logits_all.json").read_text())),
     "wasm_opt_disabled": np.array(json.loads((D / "wasm_int8_logits_disabled.json").read_text()))}
rep = {"machine": platform.machine(), "onnxruntime": ort.__version__, "acc": {k: float(((v[:, 1] > v[:, 0]) == y).mean()) for k, v in L.items()}}
pairs = [("py_cpu_opt_all", "wasm_opt_all"), ("py_cpu_opt_disabled", "wasm_opt_disabled"),
         ("py_cpu_opt_all", "py_cpu_opt_disabled"), ("wasm_opt_all", "wasm_opt_disabled")]
rep["pairs"] = {}
for a, b in pairs:
    d = np.abs(L[a] - L[b]).max(1); flips = np.where((L[a][:, 1] > L[a][:, 0]) != (L[b][:, 1] > L[b][:, 0]))[0]
    rep["pairs"][f"{a} vs {b}"] = {"max_abs": float(d.max()), "mean_abs": float(d.mean()), "n_flips": int(len(flips)), "flips": flips.tolist()}
flip_ids = sorted({i for p in rep["pairs"].values() for i in p["flips"]})
margin = lambda v: float(v[1] - v[0])
rep["flipped_sentences"] = [{"idx": int(i), "sentence": rows[i]["sentence"], "label": int(y[i]),
    "margin_pos_minus_neg": {k: round(margin(v[i]), 4) for k, v in L.items()} | {"fp32_pytorch": round(margin(fp32[i]), 4)}} for i in flip_ids]
# how close to the decision boundary is int8 in general?
m = np.abs(L["wasm_opt_all"][:, 1] - L["wasm_opt_all"][:, 0])
rep["wasm_int8_sentences_with_|margin|<1.25"] = int((m < 1.25).sum())
(ROOT / "results/phase2").mkdir(parents=True, exist_ok=True)
(ROOT / "results/phase2/int8_parity_diagnosis.json").write_text(json.dumps(rep, indent=2, ensure_ascii=False))
print(json.dumps(rep, indent=2, ensure_ascii=False))
