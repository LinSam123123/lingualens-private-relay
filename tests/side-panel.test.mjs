import assert from 'node:assert/strict';
import test from 'node:test';

import {
  detectSidePanelApi,
  openExtensionSidePanel,
  resolveSidePanelStrategy,
} from '../src/shared/side-panel.ts';

test('prefers Chrome sidePanel when both APIs exist', () => {
  assert.equal(resolveSidePanelStrategy({
    chromeSidePanel: {
      windows: { getCurrent: async () => ({ id: 1 }) },
      sidePanel: { open: async () => {} },
    },
    sidebarAction: { open: async () => {} },
  }), 'chrome-sidePanel');
});

test('uses Firefox sidebarAction when Chrome sidePanel is absent', () => {
  assert.equal(resolveSidePanelStrategy({
    sidebarAction: { open: async () => {} },
  }), 'firefox-sidebarAction');
  assert.equal(resolveSidePanelStrategy({}), 'unavailable');
});

test('Chrome opener keeps window-scoped sidePanel.open', async () => {
  const opened = [];
  const error = await openExtensionSidePanel({
    chromeSidePanel: {
      windows: { getCurrent: async () => ({ id: 42 }) },
      sidePanel: { open: async (opts) => { opened.push(opts); } },
    },
  });
  assert.equal(error, null);
  assert.deepEqual(opened, [{ windowId: 42 }]);
});

test('Firefox opener calls sidebarAction.open and does not require a window id', async () => {
  let called = 0;
  const error = await openExtensionSidePanel({
    sidebarAction: { open: async () => { called += 1; } },
  });
  assert.equal(error, null);
  assert.equal(called, 1);
});

test('detectSidePanelApi ignores chrome without sidePanel.open', () => {
  const api = detectSidePanelApi({
    chrome: { windows: { getCurrent: async () => ({ id: 1 }) } },
    browser: { sidebarAction: { open: async () => {} } },
  });
  assert.equal(resolveSidePanelStrategy(api), 'firefox-sidebarAction');
});
