"""
Phase 1 / step 2 — export the full model (baseline) and the 4 chunks to ONNX (fp32).

Each chunk becomes a self-contained graph with its own copy of only the weights it
uses, so the browser can download/instantiate it independently.
Dynamic axes: batch and sequence length can vary at runtime.
Writes: ../models/onnx/fp32/{full,c0_embed,c1_l0_1,c2_l2_3,c3_l4_5_cls}.onnx
"""
import torch
from torch import nn
from adaptive_split import build_chunks, load_model
from adaptive_split.load import ROOT

OPSET = 17
OUT = ROOT / "models/onnx/fp32"

class FullModel(nn.Module):           # unwrap HF output object -> plain logits tensor
    def __init__(self, m): super().__init__(); self.m = m
    def forward(self, input_ids, attention_mask):
        return self.m(input_ids=input_ids, attention_mask=attention_mask).logits

def export(module, args, in_names, out_names, path):
    dyn = {n: {0: "batch", 1: "seq"} for n in in_names + out_names}
    if "logits" in out_names: dyn["logits"] = {0: "batch"}
    torch.onnx.export(module, args, str(path), input_names=in_names, output_names=out_names,
                      dynamic_axes=dyn, opset_version=OPSET, do_constant_folding=True)
    print(f"  {path.name:22s} {path.stat().st_size/1e6:7.1f} MB")

def main():
    OUT.mkdir(parents=True, exist_ok=True)
    model = load_model(); chunks = build_chunks(model)
    ids = torch.tensor([[101, 2023, 3185, 2003, 2307, 102, 0, 0]] * 2)
    mask = (ids != 0).long()
    h = torch.randn(2, 8, 768)
    with torch.no_grad():
        export(FullModel(model), (ids, mask), ["input_ids", "attention_mask"], ["logits"], OUT / "full.onnx")
        export(chunks["c0_embed"], (ids,), ["input_ids"], ["hidden"], OUT / "c0_embed.onnx")
        for n in ("c1_l0_1", "c2_l2_3"):
            export(chunks[n], (h, mask), ["hidden_in", "attention_mask"], ["hidden"], OUT / f"{n}.onnx")
        export(chunks["c3_l4_5_cls"], (h, mask), ["hidden_in", "attention_mask"], ["logits"], OUT / "c3_l4_5_cls.onnx")

if __name__ == "__main__":
    main()
