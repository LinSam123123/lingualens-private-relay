import assert from 'node:assert/strict';
import test from 'node:test';

let moduleId = 0;
async function setup(initial = {}) {
  const stored = structuredClone(initial);
  const stats = { reads: 0, writes: 0 };
  const session = {
    async get(key) { stats.reads++; return { [key]: structuredClone(stored[key]) }; },
    async set(value) { stats.writes++; Object.assign(stored, structuredClone(value)); },
    async remove(key) { delete stored[key]; },
  };
  globalThis.browser = { storage: { session } };
  const cache = await import(`../src/background/cache.ts?test=${++moduleId}`);
  return { cache, stored, stats, session };
}
const value = { translated: 'translated', provider: 'relay', cached: false };

test('a translation dispatched before clear cannot repopulate the cleared cache', async () => {
  const { cache } = await setup();
  const oldEpoch = cache.cacheGeneration();
  await cache.clearCache();
  await cache.setCache('hello', 'en', 'zh', 'relay', value, oldEpoch);
  assert.equal(await cache.getCached('hello', 'en', 'zh', 'relay'), null);
  await cache.setCache('hello', 'en', 'zh', 'relay', value, cache.cacheGeneration());
  assert.equal((await cache.getCached('hello', 'en', 'zh', 'relay')).translated, 'translated');
  await cache.clearCache();
});

test('concurrent cold-cache lookups share one load and clear wins over a pending load', async () => {
  const { cache, session, stored, stats } = await setup();
  const oldGet = session.get;
  let release;
  session.get = async (key) => { const data = await oldGet(key); await new Promise((r) => { release = r; }); return data; };
  const reads = Promise.all(Array.from({ length: 20 }, () => cache.getCached('hello', 'en', 'zh', 'relay')));
  await Promise.resolve();
  await cache.clearCache();
  release();
  assert.deepEqual(await reads, Array(20).fill(null));
  assert.equal(stats.reads, 1);
  assert.equal((await cache.getCacheStats()).size, 0);
  assert.equal(stored.translationCache, undefined);
});

test('byte eviction trims an old large snapshot before journals need storage', async () => {
  const entries = Object.fromEntries(Array.from({ length: 20 }, (_, i) => [`c_${i}`, {
    result: { ...value, translated: 'x'.repeat(100_000) }, accessedAt: i,
  }]));
  const { cache, stored } = await setup({ translationCache: entries, relayTaskJournal: { sentinel: true } });
  await cache.prepareTranslationCache();
  assert.ok(JSON.stringify(stored.translationCache).length * 2 < 1024 * 1024);
  assert.ok((await cache.getCacheStats()).size < 20);
  assert.deepEqual(stored.relayTaskJournal, { sentinel: true });
  await cache.clearCache();
});

test('quota pressure drops only the expendable snapshot and keeps memory translations', async () => {
  const { cache, stored, session } = await setup({
    translationCache: { old: { result: value, accessedAt: 1 } },
    relayTaskJournal: { sentinel: true }, secret: 'fake-only',
  });
  await cache.setCache('hello', 'en', 'zh', 'relay', value);
  session.set = async () => { throw new Error('QUOTA_BYTES exceeded'); };
  await cache.prepareTranslationCache();
  assert.equal(stored.translationCache, undefined);
  assert.equal((await cache.getCached('hello', 'en', 'zh', 'relay')).translated, 'translated');
  assert.deepEqual(stored.relayTaskJournal, { sentinel: true });
  assert.equal(stored.secret, 'fake-only');
  await cache.clearCache();
});

test('clear waits for an in-flight persist and cannot resurrect its snapshot', async () => {
  const { cache, session, stored } = await setup();
  await cache.setCache('hello', 'en', 'zh', 'relay', value);
  let release;
  const original = session.set;
  session.set = async (value) => { await new Promise((resolve) => { release = resolve; }); await original(value); };
  const flush = cache.prepareTranslationCache();
  for (let i = 0; i < 10 && !release; i++) await Promise.resolve();
  assert.ok(release);
  const clear = cache.clearCache();
  release();
  await Promise.all([flush, clear]);
  assert.equal(stored.translationCache, undefined);
  assert.equal(await cache.getCached('hello', 'en', 'zh', 'relay'), null);
});
