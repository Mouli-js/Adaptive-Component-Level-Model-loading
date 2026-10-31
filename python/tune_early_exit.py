"""
Phase 5 — tune the early-exit threshold τ on the DEV split only (I-1.3).
Dev = last 2,000 of the 20,000 cached training sentences. The heads were trained on the
other 18,000; this dev split was used for their epoch selection (Phase 1) and now for τ —
i.e. only for model selection, never for the reported evaluation.
Rule: the smallest τ on a grid whose early-exit prediction agrees with the full model's
prediction on ≥ AGREE_TARGET of dev sentences. Accuracy is then reported on the
SST-2 validation set separately (WASM, in the browser), never used for the choice.
Writes models/heads/early_exit_policy.json
"""
import json, os
from pathlib import Path
import numpy as np, torch
from adaptive_split import ExitHead
from adaptive_split.load import ROOT

AGREE_TARGET = 0.99
GRID = [0.80, 0.85, 0.90, 0.925, 0.95, 0.96, 0.97, 0.98, 0.99, 0.995]
CACHE = Path(os.environ.get("FEAT_CACHE", ROOT / "results/phase1/feat_cache"))

def load(split):
    parts = [np.load(f) for f in sorted(CACHE.glob(f"{split}_*.npz"))]
    return {k: np.concatenate([p[k] for p in parts]) for k in ("f1", "f2", "full")}

def head_conf(name, X):
    h = ExitHead(); h.load_state_dict(torch.load(ROOT / f"models/heads/{name}.pt", weights_only=True)); h.eval()
    with torch.no_grad(): p = torch.softmax(h(torch.tensor(X)[:, None, :]), -1).numpy()   # hidden[:,0] = CLS
    return p.argmax(-1), p.max(-1)

def main():
    tr = load("train"); dev = {k: v[-2000:] for k, v in tr.items()}
    full_pred = dev["full"].argmax(-1)
    p1, c1 = head_conf("e1_after_c1", dev["f1"]); p2, c2 = head_conf("e2_after_c2", dev["f2"])
    rows = []
    for tau in GRID:
        ex1 = c1 >= tau; ex2 = ~ex1 & (c2 >= tau)
        pred = np.where(ex1, p1, np.where(ex2, p2, full_pred))
        rows.append({"tau": tau, "agreementWithFull": float((pred == full_pred).mean()), "exit1Frac": float(ex1.mean()),
                     "exit2Frac": float(ex2.mean()), "fullFrac": float((~ex1 & ~ex2).mean()),
                     "avgLayers": float((2 * ex1 + 4 * ex2 + 6 * (~ex1 & ~ex2)).mean())})
    chosen = next((r for r in rows if r["agreementWithFull"] >= AGREE_TARGET), rows[-1])
    out = {"split": "dev (last 2,000 of the 20,000-sentence training sample; seed 0)", "rule": f"smallest τ with agreementWithFull ≥ {AGREE_TARGET}",
           "chosen": chosen, "grid": rows, "note": "features from the fp32 PyTorch backbone; WASM/int8 behaviour is measured separately in the browser"}
    (ROOT / "models/heads/early_exit_policy.json").write_text(json.dumps(out, indent=2))
    for r in rows: print(r)
    print("CHOSEN", chosen)

if __name__ == "__main__":
    main()
