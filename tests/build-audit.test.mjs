import assert from 'node:assert/strict';
import test from 'node:test';
import { auditManifest } from '../scripts/build-audit-policy.mjs';

function firefoxManifest() {
  return {
    manifest_version: 2,
    permissions: ['storage', 'activeTab', 'contextMenus'],
    optional_permissions: ['https://*/*', 'http://localhost/*', 'http://127.0.0.1/*'],
    background: { scripts: ['background.js'] },
    sidebar_action: { default_panel: 'sidepanel.html' },
    browser_action: { default_popup: 'popup.html' },
    options_ui: { page: 'options.html' },
    browser_specific_settings: {
      gecko: {
        id: 'lingualens-private-relay@local',
        strict_min_version: '140.0',
        data_collection_permissions: { required: ['websiteContent'] },
      },
    },
  };
}

test('accepts Firefox MV2 with stable identity and honest data declaration', () => {
  auditManifest(firefoxManifest(), 'firefox');
});

test('rejects Firefox identity, permission, background and declaration regressions', () => {
  const mutations = [
    (m) => { m.browser_specific_settings.gecko.id = 'changed@local'; },
    (m) => { m.permissions.push('https://*/*'); },
    (m) => { m.optional_permissions = ['<all_urls>']; },
    (m) => { m.background = { service_worker: 'background.js' }; },
    (m) => { m.browser_specific_settings.gecko.data_collection_permissions.required = ['none']; },
    (m) => { m.browser_specific_settings.gecko.update_url = 'https://example.com/update'; },
    (m) => { m.sidebar_action.default_panel = 'missing.html'; },
  ];
  for (const mutate of mutations) {
    const manifest = firefoxManifest();
    mutate(manifest);
    assert.throws(() => auditManifest(manifest, 'firefox'));
  }
});

test('retains Chrome MV3 audit and rejects unsupported audit targets', () => {
  auditManifest({
    manifest_version: 3,
    optional_host_permissions: firefoxManifest().optional_permissions,
  }, 'chrome');
  assert.throws(() => auditManifest(firefoxManifest(), 'edge'));
});
