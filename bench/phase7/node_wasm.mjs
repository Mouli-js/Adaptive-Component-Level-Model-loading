/**
 * E4 / E-B / F-5 — onnxruntime-web WASM kernels in Node (same kernels as the browser, F-5/F-20).
 * Usage: node bench/phase7/node_wasm.mjs <model> <precision> <batch> <composition> [seed]
 *   model: full | chain;  precision: fp32 | int8 | mixedC2 | 4-letter spec over c0..c3, e.g. "iifi" (i=int8, f=fp32)
 *   composition: order | shuffled | sorted   (sorted = by token length, minimal padding)
 * Writes results/phase7/<OUT_DIR|wasm>/<model>_<precision>_b<batch>_<composition>[_s<seed>].json
 */
import fs from 'node:fs';
import * as ort from 'onnxruntime-web';
import { WordPieceTokenizer } from '../../packages/adaptive-onnx-loader/src/tokenizer/wordpiece.js';
import { ChainRunner } from '../../packages/adaptive-onnx-loader/src/chunks/chainRunner.js';
import { FullModelRunner } from '../../packages/adaptive-onnx-loader/src/baseline/fullModel.js';
import { loadManifest } from '../../packages/adaptive-onnx-loader/src/manifest.js';
import { createHash } from 'node:crypto';

const R = new URL('../../', import.meta.url);
const [model = 'chain', precision = 'int8', batchS = '1', composition = 'order', seedS = '0'] = process.argv.slice(2);
const B = Number(batchS), seed = Number(seedS);
const NAMED = { fp32: 'ffff', int8: 'iiii', mixedC2: 'iifi' };
const letters = NAMED[precision] ?? precision;
const CH = ['c0_embed', 'c1_l0_1', 'c2_l2_3', 'c3_l4_5_cls'];
const spec = Object.fromEntries(CH.map((c, k) => [c, letters[k] === 'f' ? 'fp32' : 'int8']));
ort.env.wasm.numThreads = 1;
const fileFetch = async u => { const b = fs.readFileSync(new URL(u)); return { ok: true, json: async () => JSON.parse(b), arrayBuffer: async () => b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) }; };
const manifest = await loadManifest(new URL('models/onnx/manifest.json', R).href, fileFetch);
const tok = WordPieceTokenizer.fromVocabText(fs.readFileSync(new URL('models/onnx/vocab.txt', R), 'utf8'), { maxLength: 128 });
const rows = JSON.parse(fs.readFileSync(new URL('data/sst2/validation.json', R)));
let order = rows.map((_, i) => i);
if (composition === 'shuffled') { let t = seed + 1; const rnd = () => { t += 0x6D2B79F5; let r = Math.imul(t ^ t >>> 15, 1 | t); r ^= r + Math.imul(r ^ r >>> 7, 61 | r); return ((r ^ r >>> 14) >>> 0) / 4294967296; };
  for (let i = order.length - 1; i > 0; i--) { const j = Math.floor(rnd() * (i + 1)); [order[i], order[j]] = [order[j], order[i]]; } }
if (composition === 'sorted') { const len = rows.map(r => tok.encodeBatch([r.sentence]).dims[1]); order.sort((a, b) => len[a] - len[b] || a - b); }

let runner;
if (model === 'full') {
  if (letters !== 'iiii' && letters !== 'ffff') throw new Error('full model exists only for fp32 / int8');
  runner = await FullModelRunner.create(ort, new URL(`models/onnx/${letters === 'iiii' ? 'int8' : 'fp32'}/full.onnx`, R).href, { fetchImpl: fileFetch });
} else { runner = new ChainRunner(ort, manifest, { precision: spec, fetchImpl: fileFetch }); await runner.load(); }

const logits = new Array(rows.length); const t0 = Date.now();
for (let s = 0; s < order.length; s += B) {
  const ids = order.slice(s, s + B);
  const { logits: lg } = await runner.classify(tok, ids.map(i => rows[i].sentence));
  ids.forEach((i, k) => { logits[i] = lg[k]; });
}
const seconds = (Date.now() - t0) / 1000; await runner.release();
const correct = logits.reduce((a, l, i) => a + ((l[1] > l[0]) === (rows[i].label === 1)), 0);
const f = new Float32Array(logits.flat());
const out = { runtime: 'onnxruntime-web WASM (Node)', ortVersion: ort.env.versions?.web ?? null, model, precision: letters, batch: B, composition, seed: composition === 'shuffled' ? seed : null,
              n: rows.length, accuracy: correct / rows.length, logitsHash: createHash('sha256').update(Buffer.from(f.buffer)).digest('hex'), seconds, logits };
const dir = new URL(`results/phase7/${process.env.OUT_DIR || 'wasm'}/`, R); fs.mkdirSync(dir, { recursive: true });
fs.writeFileSync(new URL(`${model}_${letters}_b${B}_${composition}${out.seed != null ? '_s' + seed : ''}.json`, dir), JSON.stringify(out));
console.log(JSON.stringify({ ...out, logits: undefined }));
