export type FailureKind = 'budget' | 'missing' | 'format' | 'rate' | 'configuration' | 'unknown' | 'other';

/** Only fixed categories reach the UI, never raw provider error bodies. */
export function failureKind(code: string | undefined, status: string): FailureKind {
  if (code === 'PAGE_BUDGET_EXCEEDED') return 'budget';
  if (status === 'interrupted/unknown') return 'unknown';
  if (code === 'RESPONSE_MISSING_ITEM') return 'missing';
  if (['RESPONSE_FORMAT_INCOMPATIBLE', 'RESPONSE_TRUNCATED', 'MISSING_TEXT', 'NOT_STRING', 'EMPTY_TEXT', 'TEXT_TOO_LONG'].includes(code ?? '')) return 'format';
  if (code === 'RATE_LIMITED') return 'rate';
  if (['AUTH_FAILED', 'HTTP_401', 'HTTP_403', 'FAST_MODE_REJECTED', 'REQUEST_ID_HEADER_REJECTED', 'NO_API_KEY', 'HOST_PERMISSION_REQUIRED'].includes(code ?? '')) return 'configuration';
  return 'other';
}
