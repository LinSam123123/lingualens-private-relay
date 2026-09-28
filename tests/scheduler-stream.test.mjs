import assert from 'node:assert/strict';
import test from 'node:test';

function installBrowser() {
  let store = {};
  let writes = 0;
  globalThis.browser = {
    storage: {
      session: {
        async get() { return structuredClone(store); },
        async set(value) {
          store = structuredClone(value);
          writes += 1;
        },
      },
    },
  };
  return {
    read: () => store,
    writes: () => writes,
  };
}

function request(batchId, ids = ['seg-a', 'seg-b']) {
  return {
    taskId: 'task-stream',
    sessionId: 'session-stream',
    batchId,
    requestId: `request-${batchId}`,
    sourceLang: 'en',
    targetLang: 'zh-CN',
    items: ids.map((id) => ({ id, text: `Hello ${id}` })),
    generation: 1,
  };
}

function config(concurrency) {
  return {
    id: 'private-relay',
    type: 'relay',
    name: 'Private Relay',
    enabled: true,
    baseUrl: 'http://127.0.0.1:9/v1',
    model: 'mock-model',
    streamTranslations: true,
    maxConcurrency: concurrency,
    timeoutMs: 25_000,
    maxPageRequests: 100,
    maxPageChars: 100_000,
  };
}

function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}

test('budget consumption is atomic and checkpoints do not store text', async () => {
  const browser = installBrowser();
  const { consumeDispatchBudget, ensureTask, noteCompletedItems } = await import('../src/background/task-journal.ts');
  await ensureTask(request('batch-0001'), 3);
  const results = await Promise.all([
    consumeDispatchBudget('task-stream', 'session-stream', 'batch-0001', { requests: 1, chars: 10 }, { maxRequests: 1, maxChars: 100 }, 1),
    consumeDispatchBudget('task-stream', 'session-stream', 'batch-0001', { requests: 1, chars: 10 }, { maxRequests: 1, maxChars: 100 }, 1),
  ]);
  assert.equal(results.filter((entry) => entry.ok).length, 1);
  assert.equal(results.some((entry) => !entry.ok && entry.code === 'PAGE_BUDGET_EXCEEDED'), true);
  const before = browser.writes();
  await noteCompletedItems('task-stream', 'batch-0001', ['seg-a', 'seg-a']);
  await noteCompletedItems('task-stream', 'batch-0001', ['seg-b']);
  const saved = browser.read().relayTaskJournal['task-stream'].batches['batch-0001'];
  assert.deepEqual(saved.completedItemIds, ['seg-a', 'seg-b']);
  assert.equal(JSON.stringify(saved).includes('Hello'), false);
  assert.equal(browser.writes() > before, true);
});

test('stream outcomes keep partial successes and do not claim idempotent retries', async () => {
  const { classifyStreamItems, manualRetryDoesNotClaimIdempotency } = await import('../src/background/scheduler-policy.ts');
  const partial = classifyStreamItems({
    expectedIds: ['seg-a', 'seg-b'],
    acceptedIds: ['seg-a'],
    rejected: [],
    terminal: 'incomplete',
    cancelled: false,
    timedOut: false,
  });
  assert.equal(partial.status, 'interrupted/unknown');
  assert.equal(partial.items[0].status, 'completed');
  assert.equal(partial.items[1].status, 'interrupted/unknown');

  const invalid = classifyStreamItems({
    expectedIds: ['seg-a', 'seg-b'],
    acceptedIds: ['seg-b'],
    rejected: [{ id: 'seg-a', reason: 'EMPTY_TEXT' }],
    terminal: 'completed',
    cancelled: false,
    timedOut: false,
  });
  assert.equal(invalid.status, 'failed');
  assert.equal(invalid.items.find((item) => item.id === 'seg-a').error, 'EMPTY_TEXT');

  const cancelled = classifyStreamItems({
    expectedIds: ['seg-a', 'seg-b'],
    acceptedIds: ['seg-a'],
    rejected: [],
    terminal: null,
    cancelled: true,
    timedOut: true,
  });
  assert.equal(cancelled.items[0].status, 'completed');
  assert.equal(cancelled.items[1].status, 'cancelled');
  const retry = manualRetryDoesNotClaimIdempotency('request-batch-0001', ['seg-b']);
  assert.equal(retry.idempotent, false);
  assert.deepEqual(retry.itemIds, ['seg-b']);

  const accepted = ['seg-a', 'seg-b'];
  const full = {
    expectedIds: accepted,
    acceptedIds: accepted,
    rejected: [],
  };
  const timedOut = classifyStreamItems({ ...full, terminal: null, cancelled: false, timedOut: true });
  assert.equal(timedOut.status, 'interrupted/unknown');
  assert.equal(timedOut.code, 'REQUEST_TIMEOUT_UNKNOWN');
  assert.deepEqual(timedOut.items.map((item) => item.status), ['completed', 'completed']);

  const eof = classifyStreamItems({ ...full, terminal: null, cancelled: false, timedOut: false });
  assert.equal(eof.status, 'interrupted/unknown');
  assert.notEqual(eof.status, 'completed');
  assert.deepEqual(eof.items.map((item) => item.status), ['completed', 'completed']);

  const cancelledFull = classifyStreamItems({ ...full, terminal: null, cancelled: true, timedOut: false });
  assert.equal(cancelledFull.status, 'cancelled');
  assert.deepEqual(cancelledFull.items.map((item) => item.status), ['completed', 'completed']);

  const provider = classifyStreamItems({ ...full, terminal: 'provider-error', cancelled: false, timedOut: false });
  assert.equal(provider.status, 'failed');
  assert.equal(provider.code, 'STREAM_PROVIDER_ERROR');
  assert.deepEqual(provider.items.map((item) => item.status), ['completed', 'completed']);

  const clean = classifyStreamItems({ ...full, terminal: 'completed', cancelled: false, timedOut: false });
  assert.equal(clean.status, 'completed');
  assert.deepEqual(clean.items.map((item) => item.status), ['completed', 'completed']);

  const missing = classifyStreamItems({
    expectedIds: accepted,
    acceptedIds: ['seg-a'],
    rejected: [],
    terminal: 'completed',
    cancelled: false,
    timedOut: false,
  });
  assert.equal(missing.status, 'failed');
  assert.equal(missing.items.find((item) => item.id === 'seg-b').error, 'RESPONSE_MISSING_ITEM');
  assert.equal(missing.items.find((item) => item.id === 'seg-a').status, 'completed');
});

test('a stream keeps its concurrency slot until it finishes and never falls back', async () => {
  installBrowser();
  const { TranslationScheduler } = await import('../src/background/scheduler.ts');
  const { resetPagePortsForTests, listenForPagePort } = await import('../src/shared/stream-delivery.ts');
  resetPagePortsForTests();
  const posted = [];
  const port = {
    sender: { id: 'ext', tab: { id: 4 }, frameId: 0 },
    posted,
    onMessage: { addListener() {} },
    onDisconnect: { addListener() {} },
    postMessage(message) { posted.push(message); },
    disconnect() {},
  };
  listenForPagePort(port, Promise.resolve('ext'));
  port.onMessage.addListener = (fn) => { port.emit = fn; };
  // listener was registered inside listenForPagePort before we replaced addListener.
  // Re-bind by emitting through the original listener captured above is too late.
  // Bind directly through a fresh port created before listen.
  resetPagePortsForTests();
  const messages = [];
  const listeners = [];
  const livePort = {
    sender: { id: 'ext', tab: { id: 4 }, frameId: 0 },
    onMessage: { addListener(fn) { listeners.push(fn); } },
    onDisconnect: { addListener() {} },
    postMessage(message) { messages.push(message); },
    disconnect() {},
  };
  listenForPagePort(livePort, Promise.resolve('ext'));
  await new Promise((resolve) => setTimeout(resolve, 0));
  for (const listener of listeners) listener({
    type: 'bind', taskId: 'task-stream', sessionId: 'session-stream', generation: 1,
  });

  let release;
  const released = new Promise((resolve) => { release = resolve; });
  const calls = { stream: 0, block: 0 };
  const relay = {
    async *streamItems(items) {
      calls.stream += 1;
      yield { type: 'text-delta' };
      yield { type: 'item', item: { id: items[0].id, text: '你好' } };
      await released;
      yield { type: 'terminal', kind: 'completed', code: 'STREAM_COMPLETED' };
    },
    async translateItems() {
      calls.block += 1;
      throw new Error('BLOCKING_FALLBACK');
    },
  };
  const scheduler = new TranslationScheduler();
  const pending = [];
  for (let index = 0; index < 4; index += 1) {
    pending.push(scheduler.submit(
      request(`batch-${index}`),
      4,
      0,
      relay,
      config(2),
    ));
  }
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(scheduler.activeSlotCount, 2);
  assert.equal(calls.stream, 2);
  assert.equal(calls.block, 0);
  assert.equal(messages.some((message) => message.type === 'stream-item' && message.item.text === '你好'), true);
  release();
  await Promise.all(pending);
  assert.equal(calls.block, 0);
  assert.equal(scheduler.activeSlotCount, 0);
});

test('caps of 4 and 10 are shared across tasks and are not released on the first item', async () => {
  installBrowser();
  const { TranslationScheduler } = await import('../src/background/scheduler.ts');
  for (const limit of [4, 10]) {
    let release;
    const released = new Promise((resolve) => { release = resolve; });
    const relay = {
      async *streamItems() {
        yield { type: 'item', item: { id: 'seg-a', text: '你好' } };
        await released;
        yield { type: 'terminal', kind: 'completed', code: 'STREAM_COMPLETED' };
      },
      async translateItems() { throw new Error('BLOCKING_FALLBACK'); },
    };
    const scheduler = new TranslationScheduler();
    const pending = [];
    for (let index = 0; index < limit + 2; index += 1) {
      pending.push(scheduler.submit(
        { ...request(`cap-${limit}-${index}`), taskId: `task-${limit}-${index}` },
        index + 1,
        0,
        relay,
        config(limit),
      ));
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.equal(scheduler.activeSlotCount, limit);
    release();
    await Promise.all(pending);
    assert.equal(scheduler.activeSlotCount, 0);
  }
});

test('stream failure does not call the blocking translator or retry automatically', async () => {
  installBrowser();
  const { TranslationScheduler } = await import('../src/background/scheduler.ts');
  const calls = { stream: 0, block: 0 };
  const relay = {
    async *streamItems(items) {
      calls.stream += 1;
      yield { type: 'item', item: { id: items[0].id, text: '你好' } };
      throw new Error('STREAM_NOT_SUPPORTED');
    },
    async translateItems() {
      calls.block += 1;
    },
  };
  const scheduler = new TranslationScheduler();
  const result = await scheduler.submit(request('batch-fail'), 8, 0, relay, config(2));
  assert.equal(calls.stream, 1);
  assert.equal(calls.block, 0);
  assert.equal(result.items.find((item) => item.id === 'seg-a').status, 'completed');
  assert.equal(result.items.find((item) => item.id === 'seg-b').status, 'interrupted/unknown');
  assert.notEqual(result.status, 'completed');
});

test('a non-streaming page-write acknowledgement can arrive after the diagnostic row', async () => {
  installBrowser();
  const {
    listenForPagePort,
    resetPagePortsForTests,
  } = await import('../src/shared/stream-delivery.ts');
  const {
    listBatchDiagnostics,
    resetBatchDiagnosticsForTests,
    setBatchDiagnosticsEnabled,
  } = await import('../src/background/batch-diagnostics.ts');
  resetPagePortsForTests();
  resetBatchDiagnosticsForTests();
  setBatchDiagnosticsEnabled(true);
  const listeners = [];
  const port = {
    sender: { id: 'ext', tab: { id: 4 }, frameId: 0 },
    onMessage: { addListener(fn) { listeners.push(fn); } },
    onDisconnect: { addListener() {} },
    postMessage() {},
    disconnect() {},
  };
  listenForPagePort(port, Promise.resolve('ext'));
  await new Promise((resolve) => setTimeout(resolve, 0));
  for (const listener of listeners) {
    listener({ type: 'bind', taskId: 'task-stream', sessionId: 'session-stream', generation: 1 });
  }
  const relay = {
    async translateItems(items) {
      return new Map(items.map((item) => [item.id, '你好']));
    },
    async *streamItems() { throw new Error('STREAM_NOT_USED'); },
  };
  const scheduler = new (await import('../src/background/scheduler.ts')).TranslationScheduler();
  const result = await scheduler.submit(request('batch-ack'), 4, 0, relay, { ...config(1), streamTranslations: false });
  const before = listBatchDiagnostics().find((entry) => entry.requestId === 'request-batch-ack');
  assert.equal(before.firstPageWriteMs, null);
  assert.equal(before.firstTextDeltaMs, null);
  assert.equal(before.parseMs == null || before.parseMs >= 0, true);
  for (const listener of listeners) {
    listener({
      type: 'page-write',
      taskId: 'task-stream',
      sessionId: 'session-stream',
      generation: 1,
      batchId: 'batch-ack',
      requestId: 'request-batch-ack',
      attempt: result.attempts,
    });
  }
  const after = listBatchDiagnostics().find((entry) => entry.requestId === 'request-batch-ack' && entry.attempt === result.attempts);
  assert.equal(typeof after.firstPageWriteMs, 'number');
  for (const listener of listeners) {
    listener({
      type: 'page-write',
      taskId: 'task-stream',
      sessionId: 'session-stream',
      generation: 1,
      batchId: 'batch-ack',
      requestId: 'request-batch-ack',
      attempt: result.attempts + 1,
    });
  }
  assert.equal(
    listBatchDiagnostics().find((entry) => entry.attempt === result.attempts).firstPageWriteMs,
    after.firstPageWriteMs,
  );
});

test('cancel keeps the item already delivered and drops a later item', async () => {
  installBrowser();
  const { TranslationScheduler } = await import('../src/background/scheduler.ts');
  const gate = deferred();
  const relay = {
    async *streamItems(items) {
      yield { type: 'item', item: { id: items[0].id, text: '你好' } };
      await gate.promise;
      yield { type: 'item', item: { id: items[1].id, text: '世界' } };
      yield { type: 'terminal', kind: 'completed', code: 'STREAM_COMPLETED' };
    },
    async translateItems() { throw new Error('BLOCKING_FALLBACK'); },
  };
  const scheduler = new TranslationScheduler();
  const pending = scheduler.submit(request('batch-cancel'), 9, 0, relay, config(2));
  await new Promise((resolve) => setTimeout(resolve, 20));
  await scheduler.control('task-stream', 'session-stream', 'cancel');
  gate.resolve();
  const result = await pending;
  assert.equal(result.items.find((item) => item.id === 'seg-a').status, 'completed');
  assert.equal(result.items.find((item) => item.id === 'seg-b').status, 'cancelled');
});
