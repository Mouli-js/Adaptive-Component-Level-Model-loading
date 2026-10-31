"""Phase 1 / step 5 — export trained exit heads to ONNX (fp32 + int8). hidden[B,S,768] -> logits[B,2]"""
import os, shutil, tempfile
from pathlib import Path
import torch
from onnxruntime.quantization import quantize_dynamic, QuantType
from adaptive_split import ExitHead, EXIT_POINTS
from adaptive_split.load import ROOT

SCRATCH = Path(os.environ.get("QUANT_SCRATCH", tempfile.gettempdir())) / "adaptive_quant"

def main():
    SCRATCH.mkdir(parents=True, exist_ok=True)
    for name in EXIT_POINTS:
        head = ExitHead(); head.load_state_dict(torch.load(ROOT / f"models/heads/{name}.pt")); head.eval()
        fp32 = ROOT / f"models/onnx/fp32/{name}.onnx"
        with torch.no_grad():
            torch.onnx.export(head, (torch.randn(2, 8, 768),), str(fp32), input_names=["hidden_in"],
                              output_names=["logits"], opset_version=17,
                              dynamic_axes={"hidden_in": {0: "batch", 1: "seq"}, "logits": {0: "batch"}})
        src, tmp = SCRATCH / fp32.name, SCRATCH / ("q_" + fp32.name)
        shutil.copy(fp32, src)
        quantize_dynamic(str(src), str(tmp), weight_type=QuantType.QInt8, op_types_to_quantize=["MatMul", "Gemm"])
        shutil.copy(tmp, ROOT / f"models/onnx/int8/{name}.onnx"); src.unlink(); tmp.unlink()
        print(name, f"{fp32.stat().st_size/1e6:.2f} MB fp32 ->",
              f"{(ROOT / f'models/onnx/int8/{name}.onnx').stat().st_size/1e6:.2f} MB int8")

if __name__ == "__main__":
    main()
