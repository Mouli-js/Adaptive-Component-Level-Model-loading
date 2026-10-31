// Cache-layer unit tests: MemoryLRU, sha256Hex, ChunkStore (fake-indexeddb), ChunkLoader tiers + integrity.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { IDBFactory } from 'fake-indexeddb';
import { MemoryLRU } from '../src/cache/memoryLRU.js';
import { sha256Hex } from '../src/cache/hash.js';
import { ChunkStore } from '../src/cache/chunkStore.js';
import { ChunkLoader, IntegrityError } from '../src/cache/chunkLoader.js';

const bytesOf = (n, seed) => Uint8Array.from({ length: n }, (_, i) => (i * 31 + seed) & 255);
const sleep = ms => new Promise(r => setTimeout(r, ms));
async function entryFor(name, bytes) { return { name, precision: 'int8', url: `https://x/${name}`, bytes: bytes.byteLength, sha256: await sha256Hex(bytes) }; }
function fakeFetch(files) {
  const f = async u => { f.calls.push(u); const b = files[u]; return b ? { ok: true, arrayBuffer: async () => b.slice().buffer } : { ok: false, status: 404 }; };
  f.calls = []; return f;
}

test('sha256Hex matches a known vector', async () => {
  assert.equal(await sha256Hex(new TextEncoder().encode('abc')), 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
});

test('MemoryLRU evicts least-recently-used first and respects the budget', () => {
  const c = new MemoryLRU(10);
  c.set('a', new Uint8Array(4)); c.set('b', new Uint8Array(4));
  c.get('a');                                   // a is now most recent
  c.set('c', new Uint8Array(4));                // 12 > 10 -> evict LRU = b
  assert.deepEqual(c.keys(), ['a', 'c']); assert.equal(c.size, 8); assert.equal(c.stats.evictions, 1);
  assert.equal(c.set('big', new Uint8Array(11)), false);          // larger than budget: rejected
  assert.equal(c.size, 8);
});

test('ChunkStore put/get/has/delete round-trip, usage and LRU bookkeeping', async () => {
  const s = await ChunkStore.open({ indexedDB: new IDBFactory() });
  const b = bytesOf(1000, 1), sha = await sha256Hex(b);
  assert.equal(await s.get(sha), null);
  assert.equal(await s.put(sha, b, { name: 'c0', precision: 'int8' }), true);
  assert.equal(await s.has(sha), true); assert.equal(await s.usage(), 1000);
  const got = await s.get(sha);
  assert.deepEqual([...got.bytes], [...b]); assert.equal(got.meta.name, 'c0');
  assert.equal((await s.list())[0].hits, 1);
  await s.delete(sha); assert.equal(await s.has(sha), false);
});

test('ChunkStore stores a view correctly (not its whole backing buffer)', async () => {
  const s = await ChunkStore.open({ indexedDB: new IDBFactory() });
  const big = bytesOf(100, 7), view = big.subarray(10, 30);
  await s.put('v', view);
  assert.deepEqual([...(await s.get('v')).bytes], [...view]);
});

test('ChunkStore budget evicts least-recently-used entries, rejects oversize', async () => {
  const s = await ChunkStore.open({ indexedDB: new IDBFactory(), budgetBytes: 2500 });
  await s.put('a', bytesOf(1000, 1)); await sleep(5);
  await s.put('b', bytesOf(1000, 2)); await sleep(5);
  await s.get('a'); await sleep(5);                     // a becomes most recent
  await s.put('c', bytesOf(1000, 3));                   // 3000 > 2500 -> evict LRU = b
  assert.deepEqual((await s.list()).map(m => m.sha256).sort(), ['a', 'c']);
  assert.equal(s.stats.evictions, 1);
  assert.equal(await s.put('huge', bytesOf(3000, 4)), false);
  assert.equal(await s.usage(), 2000);
});

test('ChunkLoader: network (verified + stored) -> IndexedDB -> memory', async () => {
  const b = bytesOf(5000, 9), e = await entryFor('c1', b);
  const store = await ChunkStore.open({ indexedDB: new IDBFactory() });
  const f = fakeFetch({ [e.url]: b });
  const L = new ChunkLoader({ store, memory: new MemoryLRU(1e6), fetchImpl: f });
  const r1 = await L.getBytes(e); assert.equal(r1.source, 'network'); assert.equal(r1.timings.stored, true);
  const r2 = await L.getBytes(e); assert.equal(r2.source, 'memory');
  const L2 = new ChunkLoader({ store, fetchImpl: f });          // "new visit": empty memory tier
  const r3 = await L2.getBytes(e); assert.equal(r3.source, 'idb'); assert.deepEqual([...r3.bytes], [...b]);
  assert.equal(f.calls.length, 1);                              // network used exactly once
});

test('ChunkLoader: corrupted IndexedDB entry is detected, evicted and re-fetched', async () => {
  const b = bytesOf(4096, 3), e = await entryFor('c2', b);
  const store = await ChunkStore.open({ indexedDB: new IDBFactory() });
  const bad = b.slice(); bad[100] ^= 0xff;                       // same size, one flipped byte
  await store.put(e.sha256, bad);
  const f = fakeFetch({ [e.url]: b });
  const r = await new ChunkLoader({ store, fetchImpl: f }).getBytes(e);
  assert.equal(r.source, 'network'); assert.equal(r.corruptEvicted, true);
  assert.deepEqual([...(await store.get(e.sha256)).bytes], [...b]);   // replaced with the good copy
});

test('ChunkLoader: verifyOnRead=false skips hashing on reads (size still checked)', async () => {
  const b = bytesOf(4096, 5), e = await entryFor('c3', b);
  const store = await ChunkStore.open({ indexedDB: new IDBFactory() });
  const bad = b.slice(); bad[0] ^= 1; await store.put(e.sha256, bad);
  const r = await new ChunkLoader({ store, fetchImpl: fakeFetch({ [e.url]: b }), verifyOnRead: false }).getBytes(e);
  assert.equal(r.source, 'idb');                                 // documented trade-off: corruption not detected
  await store.put('short', b.subarray(0, 10));
  const r2 = await new ChunkLoader({ store, fetchImpl: fakeFetch({ [e.url]: b }), verifyOnRead: false })
    .getBytes({ ...e, sha256: 'short' }).catch(x => x);
  assert.ok(r2 instanceof IntegrityError);                       // wrong size -> refetch -> hash mismatch vs key
});

test('ChunkLoader: a bad network download is rejected and never cached', async () => {
  const b = bytesOf(2048, 1), e = await entryFor('c4', b);
  const store = await ChunkStore.open({ indexedDB: new IDBFactory() });
  const evil = b.slice(); evil[5] ^= 1;
  await assert.rejects(new ChunkLoader({ store, fetchImpl: fakeFetch({ [e.url]: evil }) }).getBytes(e), IntegrityError);
  assert.equal(await store.has(e.sha256), false);
});
