export interface ValidatedBaseUrl {
  baseUrl: string;
  origin: string;
  permissionOrigin: string;
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

  return {
    baseUrl: url.toString().replace(/\/+$/, ''),
    origin: url.origin,
    permissionOrigin: `${url.origin}/*`,
  };
}

export function endpointUrl(baseUrl: string, endpoint: string): string {
  const validated = validateBaseUrl(baseUrl);
  return `${validated.baseUrl}/${endpoint.replace(/^\/+/, '')}`;
}
