/** Phase 6 — bundle early-exit metadata WITH the model artifacts (next to manifest.json), so the
 *  library never reads project-specific result files. Inputs: τ (dev-tuned) + measured WASM table. */
import fs from 'node:fs';
const R = new URL('../', import.meta.url);
const policy = JSON.parse(fs.readFileSync(new URL('models/heads/early_exit_policy.json', R)));
const table = JSON.parse(fs.readFileSync(new URL('results/phase5/early_exit_wasm.json', R)));
const out = { tau: policy.chosen.tau, tunedOn: policy.split, rule: policy.rule, heads: { after_c1_l0_1: 'e1_after_c1', after_c2_l2_3: 'e2_after_c2' }, headPrecision: 'fp32',
  plans: Object.fromEntries(Object.entries(table).map(([k, v]) => [k, { accuracy: v.accuracy, accuracyWithoutEarlyExit: v.accuracyWithoutEarlyExit,
    exit1Frac: v.exit1Frac, exit2Frac: v.exit2Frac, fullFrac: v.fullFrac, measuredOn: 'SST-2 validation (872), onnxruntime-web WASM' }])) };
fs.writeFileSync(new URL('models/onnx/early_exit.json', R), JSON.stringify(out, null, 2));
console.log(JSON.stringify(out).slice(0, 300));
