# Phase 4 — Storage and Cache Layer: Completion Report

**Planned:** 14–16 Nov 2026 · **Actual:** 31 Oct 2026 (Day 1) · **Status:** 🟨 Complete and verified (cloud), **awaiting your approval**

---

## 1. Phase overview

**Objective:** A chunk that has been loaded once should never be downloaded again, and corrupted or tampered chunks must never reach the model.

Phase 3 left two costs on the table:

- In sequential mode, every request reloaded all 4 chunks (+2–3 s).
- Re-fetching a file in the same page was slower than the first fetch (F-11).

| Planned deliverable | Status |
|---|---|
| IndexedDB cold store with LRU eviction under a disk budget | ✅ `ChunkStore` |
| In-memory hot set with LRU | ✅ `MemoryLRU` (bytes) + `WorkerPool` (live Workers, the real hot tier) |
| SHA-256 integrity against the manifest; corrupt entries evicted and re-fetched | ✅ `ChunkLoader` |
| Quota handling (`storage.estimate()`, `persist()`, `QuotaExceededError`) | ✅ |
| Cache wired into the Workers, with bytes never passing through the page | ✅ opt-in `cache` option (off = Phase 3 behaviour, verified) |
| Cold vs warm load (H5), hit rate (M6), re-check of F-11 | ✅ including a bandwidth-limited link |

## 2. Headline results

**H5: warm vs cold, one request** (sequential mode, 1 thread per Worker, every output bit-identical to the reference):

| Link | Precision | No cache | Cold (fills the cache) | **Warm (revisit)** | Speed-up | Model bytes on revisit |
|---|---|---|---|---|---|---|
| **20 Mbit/s, RTT 40 ms** | int8 | 28.71 s | 29.08 s | **2.27 s** | **12.8×** | **0** (was 64.2 MiB) |
| **20 Mbit/s, RTT 40 ms** | fp32 | 109.20 s | 110.43 s | **2.92 s** | **37.8×** | **0** (was 255.5 MiB) |
| localhost (unthrottled) | int8 | 2.19 s | 2.40 s | 2.19 s | 1.1× | 0 |
| localhost (unthrottled) | fp32 | 12.72 s ⚠ | 4.46 s | 2.75 s | 1.6× | 0 |

⚠ The fp32 no-cache localhost run (12.7 s) was slower than the cold run *with* the cache (4.5 s), which is backwards. It was the first model fetch in a fresh browser profile and is a single sample, consistent with F-9/F-12. I'm reporting it as an anomaly, not as evidence.

**M6: hit rate over 3 visits** (every visit is a new browser process on the same on-disk profile):

| Disk budget | int8 (model 64.2 MiB) | fp32 (model 255.5 MiB) |
|---|---|---|
| Unlimited / ≥ model (70 / 270 MiB) | visit 1: 0 · visits 2–3: **1.0** | visit 1: 0 · visits 2–3: **1.0** |
| **Below the model size** (45 / 150 MiB) | **0 · 0 · 0** | **0 · 0 · 0** |

**Integrity:** a tampered chunk (same size, one flipped byte) was **detected, evicted, re-fetched and repaired** in both precisions. The other 3 chunks were still served from the cache, and the output was bit-identical. A corrupted *download* is rejected and never stored (unit test).

**Hot tier (`WorkerPool`):**

| | Peak live heap | Hits / misses | Time per sentence |
|---|---|---|---|
| int8, unlimited | 214.1 MiB | 116 / 4 | ~45 ms after the first sentence (first: 1.65 s) |
| int8, **budget 120 MiB** | 91.6 MiB ✅ within budget | **0 / 40** | **1,469 ms** (33× slower) |
| fp32, unlimited | 813.3 MiB | 116 / 4 | ~71 ms after the first (first: 3.27 s) |
| fp32, **budget 450 MiB** | 440.8 MiB ✅ within budget | **0 / 40** | **2,088 ms** (29× slower) |

## 3. Findings (added to `docs/FINDINGS.md`)

| ID | Finding |
|---|---|
| **F-22** | **Once bytes are cached, session creation dominates the load.** On a warm request, creating each chunk's session takes 330–475 ms (int8) or 424–446 ms (fp32), **63% (fp32) to 72% (int8) of the request**. Getting the bytes from IndexedDB, including verification, takes only 35–67 ms (int8) or 138–246 ms (fp32). The cache removes *transfer*, not *creation*. Keeping Workers alive (the hot tier) is the only way to remove creation as well, which is a Phase 5 decision. |
| **F-23** | **How much the cache helps depends on the network link.** On localhost a warm request is only 1.1–1.6× faster. At 20 Mbit/s it's **12.8× (int8) / 37.8× (fp32)** faster, and a revisit downloads **0 bytes**. Filling the cache costs 0.37 s (int8) / 1.23 s (fp32) extra on the cold request (+1.3% / +1.1%). |
| **F-24** | **LRU gets a 0% hit rate whenever the budget is smaller than the working set and chunks are used in a fixed order** (C0→C1→C2→C3, then again). Each chunk is evicted just before it's needed. This happened on disk (0/12 per precision) and in the Worker pool (0/40), and the pool then becomes 29–33× slower. This is a known weakness of LRU on cyclic access patterns. Phase 5 must either avoid that situation (chunk-major processing) or use a policy that keeps part of the set (e.g. pin some chunks, or evict the most-recently-used instead). |
| **F-25** | **SHA-256 verification is cheap:** 0.4–1.1 GB/s, i.e. 13–39 ms per int8 chunk and 63–115 ms per fp32 chunk. That's roughly 5–20% of a chunk's load time, so verification on every read stays **on by default**. |
| **F-26** | **Storage:** headless Chromium reports a ~10 GiB quota, and `persist()` returned `false` (no user prompt in headless mode). Non-persistent storage can be evicted by the browser under storage pressure. The cache handles a missing entry by re-downloading it (it's never wrong, only slower). |
| F-11 (re-checked) | The slower re-fetch disappears with the cache, because the second load reads IndexedDB instead of the network. A warm visit downloads 0 bytes. |

## 4. Implementation details

### 4.1 The four tiers

```
request for chunk X (manifest entry: name, precision, bytes, sha256, url)
  │
  ├─ T0 hot   WorkerPool        live Worker with session already created? ── hit → 0 ms load
  │                              (LRU under a WASM-heap budget; eviction = terminate())
  ├─ T1 warm  MemoryLRU          bytes in memory?                      ── hit → createSession
  ├─ T2 cold  ChunkStore (IDB)   bytes on disk?  → verify SHA-256 ─ ok → createSession
  │                                                     └─ bad → delete entry, fall through
  └─ T3       network            download → verify SHA-256 → store in IDB → createSession
                                              └─ bad → IntegrityError (never stored)
```

### 4.2 `ChunkStore` (IndexedDB), `src/cache/chunkStore.js`

- **Two object stores:**
  - `blobs` maps sha256 → ArrayBuffer, written once per chunk version.
  - `meta` maps sha256 → `{name, precision, size, storedAt, lastUsed, hits}`, with an index on `lastUsed`.

  Splitting them means LRU bookkeeping on each read rewrites only a ~100-byte record, never the 14–91 MiB value.
- **Content addressing:** the key **is** the SHA-256 of the bytes. A new model version gets a new key automatically; old versions are never requested again and age out by LRU. There's no separate invalidation logic.
- **Budget:** `put()` first calls `evictToFit()`, which deletes the least-recently-used entries until the new chunk fits. A chunk larger than the whole budget is refused (`put` returns `false`, and the loader still works by going to the network).
- **Quota:** on `QuotaExceededError` it evicts the oldest entry and retries once; if that fails, it doesn't store.
- **Views:** `put()` stores a standalone buffer, so storing a `subarray` never accidentally stores its larger backing buffer (unit-tested).
- `storageInfo()` wraps `navigator.storage.estimate()`, `persisted()` and `persist()`.

### 4.3 `ChunkLoader`, `src/cache/chunkLoader.js`

`getBytes(entry)` tries memory, then IndexedDB, then the network, and returns `{bytes, source, timings, corruptEvicted}`. Integrity rules:

| Where the bytes came from | Size check | SHA-256 check | On failure |
|---|---|---|---|
| Network | always | **always**, before storing | `IntegrityError`; nothing is stored |
| IndexedDB | always | if `verifyOnRead` (default **true**, F-25) | entry deleted, falls through to the network |
| Memory | — | — | (bytes were verified when they entered memory) |

### 4.4 Cache inside the Workers, `chunkWorker.js` (opt-in)

`load` accepts an optional `cache: {dbName, budgetBytes, verifyOnRead}`. IndexedDB, `fetch` and WebCrypto all exist inside Workers, so **the Worker obtains, verifies and stores its own bytes**, and model bytes still never touch the page. Without `cache`, the code path is exactly Phase 3's, as the regression run confirms.

### 4.5 `WorkerPool` (hot tier) and `PooledChainRunner`

- `acquire(entry)` is a **hit** (zero load cost) if a Worker for that chunk and precision is alive.
- **On a miss,** the pool first estimates the new Worker's heap. It uses the last observed heap for that chunk, or, if the chunk has never been seen, `bytes × 3.5 + 20 MiB` (from the F-18 ratios). It evicts least-recently-used Workers until the estimate fits, then spawns.
- **Eviction is always `terminate()`,** which frees 100% (D-3).
- After spawning, it re-checks against the real heap. If a single chunk is bigger than the whole budget, the pool allows it (otherwise inference would be impossible) but counts it as `overBudget`. That never happened in these tests.

### 4.6 Experiment pages and harnesses

- `demo/phase4-cache.html` + `.js`: F1 single request (cold/warm), F3 corruption, F4 pool, F5 cost per tier, clear cache, storage info.
- `bench/phase4_browser_test.mjs`: **persistent browser profiles**, where each visit is a new browser process on the same on-disk profile. 26 gates per precision.
- `bench/throttledServer.mjs`: a separate server with a **shared bandwidth limit across all requests** plus per-request latency, applied only to `.onnx` files. Unlike DevTools throttling, it also limits the Workers' downloads. The baseline `demo/server.mjs` is unchanged.
- `bench/phase4_throttled_test.mjs`: H5 on a 20 Mbit/s / 40 ms link.

## 5. Detailed measurements

### 5.1 Cost of each tier per chunk (F5, page context, localhost)

| Chunk | Size | Network fetch | SHA-256 | Rate | IDB put | IDB read |
|---|---|---|---|---|---|---|
| int8 C0 | 22.7 MiB | 101 ms | 24 ms | 1.0 GB/s | 76 ms | 37 ms |
| int8 C1 / C2 | 13.6 MiB | 82 / 48 ms | 14 / 13 ms | 1.0 GB/s | 50 / 46 ms | 32 / 25 ms |
| int8 C3 | 14.2 MiB | 52 ms | 39 ms | 0.4 GB/s | 51 ms | 25 ms |
| fp32 C0 | 90.9 MiB | 330 ms | 115 ms | 0.8 GB/s | 333 ms | 149 ms |
| fp32 C1 / C2 | 54.1 MiB | 177 / 218 ms | 80 / 65 ms | 0.7–0.9 GB/s | 195 / 187 ms | 109 / 109 ms |
| fp32 C3 | 56.4 MiB | 181 ms | 68 ms | 0.9 GB/s | 282 ms | 93 ms |

### 5.2 Where a warm request's time goes (int8, visit 2, localhost, 2,188 ms total)

| Chunk | Bytes from IDB (read + verify) | Session creation | Worker start |
|---|---|---|---|
| C0 | 67 ms (42 + 23) | 375 ms | 32 ms |
| C1 | 40 ms (26 + 13) | 399 ms | 35 ms |
| C2 | 49 ms (33 + 13) | 418 ms | 78 ms |
| C3 | 42 ms (27 + 14) | 392 ms | 65 ms |

Session creation accounts for 1,584 ms of the 2,188 ms (**72%**). Bytes account for 198 ms (9%).

### 5.3 Why LRU fails here (F-24), worked example

With a 45 MiB disk budget and int8 chunks of 22.7 + 13.6 + 13.6 + 14.2 MiB, used in a fixed C0→C3 order:

1. Store C0, then C1 (36.3 MiB). C2 doesn't fit, so evict C0. C3 doesn't fit, so evict C1. **End of visit:** {C2, C3}.
2. Next visit: C0 misses, and storing it evicts C2. C1 misses and evicts C3. C2 misses and evicts C0, and so on.

Every lookup misses, on every visit. The store's final contents match the trace exactly: {C1, C2, C3} for int8 and {C2, C3} for fp32.

A "most-recently-used" eviction policy, or **pinning** a subset, would keep 2–3 chunks warm instead. Choosing that is a policy decision for Phase 5.

## 6. Technical decisions

| Decision | Alternatives | Why |
|---|---|---|
| **IndexedDB** for the persistent tier | Cache API, OPFS (Origin Private File System) | Available in Workers and every major browser, stores binary data, and supports transactions plus an index for LRU. The Cache API is keyed by URL rather than content, and OPFS has less mature support. |
| **Content-addressed by SHA-256** | Key by URL or name | Versioning for free; tampering is detectable; the manifest already has the hashes |
| **Separate `meta` store** | Rewrite the record on every access | LRU updates cost ~100 bytes instead of a 14–91 MiB rewrite |
| **Verify on read by default** | Size check only | Costs 5–20% of a load (F-25) and catches disk corruption or tampering (F3 test) |
| **Workers read the cache themselves** | Page reads IDB and transfers bytes | Model bytes never enter the page's JS heap (F-15) |
| **Cache is opt-in** in the Phase 3 Workers | Always on | Phase 3 behaviour and results stay reproducible; regression proves it |
| **Shared-bucket throttled server** | DevTools network throttling | DevTools throttling only applies to the page's own requests; the Workers' downloads (where the models load) need a limit that applies to them too |
| **Separate hot tier (`WorkerPool`) from byte caches** | Byte caches only | F-22: once bytes are cached, session creation is 63–72% of the cost, and only live Workers avoid it |

## 7. Why it matters for the project

Phase 4 changes the economics of the low-memory mode. Without it, one-chunk-at-a-time execution paid a full download for every request. With it, a returning user downloads **nothing**, and that mode costs ~2.2–2.9 s per request regardless of network speed. The data also points Phase 5 at the remaining costs:

- session creation, solved by keeping Workers alive while memory allows
- the LRU cyclic-access failure (F-24), solved by choosing what to keep

## 8. Files and components

**New**

| Path | Purpose |
|---|---|
| `packages/adaptive-onnx-loader/src/cache/memoryLRU.js` | Size-bounded LRU |
| `packages/adaptive-onnx-loader/src/cache/hash.js` | SHA-256 via WebCrypto |
| `packages/adaptive-onnx-loader/src/cache/chunkStore.js` | IndexedDB store |
| `packages/adaptive-onnx-loader/src/cache/chunkLoader.js` | Memory → IDB → network, with integrity checks |
| `packages/adaptive-onnx-loader/src/workers/workerPool.js` | Hot tier |
| `packages/adaptive-onnx-loader/src/workers/pooledChainRunner.js` | Chain on a pool |
| `packages/adaptive-onnx-loader/test/cache.test.mjs` | 9 unit tests |
| `demo/phase4-cache.html`, `demo/phase4-cache.js` | Experiment page |
| `bench/phase4_browser_test.mjs`, `bench/throttledServer.mjs`, `bench/phase4_throttled_test.mjs` | Harnesses |
| `results/phase4/cloud_{int8,fp32}.json`, `throttled_{int8,fp32}_20mbps.json`, `regression_phase{2,3}_after_phase4.json` | Evidence |

**Changed (additive only)**

| Path | Change |
|---|---|
| `src/workers/chunkWorker.js` | optional `cache` in `load` |
| `src/workers/workerChunk.js`, `src/workers/workerChainRunner.js` | pass the `cache` option through |
| `src/index.js` | 6 export lines |
| `packages/adaptive-onnx-loader/package.json` | dev dependency `fake-indexeddb 6.0.0` (exact version) |

**Baseline (Phase 2) files: unchanged.**

## 9. Validation summary

| # | Test | Result |
|---|---|---|
| V1 | Unit tests (`npm run test:unit`) | ✅ **17/17** (9 new) |
| V2 | int8 browser suite (NOCACHE, REVISIT, BUDGET × 2, CORRUPT, POOL, COST) | ✅ **26/26** |
| V3 | fp32 browser suite | ✅ **26/26** |
| V4 | Throttled 20 Mbit/s, int8 and fp32: outputs = reference, warm serves 0 bytes, warm faster | ✅ 3/3 + 3/3 |
| V5 | Phase 3 regression (A–E int8, cache off) | ✅ **23/23**, identical peaks (214.1 / 77.2 MiB) |
| V6 | Phase 2 baseline regression | ✅ 5/5 |

## 10. Issues, limitations and deviations

| ID | Item | Severity | Action |
|---|---|---|---|
| I-4.1 | **LRU's 0% hit rate under small budgets** (F-24) | Medium (design input) | Phase 5: choose between pinning, MRU eviction and chunk-major processing per profile |
| I-4.2 | **Session creation remains 63–72% of a warm request** (F-22) | Medium | Phase 5: keep Workers alive / pre-start them when memory allows |
| I-4.3 | `MemoryLRU` (the warm tier) is built and tested but **not used** in the Worker path, because a Worker dies with its memory | Low | Useful for main-thread use (`ChainRunner`); documented |
| I-4.4 | Throttling was tested at **one** link speed (20 Mbit/s) | Low | Phase 7: several network profiles |
| I-4.5 | The fp32 localhost no-cache anomaly (12.7 s, n = 1) | Low | Phase 7 repetitions |
| I-4.6 | `persist()` can't be granted in headless mode, so the cache may be evicted by the browser | Low | Documented; the loader recovers by re-downloading |
| I-4.7 | All Phase 4 numbers are cloud numbers | Medium | Optional Mac run of `demo/phase4-cache.html` (configuration MAC-CHROME-W1) |
| I-3.1 (carried) | No Phase 3 Mac data received yet | — | Paste JSONs when convenient |

No planned requirement was skipped.

## 11. Optional Mac check (~3 min)

Open **http://localhost:8080/demo/phase4-cache.html**, click **Clear cache**, then:

1. **F1** (runs the request twice). Expect `second.hitRate: 1` and `maxAbsDiffVsRef: 0`.
2. **Reload the page**, then **F1** again. Both runs should now come from `idb`.
3. **F3**. Expect `detected: true`, `refetchedFrom: "network"`, `storeRepaired: true`.

Then copy the JSON to me.

## 12. Next phase: Phase 5, resource monitor and decision engine (planned 17–20 Nov)

**Objective:** Choose automatically, per device and situation, **which chunks to run, at what precision, in which mode, and what to keep in memory**.

**Tasks:**

1. A resource monitor: `deviceMemory`, `hardwareConcurrency`, `connection.effectiveType`/`downlink`, `storage.estimate()`, and the live WASM heap, plus simulated profiles (Low / Mid / High) that override them.
2. A policy model with:
   - mode: FULL-resident / SEQUENTIAL / PIPELINED (prefetch the next chunk during compute) / EARLY_EXIT (τ tuned on the dev split, I-1.3)
   - per-chunk precision (I-1.1: C2 fp32)
   - heap budget
   - eviction strategy (LRU / pin / MRU, I-4.1)
   - pre-warming (I-4.2)
   - a `groupSize` limit for chunk-major processing (I-3.2)
3. Table-driven tests: every profile must produce the expected plan, and every plan must produce reference-identical (or documented early-exit) outputs.

**Viva topics coming:** how far browser resource signals can be trusted, rule-based vs cost-model policies, early exit, and pipelining.

---

## 13. Real-device results: configuration MAC-CHROME-W1 (31 Oct 2026)

**Kept separate from the cloud results above.** The setup is your Mac (Apple Silicon, `hardwareConcurrency` 8, `deviceMemory` 16), Chrome 155 in a normal window with default flags, 1 thread per chunk Worker, localhost (no throttling), run manually via §11.

Files: `results/phase4/mac/mac_{F1,F3,F4,F5}_{int8,fp32}.json`, transcribed from your chat paste. Two transcription notes, recorded in each file's `_provenance` field:

- The int8 F4 paste was missing its opening `{`, which I added.
- The two 60-entry budget-run timelines are condensed to a one-line summary.

All other values are exact.

### 13.1 Every correctness and integrity check passed on the real device

| Check | int8 | fp32 |
|---|---|---|
| F1 outputs = reference (Δ) | 0 / 0 | 0 / 0 |
| F1 warm request served from IndexedDB | hit rate 1 | hit rate 1 |
| F3 tampering detected → evicted → re-fetched → repaired; other 3 chunks from IDB | ✅ | ✅ |
| F4 pool outputs = reference | 0 | 0 |
| F4 pool within heap budget (120 / 450 MiB) | ✅ 91.63 MiB | ✅ 440.81 MiB |
| F5 all hashes match the manifest | ✅ | ✅ |

### 13.2 Cold vs warm on the Mac (localhost)

| | Cold | Warm | Speed-up | Warm: session creation | Warm: bytes (IDB read + verify) |
|---|---|---|---|---|---|
| int8 | 1,668 ms | **1,006 ms** | ×1.66 | 794 ms (**79%**) | 78 ms (8%) |
| fp32 | 3,086 ms | **1,584 ms** | ×1.95 | 1,042 ms (**66%**) | 381 ms (24%) |

Compared with the cloud on localhost (int8 ×1.11, fp32 ×1.6): the Mac creates sessions ~2× faster (182–281 ms vs 333–475 ms per chunk) and reads IndexedDB ~2–4× faster.

**F-22 holds on the real device:** session creation is still 66–79% of a warm request. Across both machines the range is **63–79%**.

### 13.3 Cost of each tier on the Mac (F5)

| Chunk | Fetch | SHA-256 | Rate | IDB put | IDB read |
|---|---|---|---|---|---|
| int8 C0 / C1 / C2 / C3 | 62 / 30 / 28 / 33 ms | 19 / 9 / 7 / 10 ms | 1.2–2.0 GB/s | 38 / 26 / 22 / 29 ms | 16 / 19 / 10 / 17 ms |
| fp32 C0 / C1 / C2 / C3 | 166 / 58 / 56 / 52 ms | 62 / 38 / 32 / 32 ms | 1.5–1.9 GB/s | 121 / 81 / 82 / 82 ms | 58 / 25 / 37 / 54 ms |

Hashing on the Mac runs at **1.2–2.0 GB/s**, about 1.5–2× the cloud's rate. Verify-on-read costs **3.7% (int8) / 10% (fp32)** of a warm request, which supports F-25.

### 13.4 Hot tier and the LRU failure on the Mac (F4)

| | Peak heap | Hits / misses | First sentence | Later sentences (derived†) |
|---|---|---|---|---|
| int8, unlimited | 214.06 MiB | 76 / 4 | 758 ms | ≈ 54.5 ms |
| int8, budget 120 MiB | 91.63 MiB | **0 / 40** | 735 ms | **788.8 ms mean (≈ 14.5× slower)** |
| fp32, unlimited | 813.31 MiB | 76 / 4 | 2,002 ms | ≈ 50.2 ms |
| fp32, budget 450 MiB | 440.81 MiB | **0 / 40** | 974 ms | **828.7 ms mean (≈ 16.5× slower)** |

† (mean × 20 − first) / 19, from `meanMsPerSentence` and `firstSentenceMs`.

**F-24 is confirmed on the real device:** 0% hits under a budget smaller than the working set. The slowdown is smaller than in the cloud (×14.5–16.5 vs ×29–33), because the Mac reloads a chunk ~2× faster.

On the Mac, the hot fp32 chain (≈ 50 ms per sentence) is as fast as int8 (≈ 55 ms) with 1 thread per Worker. This matches F-13: on this device, int8 saves memory and bytes, not time.

### 13.5 New finding F-27: WASM heap sizes are identical on both platforms

Every heap figure measured on the Mac equals the cloud's to the last reported digit, on a different OS, CPU architecture (arm64 vs x86-64) and Chrome build (155 vs Chromium 153):

| | Cloud (x86, Linux, headless) | Mac (arm64, macOS, Chrome) |
|---|---|---|
| sequential peak int8 / fp32 | 77.19 / 280.13 MiB | 77.19 / 280.13 MiB |
| resident pool int8 / fp32 | 214.06 / 813.31 MiB | 214.06 / 813.31 MiB |
| pool under budget int8 / fp32 | 91.63 / 440.81 MiB | 91.63 / 440.81 MiB |

So **memory results are reproducible across platforms; only times vary.** The Phase 7 memory results can therefore be generalised from the cloud, while timing results need the real device.

### 13.6 Open question (not a failure)

In the fp32 F4 "unlimited" run, the 4 chunks were loaded from the **network**, even though the earlier fp32 F1/F3/F5 runs had stored all of them. The run right after it served all 40 loads from IndexedDB. The JSON doesn't show why. One possibility is that "Clear cache" was clicked between runs, but I can't confirm that from the data, so it isn't being treated as a cache fault. **Did you clear the cache before the fp32 F4 run?**

### 13.7 Bugs found through your results (fixed)

| Bug | Effect | Fix | Verification |
|---|---|---|---|
| The page labelled the fp32 budget run `budget120MiB` although it used 450 MiB | Misleading key; the values (`budgetMiB: 450`) were correct | Key renamed to `budget` | Display only |
| `WorkerPool.terminateAll()` recorded each event **before** removing the Worker, so the timeline showed `liveWorkers: 4` while the heap counted down | Wrong `liveWorkers` in `terminated` events only; heap figures were correct | Remove first, then record | int8 suite re-run: **26/26**, timeline now 3 → 2 → 1 → 0 (`results/phase4/recheck_after_pool_fix_int8.json`) |

