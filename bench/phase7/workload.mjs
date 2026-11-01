/** Fixed length-representative 100-sentence workload (M4): validation indices at evenly spaced
 *  quantiles of token length (ties broken by index). Written once; every experiment reuses it. */
import fs from 'node:fs';
import { WordPieceTokenizer } from '../../packages/adaptive-onnx-loader/src/tokenizer/wordpiece.js';
const R = new URL('../../', import.meta.url);
const tok = WordPieceTokenizer.fromVocabText(fs.readFileSync(new URL('models/onnx/vocab.txt', R), 'utf8'), { maxLength: 128 });
const rows = JSON.parse(fs.readFileSync(new URL('data/sst2/validation.json', R)));
const len = rows.map(r => tok.encodeBatch([r.sentence]).dims[1]);
const order = rows.map((_, i) => i).sort((a, b) => len[a] - len[b] || a - b);
const pick = n => [...Array(n).keys()].map(k => order[Math.floor((k + 0.5) * order.length / n)]);
const w100 = pick(100), pilot20 = w100.filter((_, k) => k % 5 === 2);
const stat = ids => { const l = ids.map(i => len[i]).sort((a, b) => a - b); return { n: ids.length, meanTokens: +(l.reduce((s, x) => s + x, 0) / l.length).toFixed(1), median: l[l.length >> 1], min: l[0], max: l.at(-1) }; };
const out = { rule: 'evenly spaced quantiles of token length over the 872 validation sentences', w100, pilot20,
              stats: { validation: stat(order), w100: stat(w100), pilot20: stat(pilot20) } };
fs.mkdirSync(new URL('results/phase7/', R), { recursive: true });
fs.writeFileSync(new URL('results/phase7/workload_100.json', R), JSON.stringify(out, null, 1));
console.log(JSON.stringify(out.stats));
