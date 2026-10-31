// Tokenizer parity test: JS WordPiece vs Python BertTokenizerFast. Run: node --test test/
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { WordPieceTokenizer } from '../src/tokenizer/wordpiece.js';

const root = new URL('../../../', import.meta.url);
const read = p => fs.readFileSync(new URL(p, root), 'utf8');
const tok = WordPieceTokenizer.fromVocabText(read('models/onnx/vocab.txt'));

test('vocab loads with the expected size and special ids', () => {
  assert.equal(tok.idToToken.length, 30522);
  assert.deepEqual(['[PAD]', '[UNK]', '[CLS]', '[SEP]'].map(t => tok.vocab.get(t)), [0, 100, 101, 102]);
});

test('edge cases match Python exactly', () => {
  const cases = JSON.parse(read('packages/adaptive-onnx-loader/test/fixtures/tokenizer_edge_cases.json'));
  const fails = cases.filter(c => JSON.stringify(tok.encode(c.text)) !== JSON.stringify(c.ids));
  for (const f of fails) console.log('MISMATCH', JSON.stringify(f.text.slice(0, 40)),
    '\n  py:', tok.decode(f.ids).join(' '), '\n  js:', tok.decode(tok.encode(f.text)).join(' '));
  assert.equal(fails.length, 0, `${fails.length}/${cases.length} edge cases differ`);
});

test('all 872 SST-2 validation sentences match Python exactly', { skip: !fs.existsSync(new URL('data/sst2/py_token_ids.json', root)) }, () => {
  const rows = JSON.parse(read('data/sst2/validation.json'));
  const ref = JSON.parse(read('data/sst2/py_token_ids.json'));
  let bad = 0;
  rows.forEach((r, i) => { if (JSON.stringify(tok.encode(r.sentence)) !== JSON.stringify(ref[i])) bad++; });
  assert.equal(bad, 0, `${bad}/872 sentences differ`);
});

test('encodeBatch pads to the longest sequence and builds the mask', () => {
  const b = tok.encodeBatch(['good', 'a really long sentence here']);
  const seq = b.dims[1];
  assert.equal(seq, Math.max(...b.lengths));
  assert.equal(b.inputIds.length, 2 * seq);
  assert.equal(b.attentionMask.slice(0, seq).reduce((a, x) => a + Number(x), 0), b.lengths[0]);
  assert.equal(b.inputIds[seq - 1], 0n); // padded with [PAD]
});
