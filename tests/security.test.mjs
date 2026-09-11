import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import { isOptionsSender, isOwnExtensionSender, isTranslateRequest } from '../src/background/message-policy.ts';
import { isOrdinaryHttpTabUrl } from '../src/shared/translatable-tab.ts';
import {
  endpointUrl,
  hostPermissionOrigins,
  hostPermissionPattern,
  hostPermissionQuery,
  validateBaseUrl,
} from '../src/shared/url-policy.ts';

test('base URL policy accepts HTTPS and exact loopback HTTP origins', () => {
  assert.equal(validateBaseUrl('https://relay.example.invalid/v1/').baseUrl, 'https://relay.example.invalid/v1');
  assert.equal(validateBaseUrl('http://127.0.0.1:8080/v1').permissionOrigin, 'http://127.0.0.1:8080/*');
  assert.equal(endpointUrl('https://relay.example.invalid/v1', '/models'), 'https://relay.example.invalid/v1/models');
});

test('Chrome host permission patterns keep non-default ports', () => {
  assert.equal(hostPermissionPattern('http://127.0.0.1:17891/ok/v1', 'chrome'), 'http://127.0.0.1:17891/*');
  assert.equal(hostPermissionPattern('https://relay.example.invalid:8443/v1', 'chrome'), 'https://relay.example.invalid:8443/*');
  assert.deepEqual(hostPermissionQuery('http://127.0.0.1:17891/ok/v1', 'chrome'), {
    origins: ['http://127.0.0.1:17891/*'],
  });
});

test('Firefox host permission patterns omit ports but fetch URLs keep them', () => {
  const saved = validateBaseUrl('http://127.0.0.1:17891/ok/v1');
  assert.equal(saved.baseUrl, 'http://127.0.0.1:17891/ok/v1');
  assert.equal(endpointUrl(saved.baseUrl, 'chat/completions'), 'http://127.0.0.1:17891/ok/v1/chat/completions');
  assert.equal(hostPermissionPattern(saved.baseUrl, 'firefox'), 'http://127.0.0.1/*');
  assert.equal(hostPermissionPattern('http://localhost:17891/ok/v1', 'firefox'), 'http://localhost/*');
  assert.equal(hostPermissionPattern('https://relay.example.invalid:8443/v1', 'firefox'), 'https://relay.example.invalid/*');
  assert.deepEqual(hostPermissionQuery('http://127.0.0.1:17891/ok/v1', 'firefox'), {
    origins: ['http://127.0.0.1/*'],
  });
  assert.deepEqual(
    hostPermissionQuery('http://127.0.0.1:17891/ok/v1', 'firefox'),
    hostPermissionQuery('http://127.0.0.1:9/ok/v1', 'firefox'),
  );
  assert.notDeepEqual(
    hostPermissionQuery('http://127.0.0.1:17891/ok/v1', 'chrome'),
    hostPermissionQuery('http://127.0.0.1:9/ok/v1', 'chrome'),
  );
  assert.deepEqual(hostPermissionOrigins('http://127.0.0.1/*'), { origins: ['http://127.0.0.1/*'] });
});

test('host permission queries never request all hosts', () => {
  for (const browser of ['chrome', 'firefox']) {
    const query = hostPermissionQuery('http://127.0.0.1:17891/ok/v1', browser);
    assert.equal(query.origins.includes('https://*/*'), false);
    assert.equal(query.origins.includes('<all_urls>'), false);
    assert.equal(query.origins.includes('http://*/*'), false);
  }
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
  assert.equal(
    isOptionsSender({
      id: extensionId,
      tab: { id: 1 },
      url: 'http://127.0.0.1:17891/fixture',
    }, extensionId),
    false,
  );
});

test('Firefox preview manifest requests websiteContent instead of claiming no transmission', async () => {
  const config = await readFile(new URL('../wxt.config.ts', import.meta.url), 'utf8');
  assert.match(config, /optional_permissions: optionalOrigins/);
  assert.match(config, /required: \['websiteContent'\]/);
  assert.match(config, /id: 'lingualens-private-relay@local'/);
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
    assert.equal(manifest.browser_specific_settings?.gecko?.id, 'lingualens-private-relay@local');
    assert.equal(manifest.browser_specific_settings?.gecko?.strict_min_version, '140.0');
    assert.equal('update_url' in manifest, false);
    assert.deepEqual(
      manifest.browser_specific_settings?.gecko?.data_collection_permissions,
      { required: ['websiteContent'] },
    );
    const loopback = hostPermissionQuery('http://127.0.0.1:17891/ok/v1', 'firefox').origins[0];
    assert.equal(manifest.optional_permissions.includes(loopback), true);
    assert.equal(manifest.optional_permissions.includes('http://127.0.0.1:17891/*'), false);
  } catch (error) {
    if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') return;
    throw error;
  }
});

test('ordinary http tab URLs exclude settings pages and do not guess a tab', () => {
  assert.equal(isOrdinaryHttpTabUrl('http://127.0.0.1:17891/fixture'), true);
  assert.equal(isOrdinaryHttpTabUrl('https://example.com/path'), true);
  assert.equal(isOrdinaryHttpTabUrl('moz-extension://addon-id/options.html'), false);
  assert.equal(isOrdinaryHttpTabUrl('about:debugging'), false);
  assert.equal(isOrdinaryHttpTabUrl(undefined), false);
});

test('secret status is options-only and no message returns a raw API key', async () => {
  const router = await readFile(new URL('../src/background/message-router.ts', import.meta.url), 'utf8');
  const types = await readFile(new URL('../src/shared/types.ts', import.meta.url), 'utf8');
  assert.match(router, /case 'GET_SECRET_STATUS':\s*\{[\s\S]*?OPTIONS_ONLY/);
  assert.match(router, /case 'PROBE_CONTENT_SCRIPT_ISOLATION':\s*\{[\s\S]*?OPTIONS_ONLY/);
  assert.match(router, /UNSUPPORTED_TAB/);
  assert.match(router, /CONTENT_SCRIPT_MISSING/);
  assert.match(router, /publicCredentialIsolationProbe/);
  const options = await readFile(new URL('../src/entrypoints/options/App.tsx', import.meta.url), 'utf8');
  assert.equal(/lastFocusedWindow/.test(options), false);
  assert.match(options, /probeTabId/);
  assert.equal(/GET_API_KEY/.test(router), false);
  assert.equal(/GET_API_KEY/.test(types), false);
  assert.match(router, /stripSecrets/);
});

test('translation payload validation enforces required fields and limits', () => {
  assert.equal(isTranslateRequest({ text: 'hello', sourceLang: 'auto', targetLang: 'zh-CN' }), true);
  assert.equal(isTranslateRequest({ text: '', sourceLang: 'auto', targetLang: 'zh-CN' }), false);
  assert.equal(isTranslateRequest({ text: 'x'.repeat(100_001), sourceLang: 'auto', targetLang: 'zh-CN' }), false);
});
