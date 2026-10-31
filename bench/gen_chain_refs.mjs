/**
 * Phase 3 — run the 4-chunk chain with onnxruntime-web's WASM kernels in Node and compare it
 * with the full model. Produces per-sentence references for the browser tests:
 *   data/sst2/wasm_chain_<precision>_logits.json
 * Usage: node bench/gen_chain_refs.mjs fp32|int8
 */
import fs from 'node:fs';
import * as ort from 'onnxruntime-web';
import { WordPieceTokenizer } from '../packages/adaptive-onnx-loader/src/tokenizer/wordpiece.js';
import { ChainRunner } from '../packages/adaptive-onnx-loader/src/chunks/chainRunner.js';
import { loadManifest } from '../packages/adaptive-onnx-loader/src/manifest.js';

const R = new URL('../', import.meta.url);
const precision = process.argv[2] || 'int8';
// named mixed plans (Phase 5): 'mixedC2' = C2 fp32, everything else int8 (I-1.1)
const PLANS = { mixedC2: { c0_embed: 'int8', c1_l0_1: 'int8', c2_l2_3: 'fp32', c3_l4_5_cls: 'int8' } };
const spec = PLANS[precision] ?? precision;
ort.env.wasm.numThreads = 1;
// Node's fetch can't read file:// URLs, so give the runtime a tiny file-backed fetch.
const fileFetch = async u => { const b = fs.readFileSync(new URL(u)); return { ok: true, json: async () => JSON.parse(b), arrayBuffer: async () => b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) }; };
const manifest = await loadManifest(new URL('models/onnx/manifest.json', R).href, fileFetch);
const tok = WordPieceTokenizer.fromVocabText(fs.readFileSync(new URL('models/onnx/vocab.txt', R), 'utf8'));
const rows = JSON.parse(fs.readFileSync(new URL('data/sst2/validation.json', R)));
const read = p => JSON.parse(fs.readFileSync(new URL(p, R)));
const fullRef = precision === 'fp32' ? read('data/sst2/py_logits.json') : read('data/sst2/wasm_int8_logits_all.json');   // mixed: compared with full int8

const runner = new ChainRunner(ort, manifest, { precision: spec, fetchImpl: fileFetch });
await runner.load();

const out = []; let maxDiff = 0, agree = 0, correct = 0; const t0 = Date.now();
for (let i = 0; i < rows.length; i++) {
  const { logits: [lg] } = await runner.classify(tok, [rows[i].sentence]);
  out.push(lg);
  maxDiff = Math.max(maxDiff, Math.abs(lg[0] - fullRef[i][0]), Math.abs(lg[1] - fullRef[i][1]));
  agree += (lg[1] > lg[0]) === (fullRef[i][1] > fullRef[i][0]);
  correct += (lg[1] > lg[0]) === (rows[i].label === 1);
}
await runner.release();
fs.writeFileSync(new URL(`data/sst2/wasm_chain_${precision}_logits.json`, R), JSON.stringify(out));
const rep = { precision, n: rows.length, accuracy: correct / rows.length,
  plan: spec, comparedWith: precision === 'fp32' ? 'pytorch-fp32 full model' : 'onnxruntime-web WASM full int8 model',
  maxAbsLogitDiff: maxDiff, predictionAgreement: agree / rows.length, seconds: (Date.now() - t0) / 1000 };
fs.mkdirSync(new URL('results/phase3/', R), { recursive: true });
fs.writeFileSync(new URL(`results/phase3/node_chain_${precision}.json`, R), JSON.stringify(rep, null, 2));
console.log(JSON.stringify(rep));
