"""
Phase 1 / step 7 — models/onnx/manifest.json: the contract between the Python build
and the browser runtime. For every artifact: file path, bytes, SHA-256 (integrity check
in the cache layer), graph inputs/outputs (names, dtypes, shapes), and the chaining order.
"""
import hashlib, json
import onnx
from adaptive_split import CHUNK_SPEC, EXIT_POINTS
from adaptive_split.load import ROOT

O = ROOT / "models/onnx"
DT = {1: "float32", 7: "int64"}

def io(vals):
    return [{"name": v.name, "dtype": DT.get(v.type.tensor_type.elem_type, str(v.type.tensor_type.elem_type)),
             "shape": [d.dim_param or d.dim_value for d in v.type.tensor_type.shape.dim]} for v in vals]

def entry(name):
    out = {}
    for prec in ("fp32", "int8"):
        p = O / prec / f"{name}.onnx"; b = p.read_bytes(); g = onnx.load_model_from_string(b).graph
        out[prec] = {"file": f"{prec}/{name}.onnx", "bytes": len(b), "sha256": hashlib.sha256(b).hexdigest(),
                     "inputs": io(g.input), "outputs": io(g.output)}
    return out

def main():
    m = {"model": "distilbert-base-uncased-finetuned-sst-2-english", "task": "sst2-sentiment",
         "labels": ["NEGATIVE", "POSITIVE"], "hidden_size": 768, "max_length": 128, "opset": 17,
         "tokenizer": {"type": "wordpiece", "vocab": "vocab.txt", "lowercase": True,
                       "cls_id": 101, "sep_id": 102, "pad_id": 0, "unk_id": 100},
         "chain": list(CHUNK_SPEC), "baseline": entry("full"),
         "chunks": {n: {"layers": CHUNK_SPEC[n]["layers"], **entry(n)} for n in CHUNK_SPEC},
         "exits": {n: {"after": a, **entry(n)} for n, a in EXIT_POINTS.items()}}
    (O / "manifest.json").write_text(json.dumps(m, indent=2))
    for grp in ("chunks", "exits"):
        for n, e in m[grp].items():
            print(f"{n:14s} fp32 {e['fp32']['bytes']/1e6:6.1f} MB  int8 {e['int8']['bytes']/1e6:5.1f} MB  "
                  f"in={[i['name'] for i in e['fp32']['inputs']]} out={[o['name'] for o in e['fp32']['outputs']]}")
    s = lambda p: sum(e[p]["bytes"] for e in m["chunks"].values())
    print(f"sum chunks fp32 {s('fp32')/1e6:.1f} MB vs full {m['baseline']['fp32']['bytes']/1e6:.1f} MB; "
          f"int8 {s('int8')/1e6:.1f} vs {m['baseline']['int8']['bytes']/1e6:.1f}")

if __name__ == "__main__":
    main()
