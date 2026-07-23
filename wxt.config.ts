import { defineConfig } from 'wxt';

export default defineConfig({
  srcDir: 'src',
  modules: ['@wxt-dev/module-react', '@wxt-dev/auto-icons'],
  manifest: {
    name: '__MSG_extName__',
    description: '__MSG_extDescription__',
    default_locale: 'en',
    permissions: ['storage', 'activeTab', 'sidePanel', 'contextMenus', 'scripting'],
    optional_host_permissions: [
      'https://*/*',
      'http://localhost/*',
      'http://127.0.0.1/*',
    ],
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
  },
});
