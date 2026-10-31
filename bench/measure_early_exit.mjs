/**
 * Phase 5 — early-exit accuracy in the WASM engine (Node), τ from models/heads/early_exit_policy.json
 * (tuned on the dev split). For each precision plan: SST-2 validation accuracy, exit fractions,
 * agreement with the same plan without early exit. Per-sentence results become the browser references.
 * Usage: node bench/measure_early_exit.mjs fp32|int8|mixedC2
 */
import fs from 'node:fs';
import * as ort from 'onnxruntime-web';
import { WordPieceTokenizer } from '../packages/adaptive-onnx-loader/src/tokenizer/wordpiece.js';
import { ChunkSession } from '../packages/adaptive-onnx-loader/src/chunks/chunkSession.js';
import { loadManifest, chunkEntry } from '../packages/adaptive-onnx-loader/src/manifest.js';
import { encodeToTensors } from '../packages/adaptive-onnx-loader/src/chunks/chain.js';
import { PRECISION_PLANS } from '../packages/adaptive-onnx-loader/src/engine/measurements.js';

const R = new URL('../', import.meta.url);
const name = process.argv[2] || 'int8', plan = PRECISION_PLANS[name];
ort.env.wasm.numThreads = 1;
const fileFetch = async u => { const b = fs.readFileSync(new URL(u)); return { ok: true, json: async () => JSON.parse(b), arrayBuffer: async () => b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) }; };
const read = p => JSON.parse(fs.readFileSync(new URL(p, R)));
const manifest = await loadManifest(new URL('models/onnx/manifest.json', R).href, fileFetch);
const tau = read('models/heads/early_exit_policy.json').chosen.tau;
const tok = WordPieceTokenizer.fromVocabText(fs.readFileSync(new URL('models/onnx/vocab.txt', R), 'utf8'));
const rows = read('data/sst2/validation.json');
const noExitRef = read(`data/sst2/wasm_chain_${name}_logits.json`);
const S = {};
for (const n of manifest.chain) S[n] = await ChunkSession.create(ort, chunkEntry(manifest, n, plan[n]), { fetchImpl: fileFetch });
for (const n of ['e1_after_c1', 'e2_after_c2']) S[n] = await ChunkSession.create(ort, chunkEntry(manifest, n, 'fp32'), { fetchImpl: fileFetch });
const conf = lg => { const [a, b] = lg, m = Math.max(a, b), ea = Math.exp(a - m), eb = Math.exp(b - m); return Math.max(ea, eb) / (ea + eb); };
const out = []; let correct = 0, agree = 0, e1 = 0, e2 = 0;
for (let i = 0; i < rows.length; i++) {
  const enc = encodeToTensors(tok, [rows[i].sentence]), mask = enc.attention_mask;
  const h0 = (await S.c0_embed.run({ input_ids: enc.input_ids })).hidden;
  const h1 = (await S.c1_l0_1.run({ hidden_in: h0, attention_mask: mask })).hidden;
  let lg = Array.from((await S.e1_after_c1.run({ hidden_in: h1 })).logits.data), at = 'e1';
  if (conf(lg) < tau) {
    const h2 = (await S.c2_l2_3.run({ hidden_in: h1, attention_mask: mask })).hidden;
    lg = Array.from((await S.e2_after_c2.run({ hidden_in: h2 })).logits.data); at = 'e2';
    if (conf(lg) < tau) { lg = Array.from((await S.c3_l4_5_cls.run({ hidden_in: h2, attention_mask: mask })).logits.data); at = 'full'; }
  }
  e1 += at === 'e1'; e2 += at === 'e2';
  out.push({ logits: lg, exitAt: at });
  correct += (lg[1] > lg[0]) === (rows[i].label === 1);
  agree += (lg[1] > lg[0]) === (noExitRef[i][1] > noExitRef[i][0]);
}
const n = rows.length;
const rep = { precision: name, plan, tau, n, accuracy: correct / n, accuracyWithoutEarlyExit: null,
              agreementWithNoExit: agree / n, exit1Frac: e1 / n, exit2Frac: e2 / n, fullFrac: (n - e1 - e2) / n,
              note: 'τ tuned on the dev split; this is the SST-2 validation set (evaluation only)' };
rep.accuracyWithoutEarlyExit = noExitRef.filter((l, i) => (l[1] > l[0]) === (rows[i].label === 1)).length / n;
fs.writeFileSync(new URL(`data/sst2/wasm_ee_${name}.json`, R), JSON.stringify(out));
const f = new URL('results/phase5/early_exit_wasm.json', R);
const all = fs.existsSync(f) ? JSON.parse(fs.readFileSync(f)) : {}; all[name] = rep;
fs.writeFileSync(f, JSON.stringify(all, null, 2));
console.log(JSON.stringify(rep));
