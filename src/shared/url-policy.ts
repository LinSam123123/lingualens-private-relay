export interface ValidatedBaseUrl {
  baseUrl: string;
  origin: string;
  /** Match pattern for permissions.request/contains/remove. */
  permissionOrigin: string;
}

export type HostPermissionBrowser = 'chrome' | 'firefox';

export function resolveHostPermissionBrowser(
  browser?: HostPermissionBrowser,
): HostPermissionBrowser {
  if (browser === 'firefox' || browser === 'chrome') return browser;
  const envBrowser = (import.meta as ImportMeta & { env?: { BROWSER?: string } }).env?.BROWSER;
  return envBrowser === 'firefox' ? 'firefox' : 'chrome';
}

function asUrl(value: string | URL): URL {
  return value instanceof URL ? value : new URL(value);
}

export function hostPermissionPattern(
  value: string | URL,
  browser?: HostPermissionBrowser,
): string {
  const url = asUrl(value);
  if (resolveHostPermissionBrowser(browser) === 'firefox') {
    return `${url.protocol}//${url.hostname}/*`;
  }
  return `${url.origin}/*`;
}

export function hostPermissionOrigins(pattern: string): { origins: string[] } {
  return { origins: [pattern] };
}

export function hostPermissionQuery(
  value: string,
  browser?: HostPermissionBrowser,
): { origins: string[] } {
  const validated = validateBaseUrl(value);
  return hostPermissionOrigins(hostPermissionPattern(validated.baseUrl, browser));
}

export function validateBaseUrl(value: string): ValidatedBaseUrl {
  const trimmed = value.trim().replace(/\/+$/, '');
  if (!trimmed) throw new Error('BASE_URL_REQUIRED');

  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    throw new Error('BASE_URL_INVALID');
  }

  if (url.username || url.password || url.search || url.hash) {
    throw new Error('BASE_URL_INVALID_COMPONENTS');
  }

  const isLoopback = url.hostname === 'localhost' || url.hostname === '127.0.0.1';
  if (url.protocol !== 'https:' && !(isLoopback && url.protocol === 'http:')) {
    throw new Error('BASE_URL_UNSAFE_PROTOCOL');
  }

  const baseUrl = url.toString().replace(/\/+$/, '');
  return {
    baseUrl,
    origin: url.origin,
    permissionOrigin: hostPermissionPattern(url),
  };
}

export function endpointUrl(baseUrl: string, endpoint: string): string {
  const validated = validateBaseUrl(baseUrl);
  return `${validated.baseUrl}/${endpoint.replace(/^\/+/, '')}`;
}
