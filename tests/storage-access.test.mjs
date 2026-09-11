import assert from 'node:assert/strict';
import test from 'node:test';

import {
  canUseExtensionPageStorage,
} from '../src/shared/extension-page.ts';
import {
  canUseLocalKeyStorage,
  requireLocalKeyStorage,
  resetStorageIsolationForTests,
  restrictStorageAccess,
} from '../src/background/storage-access.ts';

function makeArea({ setAccessLevel } = {}) {
  const area = {};
  if (setAccessLevel) area.setAccessLevel = setAccessLevel;
  return area;
}

test.afterEach(() => {
  resetStorageIsolationForTests();
  delete globalThis.browser;
  delete globalThis.chrome;
});

test('Chrome-like storage restriction marks local key storage available', async () => {
  const local = makeArea({ setAccessLevel: async () => {} });
  const session = makeArea({ setAccessLevel: async () => {} });
  const isolation = await restrictStorageAccess({ local, session });
  assert.equal(isolation.localRestricted, true);
  assert.equal(canUseLocalKeyStorage(), true);
  requireLocalKeyStorage();
});

test('Firefox-like missing setAccessLevel does not fail initialization', async () => {
  const isolation = await restrictStorageAccess({ local: makeArea(), session: makeArea() });
  assert.equal(isolation.localRestricted, false);
  assert.equal(isolation.sessionAvailable, true);
  assert.equal(canUseLocalKeyStorage(), false);
  assert.throws(() => requireLocalKeyStorage(), /LOCAL_KEY_STORAGE_UNAVAILABLE/);
});

test('uses browser.storage when chrome.storage is absent', async () => {
  globalThis.browser = { storage: { local: makeArea(), session: makeArea() } };
  const isolation = await restrictStorageAccess();
  assert.equal(isolation.localRestricted, false);
  assert.throws(() => requireLocalKeyStorage(), /LOCAL_KEY_STORAGE_UNAVAILABLE/);
});

test('fails closed when storage.local.setAccessLevel exists and rejects', async () => {
  const local = makeArea({
    setAccessLevel: async () => {
      throw new Error('unsupported');
    },
  });
  const session = makeArea({ setAccessLevel: async () => {} });
  await assert.rejects(() => restrictStorageAccess({ local, session }), /unsupported/);
  assert.equal(canUseLocalKeyStorage(), false);
});

test('refuses local keys before initialization completes', () => {
  assert.equal(canUseLocalKeyStorage(), false);
  assert.throws(() => requireLocalKeyStorage(), /LOCAL_KEY_STORAGE_UNAVAILABLE/);
});

test('content scripts are not treated as extension pages for storage access', () => {
  assert.equal(canUseExtensionPageStorage({ protocol: 'https:' }), false);
  assert.equal(canUseExtensionPageStorage({ protocol: 'http:' }), false);
  assert.equal(canUseExtensionPageStorage({ protocol: 'chrome-extension:' }), true);
  assert.equal(canUseExtensionPageStorage({ protocol: 'moz-extension:' }), true);
});
