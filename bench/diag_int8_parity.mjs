/**
 * Diagnostic: per-sentence int8 logits from onnxruntime-web's WASM kernels (run in Node),
 * to compare against Python onnxruntime (native CPU EP). Writes data/sst2/wasm_int8_logits.json
 * Usage: node bench/diag_int8_parity.mjs [opt=all|disabled]
 */
import fs from 'node:fs';
import * as ort from 'onnxruntime-web';
import { WordPieceTokenizer } from '../packages/adaptive-onnx-loader/src/tokenizer/wordpiece.js';
const R = new URL('../', import.meta.url);
const opt = process.argv[2] || 'all';
ort.env.wasm.numThreads = 1;
const tok = WordPieceTokenizer.fromVocabText(fs.readFileSync(new URL('models/onnx/vocab.txt', R), 'utf8'));
const rows = JSON.parse(fs.readFileSync(new URL('data/sst2/validation.json', R)));
const s = await ort.InferenceSession.create(fs.readFileSync(new URL('models/onnx/int8/full.onnx', R)),
  { executionProviders: ['wasm'], graphOptimizationLevel: opt });
const out = [];
for (const r of rows) {
  const e = tok.encodeBatch([r.sentence]);
  const lg = (await s.run({ input_ids: new ort.Tensor('int64', e.inputIds, e.dims),
                            attention_mask: new ort.Tensor('int64', e.attentionMask, e.dims) })).logits.data;
  out.push([lg[0], lg[1]]);
}
fs.writeFileSync(new URL(`data/sst2/wasm_int8_logits_${opt}.json`, R), JSON.stringify(out));
const acc = out.filter((l, i) => (l[1] > l[0]) === (rows[i].label === 1)).length / rows.length;
console.log(`wasm int8 (${opt}) acc ${(acc * 100).toFixed(2)}%`);
