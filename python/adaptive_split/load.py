"""Model/tokenizer loading. Works fully offline from a local checkpoint directory.
`random=True` builds an untrained model with the same architecture (used to test the
pipeline before real weights are available)."""
from pathlib import Path
import torch
from transformers import (DistilBertConfig, DistilBertForSequenceClassification,
                          DistilBertTokenizerFast)

ROOT = Path(__file__).resolve().parents[2]
DEFAULT_CKPT = ROOT / "models" / "hf" / "distilbert-sst2"


def load_model(ckpt: Path | str = DEFAULT_CKPT, random: bool = False):
    torch.manual_seed(0)
    if random:
        cfg = DistilBertConfig(num_labels=2)
        cfg._attn_implementation = "eager"
        model = DistilBertForSequenceClassification(cfg)
    else:
        # eager attention: 2-D mask in each block, plain MatMul/Softmax ops in ONNX
        model = DistilBertForSequenceClassification.from_pretrained(
            str(ckpt), attn_implementation="eager", local_files_only=True)
    return model.eval()


def load_tokenizer(ckpt: Path | str = DEFAULT_CKPT):
    return DistilBertTokenizerFast.from_pretrained(str(ckpt), local_files_only=True)
