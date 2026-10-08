/** Chrome persists menus across service-worker instances. Replace, then await each creation. */
export async function initializeContextMenus(api: Pick<typeof browser, 'contextMenus' | 'runtime' | 'i18n'>): Promise<void> {
  await api.contextMenus.removeAll();
  const menus: Browser.contextMenus.CreateProperties[] = [
    { id: 'translate-selection', title: api.i18n.getMessage('contextMenuTranslateSelection', ['%s']) || 'Translate "%s"', contexts: ['selection' as const] },
    { id: 'translate-page', title: api.i18n.getMessage('contextMenuTranslatePage') || 'Translate This Page', contexts: ['page' as const] },
  ];
  for (const properties of menus) {
    await new Promise<void>((resolve, reject) => {
      api.contextMenus.create(properties, () => {
        if (api.runtime.lastError) reject(new Error('CONTEXT_MENU_INITIALIZATION_FAILED'));
        else resolve();
      });
    });
  }
}
