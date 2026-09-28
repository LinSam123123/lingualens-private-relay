export interface RetryContext {
  attempt: number;
  retryGatewayErrors: boolean;
  cancelled: boolean;
  timedOut: boolean;
}

export interface RetryDecision {
  retry: boolean;
  terminalStatus: 'failed' | 'interrupted/unknown' | 'cancelled';
  code: string;
}

export interface PriorBatchDecision {
  status: 'failed' | 'interrupted/unknown' | 'cancelled';
  code: string;
}

export function priorBatchDecision(
  status: string,
  flags: { manualRetryFailed: boolean; manualRetryUnknown: boolean },
): PriorBatchDecision | null {
  if (status === 'interrupted/unknown' && !flags.manualRetryUnknown) {
    return { status: 'interrupted/unknown', code: 'MANUAL_RETRY_REQUIRED' };
  }
  if (status === 'failed' && !flags.manualRetryFailed) {
    return { status: 'failed', code: 'MANUAL_RETRY_REQUIRED' };
  }
  if (status === 'cancelled') return { status: 'cancelled', code: 'CANCELLED' };
  if (status === 'completed') {
    return { status: 'interrupted/unknown', code: 'COMPLETED_RESULT_UNAVAILABLE' };
  }
  return null;
}

export function taskControlPolicy(action: string): {
  pause: boolean | null;
  dispatch: boolean;
  abortActive: boolean;
  cancelQueued: boolean;
} {
  return {
    pause: action === 'pause' ? true : action === 'resume' ? false : null,
    dispatch: action === 'resume',
    abortActive: action === 'cancel' || action === 'restore',
    cancelQueued: action === 'cancel' || action === 'restore',
  };
}

interface HttpLikeError extends Error {
  status?: number;
  code?: string;
}

function explicitNetworkCode(error: unknown): string {
  if (!error || typeof error !== 'object') return '';
  const value = error as { code?: unknown; cause?: { code?: unknown }; message?: unknown };
  const knownCodes = ['ENOTFOUND', 'ERR_NAME_NOT_RESOLVED', 'ECONNREFUSED', 'ERR_CONNECTION_REFUSED'];
  const code = typeof value.code === 'string'
    ? value.code
    : typeof value.cause?.code === 'string'
      ? value.cause.code
      : '';
  const normalizedCode = code.toUpperCase();
  if (knownCodes.includes(normalizedCode)) return normalizedCode;
  const message = typeof value.message === 'string' ? value.message.toUpperCase() : '';
  for (const known of knownCodes) {
    if (message.includes(known)) return known;
  }
  return '';
}

export function classifyRetry(error: unknown, context: RetryContext): RetryDecision {
  if (context.cancelled) return { retry: false, terminalStatus: 'cancelled', code: 'CANCELLED' };
  if (context.timedOut) return { retry: false, terminalStatus: 'interrupted/unknown', code: 'REQUEST_TIMEOUT_UNKNOWN' };

  const value = error as HttpLikeError | undefined;
  const status = value?.status;
  if (status === 429) {
    return context.attempt < 2
      ? { retry: true, terminalStatus: 'failed', code: 'RATE_LIMITED' }
      : { retry: false, terminalStatus: 'failed', code: 'RATE_LIMITED' };
  }
  if (status === 502 || status === 503) {
    if (context.retryGatewayErrors && context.attempt < 2) {
      return { retry: true, terminalStatus: 'interrupted/unknown', code: `HTTP_${status}` };
    }
    return { retry: false, terminalStatus: 'interrupted/unknown', code: `HTTP_${status}_UNKNOWN` };
  }

  const networkCode = explicitNetworkCode(error);
  if (networkCode) {
    return context.attempt < 2
      ? { retry: true, terminalStatus: 'failed', code: networkCode }
      : { retry: false, terminalStatus: 'failed', code: networkCode };
  }

  if (error instanceof TypeError || value?.name === 'AbortError') {
    return { retry: false, terminalStatus: 'interrupted/unknown', code: 'NETWORK_STATE_UNKNOWN' };
  }
  return { retry: false, terminalStatus: 'failed', code: value?.code || value?.message || 'TRANSLATION_FAILED' };
}

export function retryDelayMs(attempt: number, retryAfter: string | null, now = Date.now()): number {
  if (retryAfter) {
    const seconds = Number(retryAfter);
    if (Number.isFinite(seconds) && seconds >= 0) return Math.min(seconds * 1000, 60_000);
    const date = Date.parse(retryAfter);
    if (Number.isFinite(date)) return Math.min(Math.max(0, date - now), 60_000);
  }
  return Math.min(1000 * (2 ** attempt), 8000);
}

export interface StreamItemOutcome {
  id: string;
  status: 'completed' | 'failed' | 'interrupted/unknown' | 'cancelled';
  error?: string;
}

/**
 * Same request id with a smaller item list is not treated as idempotent.
 * The relay may already have executed the original payload.
 */
export function manualRetryDoesNotClaimIdempotency(
  requestId: string,
  unfinishedIds: string[],
): { requestId: string; itemIds: string[]; idempotent: false } {
  return { requestId, itemIds: unfinishedIds, idempotent: false };
}

export function classifyStreamItems(input: {
  expectedIds: string[];
  acceptedIds: string[];
  rejected: Array<{ id: string; reason: string }>;
  terminal: 'completed' | 'truncated' | 'provider-error' | 'incomplete' | 'unsafe' | null;
  cancelled: boolean;
  timedOut: boolean;
}): { status: 'completed' | 'failed' | 'interrupted/unknown' | 'cancelled'; code: string; items: StreamItemOutcome[] } {
  const accepted = new Set(input.acceptedIds);
  const rejected = new Map(input.rejected.map((item) => [item.id, item.reason]));
  const items: StreamItemOutcome[] = input.expectedIds.map((id) => {
    if (accepted.has(id)) return { id, status: 'completed' };
    if (input.cancelled) return { id, status: 'cancelled', error: 'CANCELLED' };
    const reason = rejected.get(id);
    if (reason && (input.terminal === 'completed' || input.terminal === 'truncated' || input.terminal === 'provider-error')) {
      return { id, status: 'failed', error: reason };
    }
    if (input.timedOut || input.terminal === 'incomplete' || input.terminal === 'unsafe' || input.terminal == null) {
      return {
        id,
        status: 'interrupted/unknown',
        error: input.timedOut ? 'REQUEST_TIMEOUT_UNKNOWN' : 'STREAM_INTERRUPTED_UNKNOWN',
      };
    }
    if (input.terminal === 'truncated') return { id, status: 'failed', error: 'RESPONSE_TRUNCATED' };
    if (input.terminal === 'provider-error') return { id, status: 'failed', error: 'STREAM_PROVIDER_ERROR' };
    return { id, status: 'failed', error: 'RESPONSE_MISSING_ITEM' };
  });
  const unfinished = items.find((item) => item.status !== 'completed');
  const cleanTerminal = input.terminal === 'completed' && !input.cancelled && !input.timedOut;
  let status: 'completed' | 'failed' | 'interrupted/unknown' | 'cancelled';
  let code: string;
  if (input.cancelled) {
    status = 'cancelled';
    code = 'CANCELLED';
  } else if (input.timedOut) {
    status = 'interrupted/unknown';
    code = 'REQUEST_TIMEOUT_UNKNOWN';
  } else if (input.terminal === 'truncated') {
    status = 'failed';
    code = unfinished?.error ?? 'RESPONSE_TRUNCATED';
  } else if (input.terminal === 'provider-error') {
    status = 'failed';
    code = unfinished?.error ?? 'STREAM_PROVIDER_ERROR';
  } else if (!cleanTerminal) {
    status = 'interrupted/unknown';
    code = unfinished?.status === 'interrupted/unknown'
      ? (unfinished.error ?? 'STREAM_INTERRUPTED_UNKNOWN')
      : 'STREAM_INTERRUPTED_UNKNOWN';
  } else if (!unfinished) {
    status = 'completed';
    code = 'completed';
  } else if (unfinished.status === 'interrupted/unknown') {
    status = 'interrupted/unknown';
    code = unfinished.error ?? 'STREAM_INTERRUPTED_UNKNOWN';
  } else if (unfinished.status === 'cancelled') {
    status = 'cancelled';
    code = unfinished.error ?? 'CANCELLED';
  } else {
    status = 'failed';
    code = unfinished.error ?? 'RESPONSE_MISSING_ITEM';
  }
  return { status, code, items };
}

export function canConsumeBudget(
  current: { requestsUsed: number; charsUsed: number },
  addition: { requests: number; chars: number },
  limits: { maxRequests: number; maxChars: number },
): boolean {
  return current.requestsUsed + addition.requests <= limits.maxRequests
    && current.charsUsed + addition.chars <= limits.maxChars;
}
