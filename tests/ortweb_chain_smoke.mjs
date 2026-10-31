import * as ort from 'onnxruntime-web';
import fs from 'fs';
ort.env.wasm.numThreads = 1;
const D = new URL('../models/onnx/', import.meta.url).pathname.replace(/%20/g,' ');
const ids = new ort.Tensor('int64', BigInt64Array.from([101n,1045n,2293n,2023n,3185n,102n]), [1,6]);
const mask = new ort.Tensor('int64', BigInt64Array.from([1n,1n,1n,1n,1n,1n]), [1,6]);
for (const prec of ['fp32','int8']) {
  const t0 = performance.now(); let h; const names = ['c0_embed','c1_l0_1','c2_l2_3','c3_l4_5_cls']; let logits;
  for (const n of names) {
    const s = await ort.InferenceSession.create(fs.readFileSync(D + prec + '/' + n + '.onnx'), {executionProviders:['wasm']});
    const feeds = n === 'c0_embed' ? {input_ids: ids} : {hidden_in: h, attention_mask: mask};
    const out = await s.run(feeds); h = out.hidden; logits = out.logits; await s.release();
  }
  console.log(prec, 'logits', Array.from(logits.data).map(x=>x.toFixed(4)), (performance.now()-t0).toFixed(0)+'ms');
}
const full = await ort.InferenceSession.create(fs.readFileSync(D+'fp32/full.onnx'));
console.log('full fp32', Array.from((await full.run({input_ids: ids, attention_mask: mask})).logits.data).map(x=>x.toFixed(4)));
