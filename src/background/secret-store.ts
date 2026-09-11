import type { SecretStatus, SecretStorageMode } from '../shared/types';
import {
  deletePersistentApiKey,
  readPersistentApiKey,
  writePersistentApiKey,
  canUsePersistentKeyStorage,
} from './credential-idb';
import { assertSecretModeAllowed, otherSecretModes } from './secret-policy';
import { canUseLocalKeyStorage, requireLocalKeyStorage } from './storage-access';

const SECRET_KEY = 'relayApiKey';

function capabilities() {
  return {
    local: canUseLocalKeyStorage(),
    persistent: canUsePersistentKeyStorage(),
  };
}

function areaFor(mode: Exclude<SecretStorageMode, 'persistent'>) {
  return mode === 'session' ? browser.storage.session : browser.storage.local;
}

async function readFrom(mode: SecretStorageMode): Promise<string> {
  if (mode === 'persistent') {
    if (!canUsePersistentKeyStorage()) return '';
    return readPersistentApiKey();
  }
  if (mode === 'local' && !canUseLocalKeyStorage()) return '';
  const result = await areaFor(mode).get(SECRET_KEY);
  return typeof result[SECRET_KEY] === 'string' ? result[SECRET_KEY] : '';
}

async function writeTo(mode: SecretStorageMode, key: string): Promise<void> {
  assertSecretModeAllowed(mode, capabilities());
  if (mode === 'persistent') {
    await writePersistentApiKey(key);
    return;
  }
  if (mode === 'local') requireLocalKeyStorage();
  await areaFor(mode).set({ [SECRET_KEY]: key });
  const stored = await readFrom(mode);
  if (stored !== key) throw new Error('CREDENTIAL_STORE_VERIFY_FAILED');
}

async function deleteFrom(mode: SecretStorageMode): Promise<void> {
  if (mode === 'persistent') {
    try {
      await deletePersistentApiKey();
    } catch {
      if (canUsePersistentKeyStorage()) throw new Error('CREDENTIAL_IDB_DELETE_FAILED');
    }
    return;
  }
  await areaFor(mode).remove(SECRET_KEY);
}

export async function getApiKey(mode: SecretStorageMode): Promise<string> {
  return readFrom(mode);
}

export async function writeApiKey(key: string, mode: SecretStorageMode): Promise<void> {
  const normalized = key.trim();
  if (!normalized || normalized.length > 4096) throw new Error('API_KEY_INVALID');
  await writeTo(mode, normalized);
}

export async function clearOtherApiKeys(mode: SecretStorageMode): Promise<void> {
  for (const other of otherSecretModes(mode)) {
    await deleteFrom(other);
  }
}

export async function saveApiKey(key: string, mode: SecretStorageMode): Promise<void> {
  await writeApiKey(key, mode);
  await clearOtherApiKeys(mode);
}

export async function removeLocalApiKeyIfUnrestricted(): Promise<void> {
  if (canUseLocalKeyStorage()) return;
  await browser.storage.local.remove(SECRET_KEY);
}

export async function clearApiKey(): Promise<void> {
  await Promise.all(otherSecretModes('session').concat('session').map((mode) => deleteFrom(mode)));
}

export async function getSecretStatus(mode: SecretStorageMode): Promise<SecretStatus> {
  const key = await getApiKey(mode);
  return {
    hasKey: Boolean(key),
    storageMode: mode,
    localKeyStorageAvailable: canUseLocalKeyStorage(),
    persistentKeyStorageAvailable: canUsePersistentKeyStorage(),
    ...(key ? { maskedKey: `****${key.slice(-4)}` } : {}),
  };
}
