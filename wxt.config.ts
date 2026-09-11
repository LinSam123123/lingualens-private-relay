import { defineConfig } from 'wxt';

export default defineConfig({
  srcDir: 'src',
  modules: ['@wxt-dev/module-react', '@wxt-dev/auto-icons'],
  manifest: ({ browser }) => {
    const optionalOrigins = [
      'https://*/*',
      'http://localhost/*',
      'http://127.0.0.1/*',
    ];
    return {
      name: '__MSG_extName__',
      description: '__MSG_extDescription__',
      default_locale: 'en',
      permissions: browser === 'firefox'
        ? ['storage', 'activeTab', 'contextMenus']
        : ['storage', 'activeTab', 'sidePanel', 'contextMenus', 'scripting'],
      ...(browser === 'firefox'
        ? { optional_permissions: optionalOrigins }
        : { optional_host_permissions: optionalOrigins }),
      ...(browser === 'firefox' ? {
        browser_specific_settings: {
          gecko: {
            // Mozilla: transmission is any data leaving the add-on or local browser.
            // Page translation sends website text to the user-configured Relay.
            data_collection_permissions: { required: ['websiteContent'] },
          },
        },
      } : {}),
      commands: {
        'translate-selection': {
          suggested_key: { default: 'Alt+T' },
          description: '__MSG_commandTranslateSelection__',
        },
        'translate-page': {
          suggested_key: { default: 'Alt+Shift+T' },
          description: '__MSG_commandTranslatePage__',
        },
        'cycle-selection-mode': {
          suggested_key: { default: 'Alt+M' },
          description: '__MSG_commandCycleSelectionMode__',
        },
      },
    };
  },
});
