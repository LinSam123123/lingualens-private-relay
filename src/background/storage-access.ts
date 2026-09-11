type AccessControlledArea = {
  setAccessLevel?: (options: { accessLevel: 'TRUSTED_CONTEXTS' }) => Promise<void>;
};

export type StorageNamespace = {
  local?: AccessControlledArea;
  session?: AccessControlledArea;
};

export interface StorageIsolation {
  localRestricted: boolean;
  sessionAvailable: boolean;
}

const TRUSTED_CONTEXTS = { accessLevel: 'TRUSTED_CONTEXTS' } as const;

let isolation: StorageIsolation | null = null;

function getStorageNamespace(): StorageNamespace | undefined {
  const globals = globalThis as typeof globalThis & {
    browser?: { storage?: StorageNamespace };
    chrome?: { storage?: StorageNamespace };
  };
  return globals.browser?.storage ?? globals.chrome?.storage;
}

async function restrictArea(area: AccessControlledArea | undefined): Promise<boolean> {
  if (!area) return false;
  if (typeof area.setAccessLevel !== 'function') return false;
  await area.setAccessLevel(TRUSTED_CONTEXTS);
  return true;
}

export async function restrictStorageAccess(
  storage: StorageNamespace | undefined = getStorageNamespace(),
): Promise<StorageIsolation> {
  if (!storage?.local) throw new Error('Storage API unavailable');
  if (!storage.session) throw new Error('Storage API unavailable');

  const localRestricted = await restrictArea(storage.local);
  if (typeof storage.session.setAccessLevel === 'function') {
    await restrictArea(storage.session);
  }

  isolation = {
    localRestricted,
    sessionAvailable: true,
  };
  return isolation;
}

export function canUseLocalKeyStorage(): boolean {
  return isolation?.localRestricted === true;
}

export function requireLocalKeyStorage(): void {
  if (!canUseLocalKeyStorage()) throw new Error('LOCAL_KEY_STORAGE_UNAVAILABLE');
}

export function resetStorageIsolationForTests(): void {
  isolation = null;
}
