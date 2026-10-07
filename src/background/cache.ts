import type { TranslateResult } from '../shared/types';

interface CacheEntry {
  result: TranslateResult;
  accessedAt: number;
}

const STORAGE_KEY = 'translationCache';
const MAX_ENTRIES = 1000;
// Leave session storage headroom for credentials, task journals and navigation state.
const MAX_CACHE_BYTES = 1024 * 1024;
const PERSIST_DEBOUNCE_MS = 3000;

let memoryCache: Map<string, CacheEntry> | null = null;
let persistTimer: ReturnType<typeof setTimeout> | null = null;
let dirty = false;
let loading: Promise<Map<string, CacheEntry>> | null = null;
let generation = 0;
let storageQueue: Promise<void> = Promise.resolve();

export function cacheGeneration(): number { return generation; }

function serializeStorage(operation: () => Promise<void>): Promise<void> {
  const next = storageQueue.then(operation);
  storageQueue = next.catch(() => undefined);
  return next;
}

async function getMemoryCache(): Promise<Map<string, CacheEntry>> {
  if (memoryCache) return memoryCache;
  if (loading) return loading;
  const epoch = generation;
  const operation = (async () => {
    const data = await browser.storage.session.get(STORAGE_KEY).catch(() => ({} as Record<string, unknown>));
    if (epoch !== generation) return memoryCache ?? new Map<string, CacheEntry>();
    const raw = data[STORAGE_KEY];
    const entries = raw && typeof raw === 'object' ? Object.entries(raw) : [];
    memoryCache = new Map(entries.filter((entry): entry is [string, CacheEntry] => {
      const value = entry[1] as CacheEntry | null;
      return Boolean(value && typeof value.result?.translated === 'string'
        && value.result.translated.trim() && Number.isFinite(value.accessedAt));
    }));
    evict(memoryCache);
    if (entries.length) dirty = true;
    return memoryCache;
  })();
  loading = operation;
  try { return await operation; }
  finally { if (loading === operation) loading = null; }
}

function isQuotaError(err: unknown): boolean {
  return err instanceof Error && /quota/i.test(err.message);
}

async function flushCache(): Promise<void> {
  const epoch = generation;
  await serializeStorage(async () => {
    if (epoch !== generation || !dirty || !memoryCache) return;
    dirty = false;
    evict(memoryCache);
    try {
      await browser.storage.session.set({
        [STORAGE_KEY]: Object.fromEntries(memoryCache),
      });
    } catch (err) {
      // Cache is expendable; remove its old snapshot rather than crowd out task journals.
      if (isQuotaError(err)) await browser.storage.session.remove(STORAGE_KEY).catch(() => undefined);
    }
  });
}

export async function prepareTranslationCache(): Promise<void> {
  await getMemoryCache();
  await flushCache();
}

function schedulePersist(): void {
  if (persistTimer) return;
  dirty = true;
  persistTimer = setTimeout(() => {
    persistTimer = null;
    void flushCache();
  }, PERSIST_DEBOUNCE_MS);
}

/**
 * FNV-1a dual hash: two independent 32-bit hashes combined into a 64-bit key.
 * Collision probability ~2.7 × 10⁻¹⁴ for 1000 entries — effectively zero.
 * Same O(n) cost as a single hashCode, no async overhead.
 */
function makeKey(text: string, sourceLang: string, targetLang: string, providerId: string): string {
  const input = `${text}|${sourceLang}|${targetLang}|${providerId}`;
  let h1 = 0x811c9dc5;
  let h2 = 0xc58f1a7b;
  for (let i = 0; i < input.length; i++) {
    const c = input.charCodeAt(i);
    h1 = Math.imul((h1 ^ c), 0x01000193);
    h2 = Math.imul((h2 ^ ((c >>> 8) | ((c & 0xff) << 24))), 0x01000193);
  }
  return `c_${(h1 >>> 0).toString(36)}_${(h2 >>> 0).toString(36)}`;
}

function evict(cache: Map<string, CacheEntry>): void {
  const entries = [...cache.entries()].sort(
    (a, b) => a[1].accessedAt - b[1].accessedAt,
  );
  // Conservative UTF-16 estimate includes serialization and per-entry overhead.
  const sizes = entries.map(([key, value]) => 2 * (key.length + JSON.stringify(value).length) + 128);
  let bytes = sizes.reduce((sum, size) => sum + size, 0);
  for (let i = 0; i < entries.length && (cache.size > MAX_ENTRIES || bytes > MAX_CACHE_BYTES); i++) {
    const [key] = entries[i];
    cache.delete(key);
    bytes -= sizes[i];
  }
}

export async function getCached(
  text: string,
  sourceLang: string,
  targetLang: string,
  providerId: string,
): Promise<TranslateResult | null> {
  const cache = await getMemoryCache();
  const key = makeKey(text, sourceLang, targetLang, providerId);
  const entry = cache.get(key);
  if (!entry) return null;

  entry.accessedAt = Date.now();
  schedulePersist();

  return { ...entry.result, cached: true };
}

export async function setCache(
  text: string,
  sourceLang: string,
  targetLang: string,
  providerId: string,
  result: TranslateResult,
  expectedGeneration = generation,
): Promise<void> {
  const epoch = expectedGeneration;
  if (epoch !== generation) return;
  const cache = await getMemoryCache();
  if (epoch !== generation || !result.translated?.trim()) return;
  const key = makeKey(text, sourceLang, targetLang, providerId);

  cache.set(key, { result, accessedAt: Date.now() });
  evict(cache);
  schedulePersist();
}

export async function clearCache(): Promise<void> {
  generation++;
  loading = null;
  memoryCache = new Map();
  dirty = false;
  if (persistTimer) {
    clearTimeout(persistTimer);
    persistTimer = null;
  }
  await serializeStorage(() => browser.storage.session.remove(STORAGE_KEY));
}

export async function getCacheStats(): Promise<{ size: number; maxSize: number }> {
  const cache = await getMemoryCache();
  return { size: cache.size, maxSize: MAX_ENTRIES };
}
