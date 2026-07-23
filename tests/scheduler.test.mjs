import assert from 'node:assert/strict';
import test from 'node:test';

import { canConsumeBudget, classifyRetry, retryDelayMs } from '../src/background/scheduler-policy.ts';

function httpError(status, code = `HTTP_${status}`) {
  return Object.assign(new Error(code), { status, code });
}

test('only retries gateway errors when explicitly enabled', () => {
  assert.deepEqual(classifyRetry(httpError(502), {
    attempt: 0, retryGatewayErrors: false, cancelled: false, timedOut: false,
  }).terminalStatus, 'interrupted/unknown');
  assert.equal(classifyRetry(httpError(503), {
    attempt: 0, retryGatewayErrors: true, cancelled: false, timedOut: false,
  }).retry, true);
});

test('retries explicit 429 twice and honors Retry-After', () => {
  assert.equal(classifyRetry(httpError(429), {
    attempt: 0, retryGatewayErrors: false, cancelled: false, timedOut: false,
  }).retry, true);
  assert.equal(classifyRetry(httpError(429), {
    attempt: 2, retryGatewayErrors: false, cancelled: false, timedOut: false,
  }).retry, false);
  assert.equal(retryDelayMs(0, '3'), 3000);
});

test('treats timeout, ambiguous network errors, and cancellation conservatively', () => {
  assert.equal(classifyRetry(new TypeError('Failed to fetch'), {
    attempt: 0, retryGatewayErrors: false, cancelled: false, timedOut: false,
  }).terminalStatus, 'interrupted/unknown');
  assert.equal(classifyRetry(new DOMException('Aborted', 'AbortError'), {
    attempt: 0, retryGatewayErrors: false, cancelled: true, timedOut: false,
  }).terminalStatus, 'cancelled');
  assert.equal(classifyRetry(new DOMException('Aborted', 'AbortError'), {
    attempt: 0, retryGatewayErrors: false, cancelled: false, timedOut: true,
  }).terminalStatus, 'interrupted/unknown');
});

test('retries only explicitly identifiable DNS or connection refusal errors', () => {
  assert.equal(classifyRetry(Object.assign(new Error('dns'), { code: 'ENOTFOUND' }), {
    attempt: 0, retryGatewayErrors: false, cancelled: false, timedOut: false,
  }).retry, true);
  assert.equal(classifyRetry(Object.assign(new Error('refused'), { cause: { code: 'ECONNREFUSED' } }), {
    attempt: 2, retryGatewayErrors: false, cancelled: false, timedOut: false,
  }).retry, false);
});

test('checks request and character budgets before dispatch', () => {
  assert.equal(canConsumeBudget(
    { requestsUsed: 99, charsUsed: 90_000 },
    { requests: 1, chars: 10_000 },
    { maxRequests: 100, maxChars: 100_000 },
  ), true);
  assert.equal(canConsumeBudget(
    { requestsUsed: 100, charsUsed: 90_000 },
    { requests: 1, chars: 1 },
    { maxRequests: 100, maxChars: 100_000 },
  ), false);
});

test('journal converts dispatched batches to unknown with one batch-level write', async () => {
  let store = {
    relayTaskJournal: {
      task: {
        taskId: 'task', sessionId: 'session', tabId: 1, status: 'running',
        requestsUsed: 1, charsUsed: 5, updatedAt: Date.now(),
        batches: {
          batch: {
            batchId: 'batch', requestId: 'request-id', itemIds: ['item-1', 'item-2'],
            status: 'dispatched', attempt: 1, chars: 5, updatedAt: Date.now(),
          },
        },
      },
    },
  };
  let writes = 0;
  globalThis.browser = {
    storage: {
      session: {
        async get() { return structuredClone(store); },
        async set(value) { store = structuredClone(value); writes++; },
      },
    },
  };
  const { initializeTaskJournal } = await import('../src/background/task-journal.ts');
  await initializeTaskJournal();
  assert.equal(store.relayTaskJournal.task.batches.batch.status, 'interrupted/unknown');
  assert.equal(writes, 1);
});
