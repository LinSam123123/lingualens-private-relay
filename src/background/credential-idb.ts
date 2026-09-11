export const CREDENTIAL_IDB_NAME = 'lingualens-private-credentials';
export const CREDENTIAL_IDB_STORE = 'secrets';
export const CREDENTIAL_IDB_KEY = 'relayApiKey';
const PROBE_ID = '__probe__';

export interface CredentialDriver {
  get(id: string): Promise<string | undefined>;
  put(id: string, value: string): Promise<void>;
  delete(id: string): Promise<void>;
}

export function isMozExtensionOrigin(origin: string): boolean {
  return origin.startsWith('moz-extension://');
}

export function assertMozExtensionOrigin(origin: string): void {
  if (!isMozExtensionOrigin(origin)) throw new Error('CREDENTIAL_IDB_ORIGIN_INVALID');
}

export function createMemoryCredentialDriver(): CredentialDriver {
  const records = new Map<string, string>();
  return {
    async get(id) {
      return records.get(id);
    },
    async put(id, value) {
      records.set(id, value);
    },
    async delete(id) {
      records.delete(id);
    },
  };
}

function currentOrigin(): string {
  return globalThis.location?.origin ?? '';
}

function idbRequest<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error('CREDENTIAL_IDB_REQUEST_FAILED'));
  });
}

function waitForTransaction(transaction: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error ?? new Error('CREDENTIAL_IDB_TX_FAILED'));
    transaction.onabort = () => reject(transaction.error ?? new Error('CREDENTIAL_IDB_TX_ABORTED'));
  });
}

export function createIndexedDbCredentialDriver(
  origin: string = currentOrigin(),
): CredentialDriver {
  assertMozExtensionOrigin(origin);
  if (typeof indexedDB === 'undefined') throw new Error('CREDENTIAL_IDB_UNAVAILABLE');

  async function withStore<T>(
    mode: IDBTransactionMode,
    operate: (store: IDBObjectStore) => IDBRequest<T> | void,
  ): Promise<T | undefined> {
    const database = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open(CREDENTIAL_IDB_NAME, 1);
      request.onupgradeneeded = () => {
        if (!request.result.objectStoreNames.contains(CREDENTIAL_IDB_STORE)) {
          request.result.createObjectStore(CREDENTIAL_IDB_STORE, { keyPath: 'id' });
        }
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error ?? new Error('CREDENTIAL_IDB_OPEN_FAILED'));
    });
    try {
      const transaction = database.transaction(CREDENTIAL_IDB_STORE, mode);
      const store = transaction.objectStore(CREDENTIAL_IDB_STORE);
      const request = operate(store);
      const result = request ? await idbRequest(request) : undefined;
      await waitForTransaction(transaction);
      return result;
    } finally {
      database.close();
    }
  }

  return {
    async get(id) {
      const record = await withStore<{ id: string; value?: string } | undefined>('readonly', (store) => store.get(id));
      return typeof record?.value === 'string' ? record.value : undefined;
    },
    async put(id, value) {
      await withStore('readwrite', (store) => store.put({ id, value }));
    },
    async delete(id) {
      await withStore('readwrite', (store) => store.delete(id));
    },
  };
}

let persistentReady = false;
let driver: CredentialDriver | null = null;

export function resetPersistentCredentialStoreForTests(): void {
  persistentReady = false;
  driver = null;
}

export function canUsePersistentKeyStorage(): boolean {
  return persistentReady;
}

export function requirePersistentKeyStorage(): void {
  if (!persistentReady) throw new Error('PERSISTENT_KEY_STORAGE_UNAVAILABLE');
}

export async function probePersistentCredentialStore(
  activeDriver: CredentialDriver,
): Promise<void> {
  await activeDriver.put(PROBE_ID, 'ok');
  const value = await activeDriver.get(PROBE_ID);
  await activeDriver.delete(PROBE_ID);
  if (value !== 'ok') throw new Error('CREDENTIAL_IDB_PROBE_FAILED');
  if (await activeDriver.get(PROBE_ID) !== undefined) throw new Error('CREDENTIAL_IDB_PROBE_FAILED');
}

export async function initializePersistentCredentialStore(options?: {
  origin?: string;
  driver?: CredentialDriver;
}): Promise<boolean> {
  persistentReady = false;
  driver = null;
  const origin = options?.origin ?? currentOrigin();
  if (!isMozExtensionOrigin(origin)) return false;
  try {
    const active = options?.driver ?? createIndexedDbCredentialDriver(origin);
    await probePersistentCredentialStore(active);
    driver = active;
    persistentReady = true;
    return true;
  } catch {
    persistentReady = false;
    driver = null;
    return false;
  }
}

function requireDriver(): CredentialDriver {
  requirePersistentKeyStorage();
  if (!driver) throw new Error('PERSISTENT_KEY_STORAGE_UNAVAILABLE');
  return driver;
}

export async function readPersistentApiKey(): Promise<string> {
  return (await requireDriver().get(CREDENTIAL_IDB_KEY)) ?? '';
}

export async function writePersistentApiKey(value: string): Promise<void> {
  const active = requireDriver();
  await active.put(CREDENTIAL_IDB_KEY, value);
  const stored = await active.get(CREDENTIAL_IDB_KEY);
  if (stored !== value) throw new Error('CREDENTIAL_STORE_VERIFY_FAILED');
}

export async function deletePersistentApiKey(): Promise<void> {
  if (driver) {
    await driver.delete(CREDENTIAL_IDB_KEY);
    return;
  }
  if (!isMozExtensionOrigin(currentOrigin())) return;
  await createIndexedDbCredentialDriver().delete(CREDENTIAL_IDB_KEY);
}
