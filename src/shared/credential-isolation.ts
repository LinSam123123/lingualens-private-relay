export const CREDENTIAL_IDB_NAME = 'lingualens-private-credentials';
export const CREDENTIAL_IDB_STORE = 'secrets';
export const CREDENTIAL_IDB_KEY = 'relayApiKey';

export interface PublicCredentialIsolationProbe {
  origin: string;
  isMozExtensionOrigin: boolean;
  databaseName: string;
  indexedDbAvailable: boolean;
  hasRelayApiKeyRecord: boolean;
}

export function isMozExtensionOrigin(origin: string): boolean {
  return origin.startsWith('moz-extension://');
}

export function publicCredentialIsolationProbe(
  value: Partial<PublicCredentialIsolationProbe> & { origin?: string },
): PublicCredentialIsolationProbe {
  const origin = typeof value.origin === 'string' ? value.origin : '';
  return {
    origin,
    isMozExtensionOrigin: isMozExtensionOrigin(origin),
    databaseName: CREDENTIAL_IDB_NAME,
    indexedDbAvailable: value.indexedDbAvailable === true,
    hasRelayApiKeyRecord: value.hasRelayApiKeyRecord === true,
  };
}

export async function probeUntrustedIndexedDb(
  origin: string = globalThis.location?.origin ?? '',
  factory: IDBFactory | undefined = globalThis.indexedDB,
): Promise<PublicCredentialIsolationProbe> {
  const base = publicCredentialIsolationProbe({ origin, indexedDbAvailable: Boolean(factory) });
  if (!factory) return base;

  if (typeof factory.databases === 'function') {
    const listed = await factory.databases();
    if (!listed.some((entry) => entry?.name === CREDENTIAL_IDB_NAME)) {
      return { ...base, indexedDbAvailable: true, hasRelayApiKeyRecord: false };
    }
  }

  const database = await new Promise<IDBDatabase>((resolve, reject) => {
    const request = factory.open(CREDENTIAL_IDB_NAME, 1);
    request.onupgradeneeded = () => {
      if (!request.result.objectStoreNames.contains(CREDENTIAL_IDB_STORE)) {
        request.result.createObjectStore(CREDENTIAL_IDB_STORE, { keyPath: 'id' });
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error('CREDENTIAL_IDB_OPEN_FAILED'));
  });

  try {
    if (!database.objectStoreNames.contains(CREDENTIAL_IDB_STORE)) {
      return { ...base, indexedDbAvailable: true, hasRelayApiKeyRecord: false };
    }
    const record = await new Promise<unknown>((resolve, reject) => {
      const transaction = database.transaction(CREDENTIAL_IDB_STORE, 'readonly');
      const request = transaction.objectStore(CREDENTIAL_IDB_STORE).get(CREDENTIAL_IDB_KEY);
      request.onsuccess = () => resolve(request.result ?? null);
      request.onerror = () => reject(request.error ?? new Error('CREDENTIAL_IDB_REQUEST_FAILED'));
    });
    return {
      ...base,
      indexedDbAvailable: true,
      hasRelayApiKeyRecord: Boolean(record && typeof record === 'object'),
    };
  } finally {
    database.close();
  }
}
