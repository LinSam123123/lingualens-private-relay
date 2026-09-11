export type ChromeSidePanelApi = {
  windows: { getCurrent: () => Promise<{ id?: number }> };
  sidePanel: { open: (opts: { windowId: number }) => Promise<void> };
};

export type FirefoxSidebarActionApi = {
  open: () => Promise<void>;
};

export type SidePanelApi = {
  chromeSidePanel?: ChromeSidePanelApi;
  sidebarAction?: FirefoxSidebarActionApi;
};

export type SidePanelStrategy = 'chrome-sidePanel' | 'firefox-sidebarAction' | 'unavailable';

export function resolveSidePanelStrategy(api: SidePanelApi): SidePanelStrategy {
  if (typeof api.chromeSidePanel?.sidePanel?.open === 'function') return 'chrome-sidePanel';
  if (typeof api.sidebarAction?.open === 'function') return 'firefox-sidebarAction';
  return 'unavailable';
}

export function detectSidePanelApi(
  globals: object = globalThis,
): SidePanelApi {
  const host = globals as {
    chrome?: ChromeSidePanelApi;
    browser?: { sidebarAction?: FirefoxSidebarActionApi };
  };
  return {
    chromeSidePanel: typeof host.chrome?.sidePanel?.open === 'function'
      ? host.chrome
      : undefined,
    sidebarAction: host.browser?.sidebarAction,
  };
}

export async function openExtensionSidePanel(
  api: SidePanelApi = detectSidePanelApi(),
): Promise<string | null> {
  const strategy = resolveSidePanelStrategy(api);
  if (strategy === 'chrome-sidePanel') {
    const win = await api.chromeSidePanel!.windows.getCurrent();
    if (win.id == null) return 'cannotDetectWindow';
    try {
      await api.chromeSidePanel!.sidePanel.open({ windowId: win.id });
      return null;
    } catch (err) {
      return err instanceof Error ? err.message : 'cannotOpenSidePanel';
    }
  }
  if (strategy === 'firefox-sidebarAction') {
    try {
      await api.sidebarAction!.open();
      return null;
    } catch (err) {
      return err instanceof Error ? err.message : 'cannotOpenSidePanel';
    }
  }
  return 'sidePanelNotAvailable';
}
