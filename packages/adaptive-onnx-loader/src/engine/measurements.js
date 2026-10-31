/**
 * Measured inputs for the cost model, from Phases 2–4. Each value names its evidence.
 * They are ESTIMATES: the cost model multiplies heaps by `heapUncertainty`, and time values
 * are replaced by a per-device calibration when one is available (calibrate.js).
 */
export const HEAP_MIB = {        // Worker WASM heap per chunk (max observed; Phase 3 §5.1, Phase 4 §13.5)
  fp32: { c0_embed: 280.13, c1_l0_1: 186.2, c2_l2_3: 186.2, c3_l4_5_cls: 160.7 },
  int8: { c0_embed: 77.19,  c1_l0_1: 45.2,  c2_l2_3: 45.2,  c3_l4_5_cls: 46.4 },
};
export const EXIT_HEAD_EXTRA_MIB = 12;    // ESTIMATE (uncalibrated): fp32 head in the same Worker; validated in Phase 5 tests
export const BROWSER_OVERHEAD = {         // Phase 3 experiment D: page 2.8 MiB; UA − probe ≈ 1.6 MiB per Worker
  pageMiB: 3.0, perWorkerMiB: 2.0 };
export const PAGE_TENSOR_MIB_PER_SENTENCE = (128 * 768 * 4) / 1048576;   // worst case: one hidden state at max length (0.375 MiB)
export const CACHED_BYTES_IN_MEMORY_MIB = 0;   // Worker path keeps no byte cache in memory (Phase 4 I-4.3)

export const ACCURACY = {        // SST-2 validation (872), WASM engine — Phase 2/3 + Phase 5 measurement
  fp32: 0.9105504587155964, int8: 0.9002293577981652, mixedC2: 0.908256880733945 };
export const EARLY_EXIT_ACCURACY = {};   // filled from results/phase5/early_exit_wasm.json (measured; see planner)

export const PRECISION_PLANS = {
  fp32:    { c0_embed: 'fp32', c1_l0_1: 'fp32', c2_l2_3: 'fp32', c3_l4_5_cls: 'fp32' },
  int8:    { c0_embed: 'int8', c1_l0_1: 'int8', c2_l2_3: 'int8', c3_l4_5_cls: 'int8' },
  mixedC2: { c0_embed: 'int8', c1_l0_1: 'int8', c2_l2_3: 'fp32', c3_l4_5_cls: 'int8' },   // I-1.1
};

/** Default time calibration = CLOUD-HL-1T measurements (Phases 3–4). */
export const DEFAULT_CALIBRATION = {
  source: 'default: CLOUD-HL-1T (Phases 3–4)',
  spawnMs: 40,                        // Worker start + ORT import
  // session creation ≈ base + b·MiB, where base depends on whether ANOTHER chunk Worker is alive at that
  // moment (F-28): resident loads 123–218 ms vs sequential loads 356–395 ms in Phase 3 (CLOUD-HL-1T)
  createBaseMs: 150,       // "warm": another Worker alive
  createBaseColdMs: 360,   // "cold": no other Worker alive
  createPerMiBMs: 1.4,
  inferMs: { int8: { c0_embed: 0.19, c1_l0_1: 14.67, c2_l2_3: 14.62, c3_l4_5_cls: 14.73 },
             fp32: { c0_embed: 0.25, c1_l0_1: 23.56, c2_l2_3: 23.61, c3_l4_5_cls: 23.79 } },
  exitHeadMs: 0.3, transferMs: 0.33,  // per chunk boundary (F-19)
  idbReadMBps: 600, idbWriteMBps: 300, hashMBps: 900,
};
