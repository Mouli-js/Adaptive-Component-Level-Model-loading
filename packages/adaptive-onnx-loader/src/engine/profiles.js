/**
 * Device profiles (simulated) and engine defaults.
 *
 * A profile OVERRIDES the browser's signals so the engine can be tested deterministically.
 *   allowanceMiB : memory the page may use for the model (before the safety reserve)
 *   minAccuracy  : HARD constraint (SST-2 validation accuracy of the chosen plan)
 *   weights      : PREFERENCES in Cost = wm·M̂ + wt·T̂ + wl·L̂ + wn·N̂ (each term normalised by the
 *                  best feasible value, so the weights are unit-free). Low prioritises memory,
 *                  High prioritises latency.
 */
export const PROFILES = {
  low:  { name: 'low',  deviceMemoryGiB: 1, cores: 2, downlinkMbps: 1.5, rttMs: 300, allowanceMiB: 150,
          minAccuracy: 0.900, weights: { m: 0.60, t: 0.20, l: 0.20, n: 0.00 } },
  mid:  { name: 'mid',  deviceMemoryGiB: 4, cores: 4, downlinkMbps: 10,  rttMs: 100, allowanceMiB: 512,
          minAccuracy: 0.905, weights: { m: 0.34, t: 0.33, l: 0.33, n: 0.00 } },
  high: { name: 'high', deviceMemoryGiB: 8, cores: 8, downlinkMbps: 50,  rttMs: 40,  allowanceMiB: 1536,
          minAccuracy: 0.910, weights: { m: 0.10, t: 0.60, l: 0.30, n: 0.00 } },
};

export const DEFAULTS = {
  reserveFraction: 0.15,   // keep 15% of the allowance unused (never target 100% of the budget)
  heapUncertainty: 1.10,   // measured Worker heaps × 1.10: heaps can differ by platform/browser/version
  diskReserveFraction: 0.10,
  sentencesPerRequest: 1,  // interactive by default; batch workloads raise this
  groupSizes: [1, 8, 32],
  allowanceFractionOfDeviceMemory: 0.125, allowanceCapMiB: 2048,   // used when no profile is given
  earlyExit: false,        // OFF unless the caller opts in explicitly
};
