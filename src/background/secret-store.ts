import type { SecretStatus, SecretStorageMode } from '../shared/types';
import { canUseLocalKeyStorage, requireLocalKeyStorage } from './storage-access';

const SECRET_KEY = 'relayApiKey';

function areaFor(mode: SecretStorageMode) {
  return mode === 'session' ? browser.storage.session : browser.storage.local;
}

export async function getApiKey(mode: SecretStorageMode): Promise<string> {
  if (mode === 'local' && !canUseLocalKeyStorage()) return '';
  const result = await areaFor(mode).get(SECRET_KEY);
  return typeof result[SECRET_KEY] === 'string' ? result[SECRET_KEY] : '';
}

export async function saveApiKey(key: string, mode: SecretStorageMode): Promise<void> {
  const normalized = key.trim();
  if (!normalized || normalized.length > 4096) throw new Error('API_KEY_INVALID');
  if (mode === 'local') requireLocalKeyStorage();
  const other = mode === 'session' ? browser.storage.local : browser.storage.session;
  await areaFor(mode).set({ [SECRET_KEY]: normalized });
  await other.remove(SECRET_KEY);
}

export async function removeLocalApiKeyIfUnrestricted(): Promise<void> {
  if (canUseLocalKeyStorage()) return;
  await browser.storage.local.remove(SECRET_KEY);
}

export async function clearApiKey(): Promise<void> {
  await Promise.all([
    browser.storage.session.remove(SECRET_KEY),
    browser.storage.local.remove(SECRET_KEY),
  ]);
}

export async function getSecretStatus(mode: SecretStorageMode): Promise<SecretStatus> {
  const key = await getApiKey(mode);
  return {
    hasKey: Boolean(key),
    storageMode: mode,
    localKeyStorageAvailable: canUseLocalKeyStorage(),
    ...(key ? { maskedKey: `****${key.slice(-4)}` } : {}),
  };
}
