import { installWasmMemoryProbe, WordPieceTokenizer, loadManifest, chunkEntry, WorkerChainRunner, PooledChainRunner,
         ChunkStore, ChunkLoader, sha256Hex } from 'adaptive-onnx-loader';
installWasmMemoryProbe();
const ORT_URL = new URL('/node_modules/onnxruntime-web/dist/ort.wasm.min.mjs', location.href).href;
const WASM_PATHS = new URL('/node_modules/onnxruntime-web/dist/', location.href).href;
const WORKER_URL = new URL('/packages/adaptive-onnx-loader/src/workers/chunkWorker.js', location.href).href;
const DB = 'adaptive-onnx-loader';
const $ = id => document.getElementById(id);
const MiB = b => +(b / 1048576).toFixed(2);
const getJSON = async u => (await fetch(u)).json();
$('coi').textContent = crossOriginIsolated ? 'yes' : 'NO'; $('coi').className = crossOriginIsolated ? 'ok' : 'bad';

const manifest = await loadManifest('/models/onnx/manifest.json');
const tokenizer = WordPieceTokenizer.fromVocabText(await (await fetch('/models/onnx/vocab.txt')).text(), { maxLength: manifest.max_length });
const rows = await getJSON('/data/sst2/validation.json');
const refs = { int8: await getJSON('/data/sst2/wasm_chain_int8_logits.json'), fp32: await getJSON('/data/sst2/wasm_chain_fp32_logits.json') };
const workerOpts = (cache) => ({ workerUrl: WORKER_URL, ortUrl: ORT_URL, wasmPaths: WASM_PATHS, numThreads: 1, cache });
const env = () => ({ date: new Date().toISOString(), userAgent: navigator.userAgent, hardwareConcurrency: navigator.hardwareConcurrency,
                     deviceMemory: navigator.deviceMemory ?? null, crossOriginIsolated });
const sameAsRef = (lg, precision, i) => Math.max(Math.abs(lg[0] - refs[precision][i][0]), Math.abs(lg[1] - refs[precision][i][1]));

async function withStore(fn, budgetBytes) { const s = await ChunkStore.open({ dbName: DB, budgetBytes }); try { return await fn(s); } finally { s.close(); } }
async function storeState() {
  return withStore(async s => (await s.list()).sort((a, b) => a.lastUsed - b.lastUsed)
    .map(m => ({ name: m.name, precision: m.precision, sizeMiB: MiB(m.size), hits: m.hits })));
}
async function clearCache() { await withStore(s => s.clear()); return storeState(); }
async function storageInfo({ requestPersist = false } = {}) {
  const i = await ChunkStore.storageInfo({ requestPersist });
  return { ...i, quotaMiB: i.quota && MiB(i.quota), usageMiB: i.usage != null ? MiB(i.usage) : null, stored: await storeState() };
}
async function refreshStored() { const s = await storeState(); $('stored').textContent = s.length ? s.map(x => `${x.name}/${x.precision}`).join(', ') : 'none'; }

/** F1 — one request in SEQUENTIAL mode with the IndexedDB tier: each chunk Worker gets its bytes
 *  from IndexedDB if present (else downloads, verifies, stores). Run it twice in a row in one visit;
 *  the harness also runs it in separate browser launches (revisits). */
async function singleRequest({ precision = 'int8', sentence = 0, cacheBudgetMiB = null, verifyOnRead = true, useCache = true } = {}) {
  const cache = useCache ? { dbName: DB, verifyOnRead, budgetBytes: cacheBudgetMiB ? cacheBudgetMiB * 1048576 : Infinity } : null;
  const r = new WorkerChainRunner(manifest, { precision, mode: 'sequential', ...workerOpts(cache) });
  const t0 = performance.now();
  const res = await r.classifyMany(tokenizer, [rows[sentence].sentence]);
  const totalMs = performance.now() - t0;
  await r.release();
  const loads = r.loads.map(l => ({ chunk: l.name, source: l.cache?.source ?? 'network(no cache)', getBytesMs: Math.round(l.fetchMs),
    idbReadMs: l.cache?.idbReadMs != null ? Math.round(l.cache.idbReadMs) : null, verifyMs: l.cache?.verifyMs != null ? Math.round(l.cache.verifyMs) : null,
    netFetchMs: l.cache?.fetchMs != null ? Math.round(l.cache.fetchMs) : null, idbPutMs: l.cache?.idbPutMs != null ? Math.round(l.cache.idbPutMs) : null,
    stored: l.cache?.stored ?? null, corruptEvicted: l.cache?.corruptEvicted ?? false, createMs: Math.round(l.createMs), spawnInitMs: Math.round(l.spawnInitMs) }));
  const lookups = loads.length, idbHits = loads.filter(l => l.source === 'idb').length;
  return { experiment: 'F1-singleRequest', precision, useCache, verifyOnRead, cacheBudgetMiB, ...env(), totalMs: Math.round(totalMs),
           maxAbsDiffVsRef: sameAsRef(res.logits[0], precision, sentence), peakLiveHeapMiB: MiB(r.peakLiveHeapBytes),
           hitRate: idbHits / lookups, loads, storeAfter: await storeState() };
}

/** F5 — cost of each tier per chunk, measured on the page (no Workers): network fetch,
 *  SHA-256 verification, IndexedDB write, IndexedDB read. */
async function verifyCost({ precision = 'int8' } = {}) {
  const out = [];
  await withStore(async store => {
    for (const name of manifest.chain) {
      const e = chunkEntry(manifest, name, precision);
      await store.delete(e.sha256);
      const t0 = performance.now(); const b = new Uint8Array(await (await fetch(e.url, { cache: 'no-store' })).arrayBuffer()); const fetchMs = performance.now() - t0;
      const t1 = performance.now(); const h = await sha256Hex(b); const hashMs = performance.now() - t1;
      const t2 = performance.now(); await store.put(e.sha256, b, e); const putMs = performance.now() - t2;
      const t3 = performance.now(); const got = await store.get(e.sha256); const readMs = performance.now() - t3;
      out.push({ chunk: name, sizeMiB: MiB(b.byteLength), fetchMs: Math.round(fetchMs), sha256Ms: Math.round(hashMs),
                 hashMBps: Math.round(b.byteLength / 1e6 / (hashMs / 1000)), idbPutMs: Math.round(putMs), idbReadMs: Math.round(readMs),
                 hashOk: h === e.sha256, readBackOk: got.bytes.byteLength === b.byteLength });
    }
  });
  return { experiment: 'F5-verifyCost', precision, ...env(), chunks: out };
}

/** F3 — tamper with one stored chunk (same size, one flipped byte), then run a request. */
async function corruptionTest({ precision = 'int8', chunk = 'c1_l0_1', sentence = 0 } = {}) {
  const e = chunkEntry(manifest, chunk, precision);
  await singleRequest({ precision, sentence });                       // make sure everything is cached first
  const tampered = await withStore(async s => {
    const { bytes } = await s.get(e.sha256);
    const bad = bytes.slice(); bad[Math.floor(bad.length / 2)] ^= 0xff;
    await s.put(e.sha256, bad, e);
    return (await sha256Hex(bad)) !== e.sha256;
  });
  const r = await singleRequest({ precision, sentence });
  const repaired = await withStore(async s => (await sha256Hex((await s.get(e.sha256)).bytes)) === e.sha256);
  const victim = r.loads.find(l => l.chunk === chunk);
  return { experiment: 'F3-corruption', precision, chunk, ...env(), tamperedHashDiffers: tampered,
           detected: victim.corruptEvicted, refetchedFrom: victim.source, others: r.loads.filter(l => l.chunk !== chunk).map(l => l.source),
           maxAbsDiffVsRef: r.maxAbsDiffVsRef, storeRepaired: repaired };
}

/** F4 — sentence-major chain on a WorkerPool under a heap budget (hot tier), with IndexedDB behind it. */
async function poolTest({ precision = 'int8', budgetMiB = null, limit = 20, onProgress } = {}) {
  const runner = new PooledChainRunner(manifest, { precision, heapBudgetBytes: budgetMiB ? budgetMiB * 1048576 : Infinity,
                                                   workerOpts: workerOpts({ dbName: DB, verifyOnRead: true }) });
  let maxDiff = 0; const lat = [];
  for (let i = 0; i < limit; i++) {
    const o = await runner.classify(tokenizer, rows[i].sentence);
    maxDiff = Math.max(maxDiff, sameAsRef(o.logits, precision, i)); lat.push(o.ms);
    if (onProgress) onProgress(i + 1, limit);
  }
  const p = runner.pool, peak = p.peakLiveHeapBytes;
  runner.release();
  const sources = runner.loadEvents.map(l => l.cache?.source);
  return { experiment: 'F4-pool', precision, budgetMiB, limit, ...env(), maxAbsDiffVsRef: maxDiff, peakLiveHeapMiB: MiB(peak),
           withinBudget: budgetMiB ? peak <= budgetMiB * 1048576 : true, poolStats: p.stats,
           hotHitRate: p.stats.hits / (p.stats.hits + p.stats.misses), loadsBySource: sources.reduce((a, s) => (a[s] = (a[s] || 0) + 1, a), {}),
           meanMsPerSentence: lat.reduce((a, b) => a + b, 0) / limit, firstSentenceMs: Math.round(lat[0]),
           timeline: p.timeline.slice(0, 60) };
}

window.phase4 = { singleRequest, verifyCost, corruptionTest, poolTest, clearCache, storeState, storageInfo, ready: true };
await refreshStored();

const busy = on => document.querySelectorAll('button').forEach(b => b.disabled = on);
async function show(p) { busy(true); $('out').textContent = 'running…'; try { $('out').textContent = JSON.stringify(await p, null, 2); } catch (e) { $('out').textContent = 'ERROR: ' + (e.stack || e); } busy(false); await refreshStored(); }
$('clear').onclick = () => show(clearCache());
$('info').onclick = () => show(storageInfo({ requestPersist: true }));
for (const b of document.querySelectorAll('[data-exp]')) b.onclick = () => {
  const precision = $('prec').value, onProgress = (i, n) => $('st').textContent = `${i}/${n}`;
  const exp = b.dataset.exp;
  show(exp === 'singleRequest' ? (async () => ({ first: await singleRequest({ precision }), second: await singleRequest({ precision }) }))()
     : exp === 'poolTest' ? (async () => ({ unlimited: await poolTest({ precision, onProgress }), budget: await poolTest({ precision, budgetMiB: precision === 'int8' ? 120 : 450, limit: 10, onProgress }) }))()
     : window.phase4[exp]({ precision }));
};
$('copy').onclick = async () => { try { await navigator.clipboard.writeText($('out').textContent); $('copy').textContent = 'Copied'; } catch { $('copy').textContent = 'Select and copy manually'; } };
