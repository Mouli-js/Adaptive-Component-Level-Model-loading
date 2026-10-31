"""
Phase 1 / step 3 — dynamic int8 quantization of every fp32 graph.

Dynamic quantization: weights are stored as int8 (+ one fp32 scale/zero-point per
tensor); activations are quantized on the fly at runtime (DynamicQuantizeLinear ->
MatMulInteger). No calibration data needed. Ops quantized: MatMul (all linear layers)
and Gather (the embedding lookup table).
Writes: ../models/onnx/int8/*.onnx
"""
import os, shutil, tempfile
from pathlib import Path
from onnxruntime.quantization import quantize_dynamic, QuantType
from adaptive_split.load import ROOT

# The quantizer writes and deletes "<name>-inferred.onnx" beside its input. Run it in a
# scratch dir (QUANT_SCRATCH or the system temp dir) and copy only the result back.
SCRATCH = Path(os.environ.get("QUANT_SCRATCH", tempfile.gettempdir())) / "adaptive_quant"

SRC, DST = ROOT / "models/onnx/fp32", ROOT / "models/onnx/int8"

def main():
    DST.mkdir(parents=True, exist_ok=True)
    for f in sorted(SRC.glob("*.onnx")):
        SCRATCH.mkdir(parents=True, exist_ok=True)
        src, tmp_out, out = SCRATCH / f.name, SCRATCH / ("q_" + f.name), DST / f.name
        shutil.copy(f, src)
        quantize_dynamic(str(src), str(tmp_out), weight_type=QuantType.QInt8,
                         op_types_to_quantize=["MatMul", "Gather"],
                         extra_options={"MatMulConstBOnly": True})
        shutil.copy(tmp_out, out); src.unlink(); tmp_out.unlink()
        print(f"  {f.name:22s} {f.stat().st_size/1e6:7.1f} MB -> {out.stat().st_size/1e6:6.1f} MB "
              f"({f.stat().st_size/out.stat().st_size:.2f}x)")

if __name__ == "__main__":
    main()
