import type { SecretStorageMode } from '../shared/types';

export const SECRET_STORAGE_MODES = ['session', 'local', 'persistent'] as const;

export function otherSecretModes(mode: SecretStorageMode): SecretStorageMode[] {
  return SECRET_STORAGE_MODES.filter((entry) => entry !== mode);
}

export function assertSecretModeAllowed(
  mode: SecretStorageMode,
  capabilities: { local: boolean; persistent: boolean },
): void {
  if (mode === 'local' && !capabilities.local) throw new Error('LOCAL_KEY_STORAGE_UNAVAILABLE');
  if (mode === 'persistent' && !capabilities.persistent) {
    throw new Error('PERSISTENT_KEY_STORAGE_UNAVAILABLE');
  }
}

export function normalizeSecretStorageMode(
  mode: unknown,
  capabilities: { local: boolean; persistent: boolean },
): SecretStorageMode {
  if (mode === 'persistent') return capabilities.local ? 'session' : 'persistent';
  if (mode === 'local' && capabilities.local) return 'local';
  return 'session';
}
