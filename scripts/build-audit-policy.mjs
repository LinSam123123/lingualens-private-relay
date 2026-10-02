import assert from 'node:assert/strict';

const optionalOrigins = ['https://*/*', 'http://localhost/*', 'http://127.0.0.1/*'];

export function auditManifest(manifest, browser) {
  assert.ok(['chrome', 'firefox'].includes(browser), 'Unsupported audit browser');
  assert.equal('host_permissions' in manifest, false, 'Manifest must not pre-grant relay hosts');
  assert.equal('update_url' in manifest, false, 'Private builds must not enable automatic updates');
  if (browser === 'firefox') {
    assert.equal(manifest.manifest_version, 2);
    assert.deepEqual(manifest.permissions, ['storage', 'activeTab', 'contextMenus']);
    assert.deepEqual(manifest.optional_permissions, optionalOrigins);
    assert.equal('optional_host_permissions' in manifest, false);
    assert.deepEqual(manifest.background, { scripts: ['background.js'] });
    assert.equal(manifest.sidebar_action?.default_panel, 'sidepanel.html');
    assert.equal(manifest.browser_action?.default_popup, 'popup.html');
    assert.equal(manifest.options_ui?.page, 'options.html');
    const gecko = manifest.browser_specific_settings?.gecko;
    assert.equal(gecko?.id, 'lingualens-private-relay@local');
    assert.equal(gecko?.strict_min_version, '140.0');
    assert.deepEqual(gecko?.data_collection_permissions, { required: ['websiteContent'] });
    assert.equal('update_url' in gecko, false);
  } else {
    assert.equal(manifest.manifest_version, 3);
    assert.deepEqual(manifest.optional_host_permissions, optionalOrigins);
  }
}
