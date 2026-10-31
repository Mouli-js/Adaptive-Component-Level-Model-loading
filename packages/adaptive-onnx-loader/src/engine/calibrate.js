/**
 * Per-device time calibration (memory is NOT calibrated: it uses measured heaps × uncertainty).
 * Each time component is measured SEPARATELY, on the same load path the PlanRunner uses
 * (new Worker → bytes via the cache tier → session creation), and made robust:
 *   - every load is repeated REPEATS times per precision; MEDIANS are used (one outlier sample —
 *     observed in the first version of this function — can no longer skew the model)
 *   - inference: the first WARMUP runs after a Worker starts are discarded (JIT warm-up: ~2× slower)
 * Measured:
 *   spawnMs                       Worker start + ORT import
 *   createBaseMs, createPerMiBMs  session creation ≈ a + b·MiB with another Worker alive ("warm"), fitted on
 *                                 C1 int8 (13.6 MiB) and C1 fp32 (54.1 MiB)
 *   createBaseColdMs              same, with NO other Worker alive ("cold") — measurably slower (F-28)
 *   inferMs                       C1 steady-state per precision on a length-representative sample of
 *                                 sentences (inference time depends on length); other chunks scaled by default ratios
 *   transferMs                    message round-trip minus run time
 *   idbReadMBps, hashMBps         from loads served by IndexedDB (repeats 2..n)
 * Download speed is NOT calibrated: it comes from the link signal or the profile.
 */
import { WorkerChunk } from '../workers/workerChunk.js';
import { chunkEntry } from '../manifest.js';
import { encodeToTensors } from '../chunks/chain.js';
import { DEFAULT_CALIBRATION } from './measurements.js';

const median = a => { const s = [...a].sort((x, y) => x - y), m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };

export async function calibrate({ manifest, workerOpts, tokenizer, sentences, repeats = 3, warmup = 3 }) {
  const t0 = performance.now(), notes = [], raw = {};
  for (const prec of ['int8', 'fp32']) {
    const e0 = chunkEntry(manifest, 'c0_embed', prec), e1 = chunkEntry(manifest, 'c1_l0_1', prec);
    const w0 = await WorkerChunk.spawn(e0, workerOpts);                       // provides real hidden states
    const loads = [], runs = [], over = [];
    for (let k = 0; k < repeats; k++) {
      const t = performance.now();
      const w1 = await WorkerChunk.spawn(e1, workerOpts);
      loads.push({ totalMs: performance.now() - t, spawnMs: w1.stats.spawnInitMs, createMs: w1.stats.createMs, cache: w1.stats.cache });
      if (k === repeats - 1) {                                                 // inference on the last Worker only
        for (let i = 0; i < warmup + sentences.length; i++) {
          const enc = encodeToTensors(tokenizer, [sentences[i % sentences.length]]);
          const { outputs } = await w0.run({ input_ids: enc.input_ids });
          const r = await w1.run({ hidden_in: outputs.hidden, attention_mask: enc.attention_mask });
          if (i >= warmup) { runs.push(r.runMs); over.push(r.overheadMs); }
        }
      }
      w1.terminate();
    }
    w0.terminate();
    const cold = [];                                                          // no other Worker alive now
    for (let k = 0; k < 2; k++) { const w = await WorkerChunk.spawn(e1, workerOpts); cold.push(w.stats.createMs); w.terminate(); }
    const idb = loads.filter(l => l.cache?.source === 'idb');
    raw[prec] = { sizeMiB: e1.bytes / 1048576, createMs: median(loads.map(l => l.createMs)), createColdMs: median(cold), coldSamples: cold.map(Math.round),
                  spawnMs: median(loads.map(l => l.spawnMs)),
                  inferC1: median(runs), overhead: median(over), loads: loads.map(l => ({ totalMs: Math.round(l.totalMs), createMs: Math.round(l.createMs), source: l.cache?.source })),
                  idbReadMBps: idb.length ? median(idb.map(l => (e1.bytes / 1e6) / (l.cache.idbReadMs / 1000))) : null,
                  hashMBps: idb.length ? median(idb.map(l => (e1.bytes / 1e6) / (l.cache.verifyMs / 1000))) : null };
  }
  const slope = Math.max(0, (raw.fp32.createMs - raw.int8.createMs) / (raw.fp32.sizeMiB - raw.int8.sizeMiB));
  const base = Math.max(0, raw.int8.createMs - slope * raw.int8.sizeMiB);
  const baseCold = Math.max(0, median([raw.int8.createColdMs - slope * raw.int8.sizeMiB, raw.fp32.createColdMs - slope * raw.fp32.sizeMiB]));
  const inferMs = {};
  for (const prec of ['int8', 'fp32']) {
    const scale = raw[prec].inferC1 / DEFAULT_CALIBRATION.inferMs[prec].c1_l0_1;
    inferMs[prec] = Object.fromEntries(Object.entries(DEFAULT_CALIBRATION.inferMs[prec]).map(([k, v]) => [k, v * scale]));
  }
  const pickRate = k => raw.fp32[k] ?? raw.int8[k];
  if (pickRate('idbReadMBps') == null) notes.push('IndexedDB rates not measured (no load came from the cache): defaults kept');
  return { ...DEFAULT_CALIBRATION, source: `calibrated on this device (${repeats} loads × 2 precisions, ${sentences.length} sentences after ${warmup} warm-up runs; ${Math.round(performance.now() - t0)} ms)`,
           spawnMs: median([raw.int8.spawnMs, raw.fp32.spawnMs]), createBaseMs: base, createBaseColdMs: baseCold, createPerMiBMs: slope, inferMs,
           transferMs: median([raw.int8.overhead, raw.fp32.overhead]),
           idbReadMBps: pickRate('idbReadMBps') ?? DEFAULT_CALIBRATION.idbReadMBps, hashMBps: pickRate('hashMBps') ?? DEFAULT_CALIBRATION.hashMBps,
           raw, notes };
}
