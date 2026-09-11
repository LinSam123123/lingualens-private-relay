import assert from 'node:assert/strict';
import test from 'node:test';

import {
  CREDENTIAL_IDB_KEY,
  assertMozExtensionOrigin,
  canUsePersistentKeyStorage,
  createMemoryCredentialDriver,
  initializePersistentCredentialStore,
  isMozExtensionOrigin,
  probePersistentCredentialStore,
  readPersistentApiKey,
  requirePersistentKeyStorage,
  resetPersistentCredentialStoreForTests,
  writePersistentApiKey,
} from '../src/background/credential-idb.ts';
import {
  assertSecretModeAllowed,
  normalizeSecretStorageMode,
  otherSecretModes,
} from '../src/background/secret-policy.ts';

test.afterEach(() => {
  resetPersistentCredentialStoreForTests();
});

test('only moz-extension origins may own the persistent credential database', () => {
  assert.equal(isMozExtensionOrigin('moz-extension://addon-id'), true);
  assert.equal(isMozExtensionOrigin('chrome-extension://addon-id'), false);
  assert.equal(isMozExtensionOrigin('http://127.0.0.1:17891'), false);
  assert.equal(isMozExtensionOrigin('https://example.com'), false);
  assert.throws(() => assertMozExtensionOrigin('http://127.0.0.1:17891'), /CREDENTIAL_IDB_ORIGIN_INVALID/);
});

test('page origins do not enable persistent key storage', async () => {
  const driver = createMemoryCredentialDriver();
  assert.equal(await initializePersistentCredentialStore({
    origin: 'http://127.0.0.1:17891',
    driver,
  }), false);
  assert.equal(canUsePersistentKeyStorage(), false);
  assert.throws(() => requirePersistentKeyStorage(), /PERSISTENT_KEY_STORAGE_UNAVAILABLE/);
  assert.equal(await driver.get(CREDENTIAL_IDB_KEY), undefined);
});

test('probe writes are removed and do not use the API key record', async () => {
  const driver = createMemoryCredentialDriver();
  await probePersistentCredentialStore(driver);
  assert.equal(await driver.get('__probe__'), undefined);
  assert.equal(await driver.get(CREDENTIAL_IDB_KEY), undefined);
});

test('Firefox extension origin can save, read, replace, and clear a fake key', async () => {
  const driver = createMemoryCredentialDriver();
  assert.equal(await initializePersistentCredentialStore({
    origin: 'moz-extension://lingualens-private-relay',
    driver,
  }), true);
  await writePersistentApiKey('fake-key-aaaa');
  assert.equal(await readPersistentApiKey(), 'fake-key-aaaa');
  await writePersistentApiKey('fake-key-bbbb');
  assert.equal(await readPersistentApiKey(), 'fake-key-bbbb');
  assert.equal(await driver.get('__probe__'), undefined);
});

test('a failed replacement keeps the previous persistent key', async () => {
  const driver = createMemoryCredentialDriver();
  await initializePersistentCredentialStore({
    origin: 'moz-extension://lingualens-private-relay',
    driver,
  });
  await writePersistentApiKey('fake-key-keep');
  const originalPut = driver.put.bind(driver);
  driver.put = async (id, value) => {
    if (id === CREDENTIAL_IDB_KEY) throw new Error('disk full');
    return originalPut(id, value);
  };
  await assert.rejects(() => writePersistentApiKey('fake-key-lost'), /disk full/);
  driver.put = originalPut;
  assert.equal(await readPersistentApiKey(), 'fake-key-keep');
});

test('failed persistent writes do not enable unprotected local fallback', async () => {
  const driver = createMemoryCredentialDriver();
  driver.put = async () => {
    throw new Error('disk full');
  };
  assert.equal(await initializePersistentCredentialStore({
    origin: 'moz-extension://lingualens-private-relay',
    driver,
  }), false);
  assert.equal(canUsePersistentKeyStorage(), false);
  await assert.rejects(() => writePersistentApiKey('fake-key-cccc'), /PERSISTENT_KEY_STORAGE_UNAVAILABLE/);
});

test('secret mode policy never treats persistent as unprotected local', () => {
  assert.deepEqual(otherSecretModes('persistent'), ['session', 'local']);
  assert.throws(
    () => assertSecretModeAllowed('persistent', { local: false, persistent: false }),
    /PERSISTENT_KEY_STORAGE_UNAVAILABLE/,
  );
  assert.throws(
    () => assertSecretModeAllowed('local', { local: false, persistent: true }),
    /LOCAL_KEY_STORAGE_UNAVAILABLE/,
  );
  assert.equal(normalizeSecretStorageMode('persistent', { local: true, persistent: false }), 'session');
  assert.equal(normalizeSecretStorageMode('persistent', { local: false, persistent: true }), 'persistent');
  assert.equal(normalizeSecretStorageMode('local', { local: false, persistent: true }), 'session');
});
