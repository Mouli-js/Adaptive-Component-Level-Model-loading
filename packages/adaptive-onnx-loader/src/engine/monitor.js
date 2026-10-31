/**
 * Resource monitor — step 1 of the decision sequence.
 * Reads OBSERVABLE browser signals only (no CPU/architecture inference from the user-agent
 * string, F-16), then applies a profile override if one is given. Every value records its source.
 */
import { PROFILES, DEFAULTS } from './profiles.js';
import { ChunkStore } from '../cache/chunkStore.js';

export async function readSignals({ store = null } = {}) {
  const nav = globalThis.navigator ?? {};
  const c = nav.connection ?? {};
  const s = { deviceMemoryGiB: nav.deviceMemory ?? null, cores: nav.hardwareConcurrency ?? null,
              downlinkMbps: c.downlink ?? null, rttMs: c.rtt ?? null, effectiveType: c.effectiveType ?? null,
              saveData: c.saveData ?? null, crossOriginIsolated: !!globalThis.crossOriginIsolated,
              storage: null, cachedSha256: [] };
  try { s.storage = await ChunkStore.storageInfo(); } catch { s.storage = { supported: false }; }
  if (store) { try { s.cachedSha256 = (await store.list()).map(m => m.sha256); } catch { /* cache unreadable: treat as empty */ } }
  return s;
}

/** Merge signals with a profile. Profile values win; missing values fall back to safe defaults. */
export function applyProfile(signals, profile = null, overrides = {}) {
  const p = typeof profile === 'string' ? PROFILES[profile] : profile;
  if (profile && !p) throw new Error(`unknown profile ${profile}`);
  const src = {};
  const pick = (k, sig, fallback) => {
    if (overrides[k] !== undefined) { src[k] = 'override'; return overrides[k]; }
    if (p && p[k] !== undefined) { src[k] = `profile:${p.name}`; return p[k]; }
    if (sig !== null && sig !== undefined) { src[k] = 'browser'; return sig; }
    src[k] = 'default'; return fallback;
  };
  const deviceMemoryGiB = pick('deviceMemoryGiB', signals.deviceMemoryGiB, 2);
  const r = {
    profile: p?.name ?? 'browser',
    deviceMemoryGiB, cores: pick('cores', signals.cores, 2),
    downlinkMbps: pick('downlinkMbps', signals.downlinkMbps, 5), rttMs: pick('rttMs', signals.rttMs, 150),
    allowanceMiB: pick('allowanceMiB', null, Math.min(DEFAULTS.allowanceCapMiB, deviceMemoryGiB * 1024 * DEFAULTS.allowanceFractionOfDeviceMemory)),
    minAccuracy: pick('minAccuracy', null, 0.90),
    weights: pick('weights', null, PROFILES.mid.weights),
    reserveFraction: overrides.reserveFraction ?? DEFAULTS.reserveFraction,
    heapUncertainty: overrides.heapUncertainty ?? DEFAULTS.heapUncertainty,
    sentencesPerRequest: overrides.sentencesPerRequest ?? DEFAULTS.sentencesPerRequest,
    earlyExit: overrides.earlyExit ?? DEFAULTS.earlyExit,
    diskFreeMiB: signals.storage?.quota != null ? (signals.storage.quota - signals.storage.usage) / 1048576 : null,
    cachedSha256: signals.cachedSha256 ?? [],
    crossOriginIsolated: signals.crossOriginIsolated,
  };
  r.sources = src;
  return r;
}

/** Step 2 — usable memory budget = allowance × (1 − reserve). Disk is a SEPARATE resource. */
export function usableBudget(ctx) {
  const usableMiB = ctx.allowanceMiB * (1 - ctx.reserveFraction);
  const diskUsableMiB = ctx.diskFreeMiB == null ? 0 : ctx.diskFreeMiB * (1 - DEFAULTS.diskReserveFraction);
  return { allowanceMiB: ctx.allowanceMiB, reserveFraction: ctx.reserveFraction, reserveMiB: ctx.allowanceMiB - usableMiB,
           usableMiB, diskUsableMiB };
}
