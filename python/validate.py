"""
Phase 1 / step 6 — validate the ONNX artifacts with onnxruntime (CPU EP, same kernels
family the browser WASM backend uses).

Checks
  A. Numerical equivalence: ONNX chain (fp32) vs PyTorch full model, max |logit diff|.
  B. Accuracy on SST-2 validation (872) for: ONNX full fp32/int8, chain fp32/int8/mixed,
     and "one chunk int8, rest fp32" (per-chunk quantization sensitivity).
  C. Early exit: accuracy & fraction exited for confidence thresholds tau.
Writes: ../results/phase1/onnx_validation.json
"""
import json, sys
import numpy as np, pandas as pd, onnxruntime as ort, torch
from adaptive_split import load_model, load_tokenizer
from adaptive_split.load import ROOT

CH = ["c0_embed", "c1_l0_1", "c2_l2_3", "c3_l4_5_cls"]
_sess = {}
def S(name, prec):
    k = (name, prec)
    if k not in _sess:
        o = ort.SessionOptions(); o.graph_optimization_level = ort.GraphOptimizationLevel.ORT_ENABLE_ALL
        _sess[k] = ort.InferenceSession(str(ROOT / f"models/onnx/{prec}/{name}.onnx"), o, providers=["CPUExecutionProvider"])
    return _sess[k]

def chain(ids, mask, precs, keep=False):
    h0 = S(CH[0], precs[0]).run(None, {"input_ids": ids})[0]
    h1 = S(CH[1], precs[1]).run(None, {"hidden_in": h0, "attention_mask": mask})[0]
    h2 = S(CH[2], precs[2]).run(None, {"hidden_in": h1, "attention_mask": mask})[0]
    lg = S(CH[3], precs[3]).run(None, {"hidden_in": h2, "attention_mask": mask})[0]
    return (lg, h1, h2) if keep else lg

def main():
    tok = load_tokenizer(); model = load_model()
    val = pd.read_parquet(ROOT / "data/sst2/validation.parquet"); y = val.label.values
    batches = [tok(val.sentence.iloc[i:i+32].tolist(), padding=True, truncation=True, max_length=128, return_tensors="np")
               for i in range(0, len(val), 32)]
    feed = [(b["input_ids"].astype(np.int64), b["attention_mask"].astype(np.int64)) for b in batches]

    with torch.no_grad():
        ref = np.concatenate([model(input_ids=torch.tensor(i), attention_mask=torch.tensor(m)).logits.numpy() for i, m in feed])
    part = sys.argv[1] if len(sys.argv) > 1 else "all"
    out = ROOT / "results/phase1/onnx_validation.json"
    rep = json.loads(out.read_text()) if out.exists() else {}
    rep["pytorch_acc"] = float((ref.argmax(-1) == y).mean())

    def evaluate(fn):
        lg = np.concatenate([fn(i, m) for i, m in feed])
        return {"acc": float((lg.argmax(-1) == y).mean()), "max_abs_diff_vs_pytorch": float(np.abs(lg - ref).max()),
                "agreement_vs_pytorch": float((lg.argmax(-1) == ref.argmax(-1)).mean())}

    configs = {"full_fp32": lambda i, m: S("full", "fp32").run(None, {"input_ids": i, "attention_mask": m})[0],
               "full_int8": lambda i, m: S("full", "int8").run(None, {"input_ids": i, "attention_mask": m})[0],
               "chain_fp32": lambda i, m: chain(i, m, ["fp32"]*4),
               "chain_int8": lambda i, m: chain(i, m, ["int8"]*4),
               "chain_mixed_c0fp32": lambda i, m: chain(i, m, ["fp32", "int8", "int8", "int8"])}
    for k in range(4):
        p = ["fp32"]*4; p[k] = "int8"
        configs[f"only_{CH[k]}_int8"] = (lambda pp: lambda i, m: chain(i, m, pp))(p)
    rep.setdefault("configs", {})
    for name, fn in (configs.items() if part in ("acc", "all") else []):
        rep["configs"][name] = evaluate(fn); print(name, rep["configs"][name], flush=True)
    _sess.clear()

    if part == "acc":
        out.write_text(json.dumps(rep, indent=2)); print("PART acc DONE"); return
    # early exit (fp32 chunks + fp32 heads)
    L, E1, E2 = [], [], []
    for i, m in feed:
        lg, h1, h2 = chain(i, m, ["fp32"]*4, keep=True)
        L.append(lg); E1.append(S("e1_after_c1", "fp32").run(None, {"hidden_in": h1})[0])
        E2.append(S("e2_after_c2", "fp32").run(None, {"hidden_in": h2})[0])
    L, E1, E2 = map(np.concatenate, (L, E1, E2))
    sm = lambda z: np.exp(z - z.max(-1, keepdims=True)) / np.exp(z - z.max(-1, keepdims=True)).sum(-1, keepdims=True)
    c1, c2 = sm(E1).max(-1), sm(E2).max(-1)
    rep["exit_heads_acc"] = {"e1": float((E1.argmax(-1) == y).mean()), "e2": float((E2.argmax(-1) == y).mean()),
                             "final": float((L.argmax(-1) == y).mean())}
    curve = []
    for tau in [0.5, 0.8, 0.9, 0.95, 0.98, 0.99, 1.01]:
        ex1 = c1 >= tau; ex2 = ~ex1 & (c2 >= tau); rest = ~ex1 & ~ex2
        pred = np.where(ex1, E1.argmax(-1), np.where(ex2, E2.argmax(-1), L.argmax(-1)))
        # layers executed per sentence: exit1 -> 2, exit2 -> 4, full -> 6
        avg_layers = (2*ex1.sum() + 4*ex2.sum() + 6*rest.sum()) / len(y)
        curve.append({"tau": tau, "acc": float((pred == y).mean()), "exit1_frac": float(ex1.mean()),
                      "exit2_frac": float(ex2.mean()), "full_frac": float(rest.mean()), "avg_layers": float(avg_layers)})
        print(curve[-1], flush=True)
    rep["early_exit_curve"] = curve
    out.write_text(json.dumps(rep, indent=2))
    print("VALIDATION DONE")

if __name__ == "__main__":
    main()
