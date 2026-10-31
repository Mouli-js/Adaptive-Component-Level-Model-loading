// Chain + tensor-helper tests (Node, onnxruntime-web WASM kernels). Run: npm test
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import * as ort from 'onnxruntime-web';
import { WordPieceTokenizer } from '../src/tokenizer/wordpiece.js';
import { ChainRunner } from '../src/chunks/chainRunner.js';
import { loadManifest, precisionPlan, chunkEntry } from '../src/manifest.js';
import { fromOrt, transferList, sliceBatch } from '../src/tensors.js';
import { feedsFor } from '../src/chunks/chain.js';

const root = new URL('../../../', import.meta.url);
const has = p => fs.existsSync(new URL(p, root));
const fileFetch = async u => { const b = fs.readFileSync(new URL(u)); return { ok: true, json: async () => JSON.parse(b), arrayBuffer: async () => b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) }; };
const needModels = { skip: !(has('models/onnx/int8/c0_embed.onnx') && has('data/sst2/wasm_chain_int8_logits.json')) && 'models/fixtures not generated' };
ort.env.wasm.numThreads = 1;

test('precisionPlan: string and per-chunk overrides', async () => {
  const m = await loadManifest(new URL('models/onnx/manifest.json', root).href, fileFetch);
  assert.deepEqual(Object.values(precisionPlan(m, 'fp32')), ['fp32', 'fp32', 'fp32', 'fp32']);
  assert.deepEqual(precisionPlan(m, { c2_l2_3: 'fp32' }), { c0_embed: 'int8', c1_l0_1: 'int8', c2_l2_3: 'fp32', c3_l4_5_cls: 'int8' });
  assert.match(chunkEntry(m, 'c1_l0_1', 'int8').url, /models\/onnx\/int8\/c1_l0_1\.onnx$/);
  assert.throws(() => chunkEntry(m, 'nope', 'int8'));
});

test('feedsFor follows the chaining rule', () => {
  const s = { input_ids: 'I', attention_mask: 'M', hidden: 'H' };
  assert.deepEqual(feedsFor('c0_embed', 0, s), { input_ids: 'I' });
  assert.deepEqual(feedsFor('c2_l2_3', 2, s), { hidden_in: 'H', attention_mask: 'M' });
});

test('tensor helpers: fromOrt copies views, transferList, sliceBatch', () => {
  const backing = new Float32Array(10);
  const view = { type: 'float32', data: backing.subarray(2, 6), dims: [2, 2] };
  const t = fromOrt(view);
  assert.equal(t.data.byteLength, t.data.buffer.byteLength);       // standalone buffer -> transferable
  assert.notEqual(t.data.buffer, backing.buffer);
  assert.equal(transferList({ a: t })[0], t.data.buffer);
  const s = sliceBatch({ type: 'float32', data: Float32Array.from([1, 2, 3, 4, 5, 6]), dims: [3, 2] }, 1, 3);
  assert.deepEqual([...s.data], [3, 4, 5, 6]); assert.deepEqual(s.dims, [2, 2]);
});

test('int8 chain (first 30 sentences) is bit-identical to the WASM reference', needModels, async () => {
  const m = await loadManifest(new URL('models/onnx/manifest.json', root).href, fileFetch);
  const tok = WordPieceTokenizer.fromVocabText(fs.readFileSync(new URL('models/onnx/vocab.txt', root), 'utf8'));
  const rows = JSON.parse(fs.readFileSync(new URL('data/sst2/validation.json', root))).slice(0, 30);
  const ref = JSON.parse(fs.readFileSync(new URL('data/sst2/wasm_chain_int8_logits.json', root)));
  const r = new ChainRunner(ort, m, { precision: 'int8', fetchImpl: fileFetch });
  const stats = await r.load();
  assert.equal(stats.length, 4);
  for (let i = 0; i < rows.length; i++) {
    const { logits: [lg] } = await r.classify(tok, [rows[i].sentence]);
    assert.deepEqual(lg, ref[i], `sentence ${i}`);
  }
  await r.release();
});
