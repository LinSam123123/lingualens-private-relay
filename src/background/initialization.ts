import { initializeTaskJournal } from './task-journal';
import { initializePersistentCredentialStore } from './credential-idb';
import { canUseLocalKeyStorage, restrictStorageAccess } from './storage-access';
import { removeLocalApiKeyIfUnrestricted } from './secret-store';
import { autoPages } from './auto-pages';
import { prepareTranslationCache } from './cache';

let initializationError: string | null = null;

async function initialize(): Promise<void> {
  await restrictStorageAccess();
  if (!canUseLocalKeyStorage()) await removeLocalApiKeyIfUnrestricted();
  await initializePersistentCredentialStore();
  await prepareTranslationCache();
  await initializeTaskJournal();
  await autoPages.initialize();
}

export const initializationPromise: Promise<void> = initialize().catch((error) => {
  initializationError = error instanceof Error ? error.message : 'Background initialization failed';
  throw error;
});

export async function requireInitialization(): Promise<void> {
  if (initializationError) throw new Error('BACKGROUND_INITIALIZATION_FAILED');
  await initializationPromise;
}
