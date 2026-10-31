"""
Chunk definitions.

A DistilBERT-for-sequence-classification forward pass is
    input_ids -> Embeddings -> 6 x TransformerBlock -> CLS token -> pre_classifier -> ReLU -> classifier
We cut it at layer-group boundaries. Every chunk is a plain nn.Module whose
inputs/outputs are tensors only, so each one exports to a standalone ONNX graph.

The tensor that crosses every boundary is `hidden` : float32 [batch, seq, 768].
`attention_mask` : int64 [batch, seq] (1 = real token, 0 = padding) is passed to
every layer chunk, because each attention layer needs it to ignore padding.
"""
from __future__ import annotations
import torch
from torch import nn

# name -> which transformer layers it owns (None = not a layer group)
CHUNK_SPEC = {
    "c0_embed":  {"layers": None,   "kind": "embed"},
    "c1_l0_1":   {"layers": (0, 2), "kind": "layers"},
    "c2_l2_3":   {"layers": (2, 4), "kind": "layers"},
    "c3_l4_5_cls": {"layers": (4, 6), "kind": "classifier"},
}
# early-exit heads attach after these chunks
EXIT_POINTS = {"e1_after_c1": "c1_l0_1", "e2_after_c2": "c2_l2_3"}


class EmbeddingChunk(nn.Module):
    """C0: word + position embeddings + LayerNorm.  input_ids[B,S] -> hidden[B,S,768]"""
    def __init__(self, embeddings: nn.Module):
        super().__init__()
        self.embeddings = embeddings

    def forward(self, input_ids: torch.Tensor) -> torch.Tensor:
        return self.embeddings(input_ids)


class LayerGroupChunk(nn.Module):
    """C1/C2: a contiguous slice of TransformerBlocks. (hidden, mask) -> hidden"""
    def __init__(self, blocks: list[nn.Module]):
        super().__init__()
        self.blocks = nn.ModuleList(blocks)

    def forward(self, hidden: torch.Tensor, attention_mask: torch.Tensor) -> torch.Tensor:
        for blk in self.blocks:
            # eager attention expects a 2-D [B,S] mask and expands it internally
            hidden = blk(x=hidden, attn_mask=attention_mask)[-1]
        return hidden


class ClassifierChunk(nn.Module):
    """C3: last layers + classification head. (hidden, mask) -> logits[B,2]"""
    def __init__(self, blocks, pre_classifier: nn.Linear, classifier: nn.Linear):
        super().__init__()
        self.layers = LayerGroupChunk(blocks)
        self.pre_classifier = pre_classifier
        self.classifier = classifier

    def forward(self, hidden: torch.Tensor, attention_mask: torch.Tensor) -> torch.Tensor:
        hidden = self.layers(hidden, attention_mask)
        cls = hidden[:, 0]                       # [CLS] token representation
        return self.classifier(torch.relu(self.pre_classifier(cls)))


class ExitHead(nn.Module):
    """Small classifier on an intermediate [CLS] vector. hidden[B,S,768] -> logits[B,2].
    Same shape as the original head so it can be initialised from it."""
    def __init__(self, dim: int = 768, num_labels: int = 2):
        super().__init__()
        self.pre_classifier = nn.Linear(dim, dim)
        self.classifier = nn.Linear(dim, num_labels)

    def forward(self, hidden: torch.Tensor) -> torch.Tensor:
        return self.classifier(torch.relu(self.pre_classifier(hidden[:, 0])))


def build_chunks(model) -> dict[str, nn.Module]:
    """Wrap (not copy) the sub-modules of a loaded DistilBertForSequenceClassification."""
    db = model.distilbert
    layers = list(db.transformer.layer)
    assert len(layers) == 6, f"expected 6 layers, got {len(layers)}"
    out = {}
    for name, spec in CHUNK_SPEC.items():
        if spec["kind"] == "embed":
            out[name] = EmbeddingChunk(db.embeddings)
        elif spec["kind"] == "layers":
            a, b = spec["layers"]; out[name] = LayerGroupChunk(layers[a:b])
        else:
            a, b = spec["layers"]
            out[name] = ClassifierChunk(layers[a:b], model.pre_classifier, model.classifier)
    for m in out.values():
        m.eval()
    return out


@torch.no_grad()
def run_chain(chunks, input_ids, attention_mask, return_hidden=False):
    """Reference implementation of the chained forward pass (what the browser will do)."""
    h0 = chunks["c0_embed"](input_ids)
    h1 = chunks["c1_l0_1"](h0, attention_mask)
    h2 = chunks["c2_l2_3"](h1, attention_mask)
    logits = chunks["c3_l4_5_cls"](h2, attention_mask)
    return (logits, {"h0": h0, "h1": h1, "h2": h2}) if return_hidden else logits
