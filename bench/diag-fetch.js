/**
 * Diagnostic for the Phase 2 observation "int8 fetch (67 MB) took longer than fp32 (268 MB)".
 * Does NOT change the baseline; it reuses FullModelRunner unchanged.
 *
 * T1 raw-fetch     : no ORT loaded. 6 rounds, file order alternates each round. cache:'no-store'
 *                    + unique query string, so every fetch is a real transfer. Resource Timing
 *                    splits each fetch into: waiting for first byte (TTFB), body download, and
 *                    the time from last byte to arrayBuffer() resolving.
 *                    -> tests: size-proportionality, order / first-request effects, run-to-run variance.
 * T2 replay        : the manual procedure exactly: FullModelRunner.create (UI "Load"), 1 classify,
 *                    then FullModelRunner.create again (benchmark's load). int8 then fp32, then int8 again.
 *                    -> tests: whether the procedure itself produces the slow int8 fetch.
 * T3 after-compute : raw fetch of each file (a) right after 20 inferences, (b) after 3 s idle.
 *                    -> tests: whether just-finished ORT thread-pool work slows a following fetch.
 */
import { installWasmMemoryProbe, wasmHeapBytes, WordPieceTokenizer, FullModelRunner } from 'adaptive-onnx-loader';
installWasmMemoryProbe();
const ort = await import('onnxruntime-web');
ort.env.wasm.wasmPaths = '/node_modules/onnxruntime-web/dist/';
const THREADS = Number(new URLSearchParams(location.search).get('threads') || 4);
ort.env.wasm.numThreads = THREADS;
performance.setResourceTimingBufferSize(2000);

const FILES = { int8: '/models/onnx/int8/full.onnx', fp32: '/models/onnx/fp32/full.onnx' };
const sleep = ms => new Promise(r => setTimeout(r, ms));
const $ = id => document.getElementById(id);
const status = s => { $('st').textContent = s; };

/** One instrumented fetch. Mirrors FullModelRunner's fetch + arrayBuffer, plus timing phases. */
async function timedFetch(path, label) {
  const url = `${path}?diag=${label}-${Math.random().toString(36).slice(2)}`;
  const t0 = performance.now();
  const res = await fetch(url, { cache: 'no-store' });
  const buf = await res.arrayBuffer();
  const t1 = performance.now();
  await sleep(0);                                  // let the resource-timing entry be queued
  const e = performance.getEntriesByName(new URL(url, location.href).href).at(-1);
  const r = { label, bytes: buf.byteLength, totalMs: t1 - t0, MBps: buf.byteLength / 1e6 / ((t1 - t0) / 1000) };
  if (e) Object.assign(r, {
    queueMs: e.requestStart - e.startTime,          // before the request was sent (stalled/queued)
    ttfbMs: e.responseStart - e.requestStart,       // server think time + first byte
    downloadMs: e.responseEnd - e.responseStart,    // body transfer
    toArrayBufferMs: t1 - (e.responseEnd),          // after the last byte until arrayBuffer() resolved (approx.)
    protocol: e.nextHopProtocol });
  return r;
}

async function t1RawFetch() {
  const rows = [];
  for (let round = 0; round < 6; round++) {
    const order = round % 2 === 0 ? ['int8', 'fp32'] : ['fp32', 'int8'];
    for (const p of order) { status(`T1 round ${round + 1}/6: ${p}`); rows.push({ round, ...await timedFetch(FILES[p], p) }); await sleep(300); }
  }
  return rows;
}

async function t2Replay(tok) {
  const rows = [];
  for (const p of ['int8', 'fp32', 'int8']) {
    status(`T2 replay: ${p}`);
    let r = await FullModelRunner.create(ort, FILES[p]);                 // "Load model" button
    rows.push({ step: `${p}: load #1 (UI button)`, fetchMs: r.stats.fetchMs, createMs: r.stats.createMs, MBps: r.stats.bytes / 1e6 / (r.stats.fetchMs / 1000), heapMiB: wasmHeapBytes() / 2 ** 20 });
    await r.classify(tok, ['a gorgeous, witty, seductive movie.']);      // "Classify" button
    await r.release();
    r = await FullModelRunner.create(ort, FILES[p]);                     // benchmark() -> load()
    rows.push({ step: `${p}: load #2 (benchmark)`, fetchMs: r.stats.fetchMs, createMs: r.stats.createMs, MBps: r.stats.bytes / 1e6 / (r.stats.fetchMs / 1000), heapMiB: wasmHeapBytes() / 2 ** 20 });
    await r.release();
    await sleep(500);
  }
  return rows;
}

async function t3AfterCompute(tok) {
  const rows = [];
  const r = await FullModelRunner.create(ort, FILES.int8);
  for (const p of ['int8', 'fp32']) {
    for (let k = 0; k < 2; k++) {
      status(`T3: ${p} right after inference (${k + 1}/2)`);
      for (let i = 0; i < 20; i++) await r.classify(tok, ['the plot is dull and the acting is worse.']);
      rows.push({ condition: 'immediately after 20 inferences', ...await timedFetch(FILES[p], p) });
      status(`T3: ${p} after 3 s idle (${k + 1}/2)`);
      await sleep(3000);
      rows.push({ condition: 'after 3 s idle', ...await timedFetch(FILES[p], p) });
    }
  }
  await r.release();
  return rows;
}

function summarize(rows, key) {
  const g = {};
  for (const r of rows) (g[r[key]] ??= []).push(r);
  const out = {};
  for (const [k, v] of Object.entries(g)) {
    const ms = v.map(x => x.totalMs ?? x.fetchMs).sort((a, b) => a - b);
    out[k] = { n: ms.length, medianMs: ms[Math.floor(ms.length / 2)], minMs: ms[0], maxMs: ms.at(-1),
               medianMBps: v.map(x => x.MBps).sort((a, b) => a - b)[Math.floor(v.length / 2)] };
  }
  return out;
}

async function runAll() {
  const tok = WordPieceTokenizer.fromVocabText(await (await fetch('/models/onnx/vocab.txt')).text());
  const t1 = await t1RawFetch();
  const t2 = await t2Replay(tok);
  const t3 = await t3AfterCompute(tok);
  return {
    page: 'diag-fetch', date: new Date().toISOString(), userAgent: navigator.userAgent,
    hardwareConcurrency: navigator.hardwareConcurrency, deviceMemory: navigator.deviceMemory ?? null,
    crossOriginIsolated, threads: THREADS,
    summary: {
      T1_rawFetch_byFile: summarize(t1, 'label'),
      T1_firstFetchOfPage: t1[0],
      T3_byCondition: Object.fromEntries(['int8', 'fp32'].map(p => [p, summarize(t3.filter(r => r.label === p), 'condition')])),
    },
    T1_rawFetch: t1, T2_replay: t2, T3_afterCompute: t3,
  };
}
window.diag = { runAll, ready: true };
$('run').onclick = async () => {
  $('run').disabled = true; $('out').textContent = 'running…';
  try { const r = await runAll(); $('out').textContent = JSON.stringify(r, null, 2); status('done'); $('copy').disabled = false; }
  catch (e) { $('out').textContent = 'ERROR: ' + e.stack; }
};
$('copy').onclick = async () => { try { await navigator.clipboard.writeText($('out').textContent); $('copy').textContent = 'Copied'; } catch { $('copy').textContent = 'Select and copy manually'; } };
