import { installWasmMemoryProbe, measureMemory, WordPieceTokenizer, FullModelRunner } from 'adaptive-onnx-loader';
installWasmMemoryProbe();                       // before ORT creates its WASM heap
const ort = await import('onnxruntime-web');
ort.env.wasm.wasmPaths = '/node_modules/onnxruntime-web/dist/';

const $ = id => document.getElementById(id);
const MB = b => (b / 1048576).toFixed(1) + ' MiB';   // 1 MiB = 1,048,576 bytes
$('coi').textContent = crossOriginIsolated ? 'yes' : 'NO (threads + memory API unavailable)';
$('coi').className = 'badge ' + (crossOriginIsolated ? 'ok' : 'bad');

const getJSON = async u => (await fetch(u)).json();
const manifest = await getJSON('/models/onnx/manifest.json');
const tokenizer = WordPieceTokenizer.fromVocabText(await (await fetch('/models/onnx/vocab.txt')).text(),
                                                   { maxLength: manifest.max_length });
let runner = null;

let lockedThreads = null;                       // ORT fixes numThreads when its WASM module starts
async function load(precision, threads, uaMemory = false) {
  if (lockedThreads !== null && threads !== lockedThreads)
    throw new Error(`threads already fixed at ${lockedThreads} for this page; reload the page to change it`);
  ort.env.wasm.numThreads = lockedThreads = threads;
  if (runner) await runner.release();
  const memBefore = await measureMemory({ withUA: uaMemory });
  runner = await FullModelRunner.create(ort, '/models/onnx/' + manifest.baseline[precision].file);
  const memAfter = await measureMemory({ withUA: uaMemory });
  return { precision, threads, ...runner.stats, memBefore, memAfter };
}

const softmax = ([a, b]) => { const m = Math.max(a, b), ea = Math.exp(a - m), eb = Math.exp(b - m); return [ea / (ea + eb), eb / (ea + eb)]; };

/** Full validation run; also used by the Playwright test via window.phase2 */
// uaMemory: also call measureUserAgentSpecificMemory(). Off by default: in a normal Chrome it
// waits for a GC (20-60 s per call, longer with worker threads). The Playwright test turns it on
// and launches Chromium with ForceEagerMeasureMemory.
async function benchmark({ precision = 'int8', threads = 4, limit = Infinity, uaMemory = false, onProgress } = {}) {
  const loadStats = await load(precision, threads, uaMemory);
  const rows = await getJSON('/data/sst2/validation.json');
  const pyIds = await getJSON('/data/sst2/py_token_ids.json');
  const pyLogits = await getJSON('/data/sst2/py_logits.json');                 // PyTorch fp32
  // Same-kernel reference: fp32 -> PyTorch. int8 -> onnxruntime-web WASM kernels run in Node
  // (bench/diag_int8_parity.mjs). Native ORT int8 kernels differ from the WASM ones (see the
  // Phase 2 report), so native int8 is reported for information only, never used as the gate.
  const refLogits = precision === 'int8' ? await getJSON('/data/sst2/wasm_int8_logits_all.json') : pyLogits;
  const nativeInt8 = precision === 'int8' ? await getJSON('/data/sst2/py_ort_int8_logits.json') : null;
  const n = Math.min(limit, rows.length);
  for (let i = 0; i < 3; i++) await runner.classify(tokenizer, [rows[i].sentence]);   // warm-up
  let correct = 0, agree = 0, agreeRef = 0, agreeNative = 0, maxDiff = 0, tokMismatch = 0; const lat = [];
  for (let i = 0; i < n; i++) {
    if (JSON.stringify(tokenizer.encode(rows[i].sentence)) !== JSON.stringify(pyIds[i])) tokMismatch++;
    const { logits: [lg], ms } = await runner.classify(tokenizer, [rows[i].sentence]);
    lat.push(ms);
    const pred = lg[1] > lg[0] ? 1 : 0, pyPred = pyLogits[i][1] > pyLogits[i][0] ? 1 : 0;
    const refPred = refLogits[i][1] > refLogits[i][0] ? 1 : 0;
    correct += pred === rows[i].label; agree += pred === pyPred; agreeRef += pred === refPred;
    if (nativeInt8) agreeNative += pred === (nativeInt8[i][1] > nativeInt8[i][0] ? 1 : 0);
    maxDiff = Math.max(maxDiff, Math.abs(lg[0] - refLogits[i][0]), Math.abs(lg[1] - refLogits[i][1]));
    if (onProgress && i % 50 === 0) onProgress(i, n);
  }
  const memLoaded = await measureMemory({ withUA: uaMemory });
  await runner.release(); runner = null;
  const memReleased = await measureMemory({ withUA: uaMemory });
  lat.sort((a, b) => a - b);
  const q = p => lat[Math.min(lat.length - 1, Math.floor(p * lat.length))];
  return {
    page: 'phase2-baseline', date: new Date().toISOString(), precision, threads, uaMemory,
    userAgent: navigator.userAgent, hardwareConcurrency: navigator.hardwareConcurrency,
    deviceMemory: navigator.deviceMemory ?? null, crossOriginIsolated,
    load: loadStats, n, accuracy: correct / n, agreementWithPytorch: agree / n,
    reference: precision === 'int8' ? 'onnxruntime-web-wasm-node-int8' : 'pytorch-fp32',
    agreementWithNativeInt8: nativeInt8 ? agreeNative / n : null,
    agreementWithReference: agreeRef / n, maxAbsLogitDiffVsReference: maxDiff, tokenizerMismatches: tokMismatch,
    latencyMs: { mean: lat.reduce((a, b) => a + b, 0) / n, p50: q(0.5), p90: q(0.9), p99: q(0.99), min: lat[0], max: lat.at(-1) },
    memLoaded, memReleased,
  };
}
window.phase2 = { benchmark, ready: true };

$('load').onclick = async () => {
  $('load').disabled = true; $('loadInfo').textContent = 'loading…';
  try {
    const s = await load($('prec').value, Number($('thr').value), $('ua').checked);
    $('thr').disabled = true; $('thrNote').textContent = '(fixed until page reload)';
    $('loadInfo').textContent = `${MB(s.bytes)} · fetch ${s.fetchMs.toFixed(0)} ms · session ${s.createMs.toFixed(0)} ms · WASM heap ${MB(s.memAfter.wasmHeapBytes)}`;
    $('classify').disabled = $('bench').disabled = false;
  } catch (e) { $('loadInfo').textContent = 'error: ' + e.message; }
  $('load').disabled = false;
};
$('classify').onclick = async () => {
  const { logits: [lg], ms } = await runner.classify(tokenizer, [$('text').value]);
  const [pn, pp] = softmax(lg);
  $('pred').innerHTML = `<b>${pp > pn ? 'POSITIVE' : 'NEGATIVE'}</b> (${(Math.max(pn, pp) * 100).toFixed(1)}%) · ${ms.toFixed(1)} ms · tokens: ${tokenizer.decode(tokenizer.encode($('text').value)).join(' ')}`;
};
$('bench').onclick = async () => {
  $('bench').disabled = $('classify').disabled = true; $('out').textContent = 'running… (about 1 minute)';
  const r = await benchmark({ precision: $('prec').value, threads: Number($('thr').value), uaMemory: $('ua').checked,
                              onProgress: (i, n) => $('progress').textContent = `${i}/${n}` });
  $('progress').textContent = 'done (model released; reload it to continue)';
  $('out').textContent = JSON.stringify(r, null, 2);
  $('copy').disabled = false;
};
$('copy').onclick = async () => {
  try { await navigator.clipboard.writeText($('out').textContent); $('copy').textContent = 'Copied'; }
  catch { $('copy').textContent = 'Select the text and copy manually'; }
};
