import { installWasmMemoryProbe, wasmHeapBytes, measureMemory, WordPieceTokenizer, loadManifest,
         ChainRunner, WorkerChainRunner, WorkerChunk, chunkEntry } from 'adaptive-onnx-loader';
installWasmMemoryProbe();
const ort = await import('onnxruntime-web');
const ORT_URL = new URL('/node_modules/onnxruntime-web/dist/ort.wasm.min.mjs', location.href).href;
const WASM_PATHS = new URL('/node_modules/onnxruntime-web/dist/', location.href).href;
const WORKER_URL = new URL('/packages/adaptive-onnx-loader/src/workers/chunkWorker.js', location.href).href;
ort.env.wasm.wasmPaths = WASM_PATHS;

const $ = id => document.getElementById(id);
$('coi').textContent = crossOriginIsolated ? 'yes' : 'NO'; $('coi').className = crossOriginIsolated ? 'ok' : 'bad';
const getJSON = async u => (await fetch(u)).json();
const manifest = await loadManifest('/models/onnx/manifest.json');
const tokenizer = WordPieceTokenizer.fromVocabText(await (await fetch('/models/onnx/vocab.txt')).text(), { maxLength: manifest.max_length });
const MiB = b => +(b / 1048576).toFixed(1);

async function data(precision, limit) {
  const rows = (await getJSON('/data/sst2/validation.json')).slice(0, limit);
  return { rows,
    ref: (await getJSON(`/data/sst2/wasm_chain_${precision}_logits.json`)).slice(0, limit),   // same-kernel chain reference
    pytorch: (await getJSON('/data/sst2/py_logits.json')).slice(0, limit) };
}

function score(logits, { rows, ref, pytorch }) {
  let correct = 0, agreeRef = 0, agreePt = 0, maxRef = 0, maxPt = 0;
  logits.forEach((lg, i) => {
    const p = lg[1] > lg[0];
    correct += p === (rows[i].label === 1); agreeRef += p === (ref[i][1] > ref[i][0]); agreePt += p === (pytorch[i][1] > pytorch[i][0]);
    maxRef = Math.max(maxRef, Math.abs(lg[0] - ref[i][0]), Math.abs(lg[1] - ref[i][1]));
    maxPt = Math.max(maxPt, Math.abs(lg[0] - pytorch[i][0]), Math.abs(lg[1] - pytorch[i][1]));
  });
  const n = logits.length;
  return { n, accuracy: correct / n, agreementWithChainRef: agreeRef / n, maxAbsDiffVsChainRef: maxRef,
           agreementWithPytorch: agreePt / n, maxAbsDiffVsPytorch: maxPt };
}

const env = () => ({ date: new Date().toISOString(), userAgent: navigator.userAgent, hardwareConcurrency: navigator.hardwareConcurrency,
                     deviceMemory: navigator.deviceMemory ?? null, crossOriginIsolated });
const pct = (a, p) => { const s = [...a].sort((x, y) => x - y); return s[Math.min(s.length - 1, Math.floor(p * s.length))]; };

/** A — all 4 chunk sessions in the page's own WASM heap. */
async function mainChain({ precision = 'int8', limit = 872, threads = 1 } = {}) {
  ort.env.wasm.numThreads = threads;
  const d = await data(precision, limit);
  const runner = new ChainRunner(ort, manifest, { precision });
  const t0 = performance.now(); const loads = await runner.load(); const loadMs = performance.now() - t0;
  const heapLoaded = wasmHeapBytes();
  const logits = [], lat = [], chunkMs = [0, 0, 0, 0];
  for (const r of d.rows) {
    const o = await runner.classify(tokenizer, [r.sentence]);
    logits.push(o.logits[0]); lat.push(o.ms); o.chunkMs.forEach((m, i) => chunkMs[i] += m);
  }
  await runner.release();
  return { experiment: 'A-mainChain', precision, threads, ...env(), ...score(logits, d), loadMs, loads,
           wasmHeapMiB: { loaded: MiB(heapLoaded), afterRelease: MiB(wasmHeapBytes()) },
           latencyMs: { mean: lat.reduce((a, b) => a + b) / lat.length, p50: pct(lat, .5), p90: pct(lat, .9) },
           meanChunkRunMs: chunkMs.map(m => m / d.rows.length) };
}

function wcr(precision, mode, threads) {
  return new WorkerChainRunner(manifest, { precision, mode, numThreads: threads, workerUrl: WORKER_URL, ortUrl: ORT_URL, wasmPaths: WASM_PATHS });
}

/** B / C — one Worker per chunk. */
async function workers({ precision = 'int8', mode = 'resident', limit = 872, threads = 1, onProgress } = {}) {
  const d = await data(precision, limit);
  const r = wcr(precision, mode, threads);
  const t0 = performance.now(); await r.load(); const loadMs = performance.now() - t0;
  const res = await r.classifyMany(tokenizer, d.rows.map(x => x.sentence), { onProgress });
  await r.release();
  return { experiment: mode === 'resident' ? 'B-workersResident' : 'C-workersSequential', precision, mode, threads, ...env(),
           ...score(res.logits, d), loadMs, loads: r.loads, totalMs: res.totalMs, meanMsPerSentence: res.totalMs / d.rows.length,
           perChunk: res.perChunk, maxActivationMiB: MiB(res.maxActivationBytes),
           peakLiveHeapMiB: MiB(r.peakLiveHeapBytes), liveHeapAfterReleaseMiB: MiB(r.liveHeapBytes),
           pageHeapMiB: MiB(wasmHeapBytes()),
           timeline: r.timeline.map(e => ({ ...e, t: Math.round(e.t), liveHeapMiB: MiB(e.liveHeapBytes), liveHeapBytes: undefined })) };
}

/** D — does terminate() really free memory? Measured independently with the browser's own API. */
async function memoryProof({ precision = 'int8', threads = 1 } = {}) {
  const ua = async label => { const m = await measureMemory({ withUA: true }); return { label, uaMiB: m.uaBytes ? MiB(m.uaBytes) : null, uaError: m.uaError ?? null, ms: null }; };
  const steps = [];
  const timed = async label => { const t = performance.now(); const s = await ua(label); s.ms = Math.round(performance.now() - t); steps.push(s); return s; };
  await timed('0 · page only, no Workers');
  const r = wcr(precision, 'resident', threads); await r.load();
  steps.at(-1).probeLiveMiB = 0;
  await timed('1 · 4 resident chunk Workers loaded'); steps.at(-1).probeLiveMiB = MiB(r.liveHeapBytes);
  for (const w of r.workers.values()) await w.release();
  await timed('2 · session.release() in every Worker (Workers still alive)'); steps.at(-1).probeLiveMiB = MiB(r.liveHeapBytes);
  await r.release();
  await new Promise(res => setTimeout(res, 1000));
  await timed('3 · all Workers terminated'); steps.at(-1).probeLiveMiB = MiB(r.liveHeapBytes);
  return { experiment: 'D-memoryProof', precision, threads, ...env(), steps };
}

/** E — memory ORT needs before any real model: a Worker hosting the smallest graph (exit head, 2.4 MB fp32 / 0.6 MB int8). */
async function baseOverhead({ threads = 1 } = {}) {
  const out = [];
  for (const precision of ['fp32', 'int8']) {
    const e = chunkEntry(manifest, 'e1_after_c1', precision);
    const w = await WorkerChunk.spawn(e, { workerUrl: WORKER_URL, ortUrl: ORT_URL, wasmPaths: WASM_PATHS, numThreads: threads });
    out.push({ graph: `e1_after_c1/${precision}`, fileMiB: MiB(e.bytes), workerHeapMiB: MiB(w.heapBytes), spawnInitMs: Math.round(w.stats.spawnInitMs), createMs: Math.round(w.stats.createMs) });
    w.terminate();
  }
  return { experiment: 'E-baseOverhead', threads, ...env(), workers: out };
}

window.phase3 = { mainChain, workers, memoryProof, baseOverhead, ready: true };

for (const b of document.querySelectorAll('[data-exp]')) b.onclick = async () => {
  const opts = { precision: $('prec').value, limit: Number($('lim').value), threads: Number($('thr').value),
                 onProgress: (i, n, what = 'sentences') => $('st').textContent = `${i}/${n} ${what}` };
  document.querySelectorAll('button').forEach(x => x.disabled = true); $('out').textContent = 'running…'; $('st').textContent = '';
  try {
    const exp = b.dataset.exp;
    const r = exp === 'resident' || exp === 'sequential' ? await workers({ ...opts, mode: exp }) : await window.phase3[exp](opts);
    $('out').textContent = JSON.stringify(r, null, 2); $('st').textContent = 'done — reload before the next experiment';
  } catch (e) { $('out').textContent = 'ERROR: ' + (e.stack || e); }
  document.querySelectorAll('button').forEach(x => x.disabled = false);
};
$('copy').onclick = async () => { try { await navigator.clipboard.writeText($('out').textContent); $('copy').textContent = 'Copied'; } catch { $('copy').textContent = 'Select and copy manually'; } };
