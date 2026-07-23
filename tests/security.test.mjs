import assert from 'node:assert/strict';
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

test('translation payload validation enforces required fields and limits', () => {
  assert.equal(isTranslateRequest({ text: 'hello', sourceLang: 'auto', targetLang: 'zh-CN' }), true);
  assert.equal(isTranslateRequest({ text: '', sourceLang: 'auto', targetLang: 'zh-CN' }), false);
  assert.equal(isTranslateRequest({ text: 'x'.repeat(100_001), sourceLang: 'auto', targetLang: 'zh-CN' }), false);
});
