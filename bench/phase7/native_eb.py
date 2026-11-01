"""E-B / F-5 native side: Python onnxruntime (CPU execution provider), same .onnx files as the browser.
Usage: python3 bench/phase7/native_eb.py <full|chain> <spec iiii|ffff|iifi|...> <batch> <order|shuffled|sorted> [seed]
Token ids come from data/sst2/py_token_ids.json (the Phase 1 tokenizer output); padding id 0, mask 0.
Shuffle uses the same mulberry32 generator as node_wasm.mjs so both runtimes see identical batches."""
import json, sys, time, hashlib, os, platform
import numpy as np, onnxruntime as ort
R = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', '..')
model, letters, B, comp = sys.argv[1], {'fp32': 'ffff', 'int8': 'iiii', 'mixedC2': 'iifi'}.get(sys.argv[2], sys.argv[2]), int(sys.argv[3]), sys.argv[4]
seed = int(sys.argv[5]) if len(sys.argv) > 5 else 0
ids = json.load(open(f'{R}/data/sst2/py_token_ids.json')); rows = json.load(open(f'{R}/data/sst2/validation.json'))
order = list(range(len(rows)))
def mulberry(seed):
    t = [seed & 0xffffffff]
    def rnd():
        t[0] = (t[0] + 0x6D2B79F5) & 0xffffffff; r = t[0]
        r = ((r ^ (r >> 15)) * (1 | r)) & 0xffffffff
        r = (r ^ (r + (((r ^ (r >> 7)) * (61 | r)) & 0xffffffff))) & 0xffffffff
        return ((r ^ (r >> 14)) & 0xffffffff) / 4294967296
    return rnd
if comp == 'shuffled':
    rnd = mulberry(seed + 1)
    for i in range(len(order) - 1, 0, -1):
        j = int(rnd() * (i + 1)); order[i], order[j] = order[j], order[i]
if comp == 'sorted': order.sort(key=lambda i: (len(ids[i]), i))
so = ort.SessionOptions(); so.intra_op_num_threads = 1; so.inter_op_num_threads = 1
prec = lambda k: 'fp32' if letters[k] == 'f' else 'int8'
CH = ['c0_embed', 'c1_l0_1', 'c2_l2_3', 'c3_l4_5_cls']
if model == 'full':
    sess = [ort.InferenceSession(f'{R}/models/onnx/{"int8" if letters == "iiii" else "fp32"}/full.onnx', so, providers=['CPUExecutionProvider'])]
else:
    sess = [ort.InferenceSession(f'{R}/models/onnx/{prec(k)}/{c}.onnx', so, providers=['CPUExecutionProvider']) for k, c in enumerate(CH)]
logits = [None] * len(rows); t0 = time.time()
for s in range(0, len(order), B):
    b = order[s:s + B]; L = max(len(ids[i]) for i in b)
    x = np.zeros((len(b), L), np.int64); m = np.zeros((len(b), L), np.int64)
    for k, i in enumerate(b): x[k, :len(ids[i])] = ids[i]; m[k, :len(ids[i])] = 1
    if model == 'full': out = sess[0].run(None, {'input_ids': x, 'attention_mask': m})[0]
    else:
        h = sess[0].run(None, {'input_ids': x})[0]
        for se in sess[1:]: h = se.run(None, {'hidden_in': h, 'attention_mask': m})[0]
        out = h
    for k, i in enumerate(b): logits[i] = [float(out[k, 0]), float(out[k, 1])]
sec = time.time() - t0
acc = sum((l[1] > l[0]) == (r['label'] == 1) for l, r in zip(logits, rows)) / len(rows)
h = hashlib.sha256(np.array(logits, np.float32).tobytes()).hexdigest()
res = dict(runtime='onnxruntime native CPU EP (Python)', ortVersion=ort.__version__, cpu=platform.processor() or platform.machine(), model=model, precision=letters, batch=B,
           composition=comp, seed=seed if comp == 'shuffled' else None, n=len(rows), accuracy=acc, logitsHash=h, seconds=sec, logits=logits)
d = f'{R}/results/phase7/{os.environ.get("OUT_DIR", "native")}'; os.makedirs(d, exist_ok=True)
json.dump(res, open(f'{d}/{model}_{letters}_b{B}_{comp}{"_s%d" % seed if comp == "shuffled" else ""}.json', 'w'))
print(json.dumps({k: v for k, v in res.items() if k != 'logits'}))
