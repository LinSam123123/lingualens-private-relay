let initializationError: string | null = null;

async function restrictStorageAccess(): Promise<void> {
  type AccessControlledArea = {
    setAccessLevel?: (options: { accessLevel: 'TRUSTED_CONTEXTS' }) => Promise<void>;
  };
  const chromeApi = (globalThis as typeof globalThis & {
    chrome?: { storage?: { local?: AccessControlledArea; session?: AccessControlledArea } };
  }).chrome;
  if (!chromeApi?.storage?.local) throw new Error('Storage API unavailable');

  await chromeApi.storage.local.setAccessLevel?.({ accessLevel: 'TRUSTED_CONTEXTS' });
  await chromeApi.storage.session?.setAccessLevel?.({ accessLevel: 'TRUSTED_CONTEXTS' });
}

export const initializationPromise: Promise<void> = restrictStorageAccess().catch((error) => {
  initializationError = error instanceof Error ? error.message : 'Background initialization failed';
  throw error;
});

export async function requireInitialization(): Promise<void> {
  if (initializationError) throw new Error('BACKGROUND_INITIALIZATION_FAILED');
  await initializationPromise;
}
