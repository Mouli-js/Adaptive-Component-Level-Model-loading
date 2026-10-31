"""
Phase 1 / step 4 — train the two early-exit heads (E1 after C1, E2 after C2).

The backbone stays FROZEN (the fine-tuned DistilBERT is untouched). We only learn a
small 2-layer head on the intermediate [CLS] vector, so the cost is:
  1) one pass of C0..C2 over a training subset to cache [CLS] features  (slow part)
  2) a few epochs of training a 768->768->2 MLP on cached features      (seconds)
Heads are initialised from the model's final head (pre_classifier/classifier).
Usage:  python train_exit_heads.py extract | train
"""
import json, os, sys, time
from pathlib import Path
import numpy as np, pandas as pd, torch
from torch import nn
from adaptive_split import build_chunks, load_model, load_tokenizer, ExitHead
from adaptive_split.load import ROOT

N_TRAIN, MAX_LEN, SEED = 20000, 64, 0
CACHE = Path(os.environ.get("FEAT_CACHE", ROOT / "results/phase1/feat_cache"))
HEADS = ROOT / "models/heads"

SHARD = 5000   # sentences per shard: keeps each call short and makes extraction resumable

@torch.no_grad()
def extract():
    """Extract [CLS] features shard by shard; existing shards are skipped (resumable)."""
    CACHE.mkdir(parents=True, exist_ok=True)
    budget = float(os.environ.get("TIME_BUDGET_S", "1e9")); t_start = time.time()
    model = load_model(); tok = load_tokenizer(); ch = build_chunks(model)
    torch.set_num_threads(os.cpu_count())
    for split in ("validation", "train"):
        df = pd.read_parquet(ROOT / f"data/sst2/{split}.parquet")
        if split == "train": df = df.sample(n=N_TRAIN, random_state=SEED)
        for s0 in range(0, len(df), SHARD):
            path = CACHE / f"{split}_{s0:06d}.npz"
            if path.exists(): continue
            if time.time() - t_start > budget: print("BUDGET REACHED, rerun to continue"); return
            part, f1, f2, ff, t0 = df.iloc[s0:s0+SHARD], [], [], [], time.time()
            for i in range(0, len(part), 64):
                enc = tok(part.sentence.iloc[i:i+64].tolist(), padding=True, truncation=True,
                          max_length=MAX_LEN, return_tensors="pt")
                m = enc["attention_mask"]
                h1 = ch["c1_l0_1"](ch["c0_embed"](enc["input_ids"]), m)
                h2 = ch["c2_l2_3"](h1, m)
                f1.append(h1[:, 0].numpy()); f2.append(h2[:, 0].numpy())
                ff.append(ch["c3_l4_5_cls"](h2, m).numpy())
            np.savez(path, f1=np.concatenate(f1), f2=np.concatenate(f2), y=part.label.values, full=np.concatenate(ff))
            print(f"{path.name} {len(part)} sents {time.time()-t0:.0f}s", flush=True)
    print("EXTRACT DONE", flush=True)

def _load(split):
    files = sorted(CACHE.glob(f"{split}_*.npz"))
    parts = [np.load(f) for f in files]
    return {k: np.concatenate([p[k] for p in parts]) for k in ("f1", "f2", "y", "full")}

def train():
    torch.manual_seed(SEED)
    tr, va = _load("train"), _load("validation")
    model = load_model(); HEADS.mkdir(parents=True, exist_ok=True)
    # last 2,000 training sentences = held-out dev split for epoch selection;
    # the SST-2 validation set is used ONLY for the final reported numbers.
    N_DEV = 2000
    yt, yd, yv = torch.tensor(tr["y"][:-N_DEV]), torch.tensor(tr["y"][-N_DEV:]), torch.tensor(va["y"])
    report = {"n_train": int(len(yt)), "n_dev": N_DEV, "n_val": int(len(yv)),
              "full_model_val_acc": float((torch.tensor(va["full"]).argmax(-1) == yv).float().mean())}
    for name, key in (("e1_after_c1", "f1"), ("e2_after_c2", "f2")):
        head = ExitHead()
        head.pre_classifier.load_state_dict(model.pre_classifier.state_dict())
        head.classifier.load_state_dict(model.classifier.state_dict())
        X, Xd, Xv = torch.tensor(tr[key][:-N_DEV]), torch.tensor(tr[key][-N_DEV:]), torch.tensor(va[key])
        pred = lambda Z: head.classifier(torch.relu(head.pre_classifier(Z))).argmax(-1)
        acc0 = float((head.classifier(torch.relu(head.pre_classifier(Xv))).argmax(-1) == yv).float().mean())
        opt = torch.optim.AdamW(head.parameters(), lr=1e-4, weight_decay=0.01)
        lossf, best = nn.CrossEntropyLoss(), (0, None, 0)
        for ep in range(8):
            perm = torch.randperm(len(X))
            for i in range(0, len(X), 128):
                idx = perm[i:i+128]
                logits = head.classifier(torch.relu(head.pre_classifier(nn.functional.dropout(X[idx], 0.1))))
                loss = lossf(logits, yt[idx]); opt.zero_grad(); loss.backward(); opt.step()
            with torch.no_grad():
                acc = float((pred(Xd) == yd).float().mean())
            print(f"{name} epoch {ep} loss {loss.item():.3f} dev_acc {acc:.4f}")
            if acc > best[0]: best = (acc, {k: v.clone() for k, v in head.state_dict().items()}, ep)
        head.load_state_dict(best[1]); torch.save(head.state_dict(), HEADS / f"{name}.pt")
        with torch.no_grad(): val_acc = float((pred(Xv) == yv).float().mean())
        with torch.no_grad(): conf = torch.softmax(head.classifier(torch.relu(head.pre_classifier(Xv))), -1).max(-1).values
        report[name] = {"val_acc_before_training": acc0, "dev_acc": best[0], "val_acc": val_acc, "best_epoch": best[2],
                        "mean_confidence": float(conf.mean())}
    (ROOT / "results/phase1/exit_heads.json").write_text(json.dumps(report, indent=2))
    print(json.dumps(report, indent=2))

if __name__ == "__main__":
    {"extract": extract, "train": train}[sys.argv[1]]()
