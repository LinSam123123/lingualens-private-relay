import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import { isOptionsSender, isOwnExtensionSender, isTranslateRequest } from '../src/background/message-policy.ts';
import { endpointUrl, validateBaseUrl } from '../src/shared/url-policy.ts';

test('base URL policy accepts HTTPS and exact loopback HTTP origins', () => {
  assert.equal(validateBaseUrl('https://relay.example.invalid/v1/').baseUrl, 'https://relay.example.invalid/v1');
  assert.equal(validateBaseUrl('http://127.0.0.1:8080/v1').permissionOrigin, 'http://127.0.0.1:8080/*');
  assert.equal(endpointUrl('https://relay.example.invalid/v1', '/models'), 'https://relay.example.invalid/v1/models');
});

test('base URL policy rejects unsafe or ambiguous components', () => {
  for (const value of [
    'http://example.com/v1',
    'file:///tmp/api',
    'https://user:pass@example.com/v1',
    'https://example.com/v1?tenant=secret',
    'https://example.com/v1#fragment',
  ]) {
    assert.throws(() => validateBaseUrl(value));
  }
});

test('message sender policy restricts options-only operations', () => {
  const extensionId = 'extension-id';
  assert.equal(isOwnExtensionSender({ id: extensionId, tab: { id: 1 } }, extensionId), true);
  assert.equal(isOwnExtensionSender({ id: 'other' }, extensionId), false);
  assert.equal(isOptionsSender({ id: extensionId, url: 'chrome-extension://extension-id/options.html' }, extensionId), true);
  assert.equal(isOptionsSender({ id: extensionId, url: 'chrome-extension://extension-id/popup.html' }, extensionId), false);
});

test('Firefox options sender is recognized by options.html path', () => {
  const extensionId = 'extension-id';
  assert.equal(
    isOptionsSender({ id: extensionId, url: 'moz-extension://extension-id/options.html' }, extensionId),
    true,
  );
});

test('Firefox preview manifest requests websiteContent instead of claiming no transmission', async () => {
  const config = await readFile(new URL('../wxt.config.ts', import.meta.url), 'utf8');
  assert.match(config, /optional_permissions: optionalOrigins/);
  assert.match(config, /required: \['websiteContent'\]/);
  assert.equal(/required:\s*\[[^\]]*['"]none['"]/.test(config), false);
  assert.match(config, /browser === 'firefox'\s*\?\s*\['storage', 'activeTab', 'contextMenus'\]/);

  try {
    const manifest = JSON.parse(
      await readFile(new URL('../.output/firefox-mv2/manifest.json', import.meta.url), 'utf8'),
    );
    assert.deepEqual(manifest.permissions, ['storage', 'activeTab', 'contextMenus']);
    assert.deepEqual(manifest.optional_permissions, [
      'https://*/*',
      'http://localhost/*',
      'http://127.0.0.1/*',
    ]);
    assert.equal(manifest.permissions.includes('scripting'), false);
    assert.deepEqual(
      manifest.browser_specific_settings?.gecko?.data_collection_permissions,
      { required: ['websiteContent'] },
    );
  } catch (error) {
    if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') return;
    throw error;
  }
});

test('translation payload validation enforces required fields and limits', () => {
  assert.equal(isTranslateRequest({ text: 'hello', sourceLang: 'auto', targetLang: 'zh-CN' }), true);
  assert.equal(isTranslateRequest({ text: '', sourceLang: 'auto', targetLang: 'zh-CN' }), false);
  assert.equal(isTranslateRequest({ text: 'x'.repeat(100_001), sourceLang: 'auto', targetLang: 'zh-CN' }), false);
});
