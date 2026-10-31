"""
Phase 1 / step 1 — split DistilBERT into 4 chunks and prove (in PyTorch) that
chaining the chunks reproduces the original model exactly.

Usage:  python split_model.py [--random]   (--random = untrained weights, smoke test)
Writes: ../results/phase1/split_check.json
"""
import argparse, json, time
from pathlib import Path
import pandas as pd, torch
from adaptive_split import build_chunks, run_chain, load_model, load_tokenizer
from adaptive_split.load import ROOT

def param_count(m): return sum(p.numel() for p in m.parameters())

def main():
    ap = argparse.ArgumentParser(); ap.add_argument("--random", action="store_true")
    args = ap.parse_args()
    model = load_model(random=args.random); tok = load_tokenizer()
    chunks = build_chunks(model)

    val = pd.read_parquet(ROOT / "data/sst2/validation.parquet")
    sents, labels = val.sentence.tolist(), torch.tensor(val.label.values)

    max_diff, preds_full, preds_chain, t_full, t_chain = 0.0, [], [], 0.0, 0.0
    with torch.no_grad():
        for i in range(0, len(sents), 32):
            enc = tok(sents[i:i+32], padding=True, truncation=True, max_length=128, return_tensors="pt")
            t = time.perf_counter(); ref = model(**enc).logits; t_full += time.perf_counter() - t
            t = time.perf_counter(); out = run_chain(chunks, enc["input_ids"], enc["attention_mask"]); t_chain += time.perf_counter() - t
            max_diff = max(max_diff, (ref - out).abs().max().item())
            preds_full.append(ref.argmax(-1)); preds_chain.append(out.argmax(-1))
    pf, pc = torch.cat(preds_full), torch.cat(preds_chain)
    report = {
        "weights": "random" if args.random else "distilbert-base-uncased-finetuned-sst-2-english",
        "n_sentences": len(sents),
        "max_abs_logit_diff_full_vs_chain": max_diff,
        "prediction_agreement": float((pf == pc).float().mean()),
        "accuracy_full": float((pf == labels).float().mean()),
        "accuracy_chain": float((pc == labels).float().mean()),
        "time_full_s": round(t_full, 2), "time_chain_s": round(t_chain, 2),
        "params": {k: param_count(v) for k, v in chunks.items()},
        "params_total_model": param_count(model),
    }
    report["params_sum_of_chunks"] = sum(report["params"].values())
    report["PASS"] = max_diff < 1e-5 and report["prediction_agreement"] == 1.0
    out = ROOT / "results/phase1"; out.mkdir(parents=True, exist_ok=True)
    (out / ("split_check_random.json" if args.random else "split_check.json")).write_text(json.dumps(report, indent=2))
    print(json.dumps(report, indent=2))

if __name__ == "__main__":
    main()
