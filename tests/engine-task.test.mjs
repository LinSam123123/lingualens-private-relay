import assert from 'node:assert/strict';
import test from 'node:test';

globalThis.NodeFilter = { SHOW_TEXT: 4, FILTER_ACCEPT: 1, FILTER_REJECT: 2, FILTER_SKIP: 3 };
globalThis.getComputedStyle = () => ({
  display: 'block',
  visibility: 'visible',
  opacity: '1',
  position: 'static',
});

function textNode(value) {
  const parent = {
    nodeType: 1,
    tagName: 'P',
    className: '',
    isContentEditable: false,
    childNodes: [],
    parentElement: null,
    parentNode: null,
    hasAttribute: () => false,
    getAttribute: () => null,
    closest: () => null,
  };
  const node = {
    nodeType: 3,
    textContent: value,
    parentElement: parent,
    parentNode: parent,
  };
  parent.childNodes = [node];
  parent.textContent = value;
  const body = {
    nodeType: 1,
    tagName: 'BODY',
    className: '',
    isContentEditable: false,
    childNodes: [parent],
    parentElement: null,
    parentNode: null,
    hasAttribute: () => false,
    getAttribute: () => null,
    closest: () => null,
  };
  parent.parentElement = body;
  parent.parentNode = body;
  globalThis.document = {
    body,
    createTreeWalker() {
      let pending = [node];
      return { nextNode() { return pending.shift() ?? null; } };
    },
    createElement() {
      return { dataset: {}, style: {}, textContent: '', remove() {} };
    },
  };
  return node;
}

function installBrowser(recovery) {
  const batchCalls = [];
  const sent = [];
  const ports = [];
  globalThis.browser = {
    runtime: {
      connect() {
        const messageListeners = [];
        const disconnectListeners = [];
        const port = {
          onMessage: { addListener(fn) { messageListeners.push(fn); } },
          onDisconnect: { addListener(fn) { disconnectListeners.push(fn); } },
          postMessage(message) {
            if (message?.type === 'bind') {
              queueMicrotask(() => {
                for (const listener of messageListeners) {
                  listener({
                    type: 'bound',
                    taskId: message.taskId,
                    sessionId: message.sessionId,
                    generation: message.generation,
                  });
                }
              });
            }
          },
          disconnect() {
            for (const listener of disconnectListeners) listener();
          },
          emit(message) {
            for (const listener of messageListeners) listener(message);
          },
        };
        ports.push(port);
        return port;
      },
      sendMessage(message) {
        if (message.type === 'TRANSLATE_BATCH') {
          return new Promise((resolve, reject) => {
            batchCalls.push({ message, resolve, reject });
          });
        }
        if (message.type === 'GET_TASK_RECOVERY') {
          return Promise.resolve(recovery());
        }
        sent.push(message);
        return Promise.resolve({ success: true, data: null });
      },
    },
  };
  return { batchCalls, sent, ports };
}

const options = {
  targetLang: 'zh-CN',
  sourceLang: 'en',
  displayMode: 'replace',
  maxCharsPerRequest: 8_000,
  maxItemsPerRequest: 0,
  maxPageChars: 100_000,
  maxPageRequests: 100,
};

function batchResult(payload, text, status = 'completed') {
  return {
    success: true,
    data: {
      taskId: payload.taskId,
      batchId: payload.batchId,
      requestId: payload.requestId,
      status,
      attempts: 1,
      requestsUsed: 1,
      charsUsed: payload.items[0].text.length,
      items: payload.items.map((item) => ({
        id: item.id,
        status,
        ...(status === 'completed' ? { translated: text } : { error: 'LATE' }),
      })),
    },
  };
}

async function until(fn) {
  for (let i = 0; i < 50; i += 1) {
    if (fn()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error('timed out');
}

test('failed items can be retried after stopping, with progress and one dispatch per click sequence', async () => {
  const { PageTranslateEngine } = await import('../src/content/page-translator/engine.ts');
  const node = textNode('A failed paragraph can still be translated');
  const harness = installBrowser(() => ({ success: false }));
  const engine = new PageTranslateEngine();
  let progress;
  const report = (value) => { progress = value; };
  const first = engine.start(options, report);
  await until(() => harness.batchCalls.length === 1);
  const payload = harness.batchCalls[0].message.payload;
  const failed = batchResult(payload, '', 'failed');
  failed.data.items[0].error = 'RESPONSE_MISSING_ITEM';
  harness.batchCalls[0].resolve(failed);
  await first;
  assert.deepEqual(progress.failures, [{ kind: 'missing', count: 1 }]);
  await engine.cancel();
  const retry = engine.retryFailed(options, report);
  await engine.retryFailed(options, report);
  await until(() => harness.batchCalls.length === 2);
  assert.equal(progress.pending, 1);
  assert.equal(progress.errors, 0);
  assert.equal(harness.ports.length, 2);
  const next = harness.batchCalls[1].message.payload;
  assert.equal(next.requestId, payload.requestId);
  assert.equal(next.manualRetryFailed, true);
  assert.deepEqual(next.items, payload.items);
  harness.batchCalls[1].resolve(batchResult(next, 'RETRIED'));
  await retry;
  assert.equal(node.textContent, 'RETRIED');
  assert.equal(progress.done, 1);
  assert.equal(progress.errors, 0);
  assert.equal(harness.batchCalls.length, 2);
});

test('manual retry does not resubmit removed or website-revised text or exhausted budgets', async () => {
  const { PageTranslateEngine } = await import('../src/content/page-translator/engine.ts');
  for (const scenario of ['revised', 'removed', 'budget']) {
    const node = textNode('Original page paragraph');
    const harness = installBrowser(() => ({ success: false }));
    const engine = new PageTranslateEngine();
    let progress;
    const first = engine.start(options, (value) => { progress = value; });
    await until(() => harness.batchCalls.length === 1);
    const failed = batchResult(harness.batchCalls[0].message.payload, '', 'failed');
    if (scenario === 'budget') failed.data.items[0].error = 'PAGE_BUDGET_EXCEEDED';
    harness.batchCalls[0].resolve(failed);
    await first;
    if (scenario === 'revised') node.textContent = 'Website changed this paragraph';
    if (scenario === 'removed') node.isConnected = false;
    await engine.retryFailed(options, (value) => { progress = value; });
    assert.equal(harness.batchCalls.length, 1, scenario);
    if (scenario === 'budget') assert.equal(progress.budgetExhausted, true);
    else {
      assert.equal(progress.errors, 0, scenario);
      assert.equal(progress.cancelled, 1, scenario);
    }
  }
});

test('a late success, failure, or recovery from the previous task cannot change the new task', async () => {
  const { PageTranslateEngine } = await import('../src/content/page-translator/engine.ts');
  const cases = [
    {
      name: 'success',
      settle(call) { call.resolve(batchResult(call.message.payload, 'OLD-TEXT')); },
    },
    {
      name: 'failure',
      settle(call) { call.resolve({ success: false, error: 'BACKGROUND_UNAVAILABLE' }); },
    },
    {
      name: 'recovery',
      settle(call) { call.reject(new Error('port disconnected')); },
    },
  ];
  for (const scenario of cases) {
    const node = textNode(`Hello ${scenario.name} paragraph`);
    const original = node.textContent;
    const harness = installBrowser(() => ({
      success: true,
      data: {
        requestsUsed: 1,
        charsUsed: 10,
        batches: { 'batch-0001': { status: 'interrupted/unknown', attempt: 1 } },
      },
    }));
    const engine = new PageTranslateEngine();
    const first = engine.start(options, () => {});
    await until(() => harness.batchCalls.length === 1);
    await engine.restore();
    const second = engine.start(options, () => {});
    await until(() => harness.batchCalls.length === 2);
    const nextPayload = harness.batchCalls[1].message.payload;
    scenario.settle(harness.batchCalls[0]);
    await first;
    assert.equal(engine.running, true, scenario.name);
    assert.equal(node.textContent, original, scenario.name);
    assert.equal(
      harness.sent.some((message) => message.payload?.action === 'complete' && message.payload.taskId === nextPayload.taskId),
      false,
      scenario.name,
    );
    harness.batchCalls[1].resolve(batchResult(nextPayload, 'NEW-TEXT'));
    await second;
    assert.equal(node.textContent.includes('NEW-TEXT'), true, scenario.name);
    assert.equal(node.textContent.includes('OLD-TEXT'), false, scenario.name);
    assert.equal(
      harness.sent.filter((message) => message.payload?.action === 'complete').at(-1).payload.taskId,
      nextPayload.taskId,
      scenario.name,
    );
  }
});

test('manual retry rebinds the stream port and shows an item before the final reply', async () => {
  const { PageTranslateEngine } = await import('../src/content/page-translator/engine.ts');
  const node = textNode('Retry after the port drops');
  const harness = installBrowser(() => ({ success: false, error: 'NO_RECOVERY' }));
  const engine = new PageTranslateEngine();
  const first = engine.start(options, () => {});
  await until(() => harness.batchCalls.length === 1);
  const firstPayload = harness.batchCalls[0].message.payload;
  harness.batchCalls[0].resolve(batchResult(firstPayload, '', 'interrupted/unknown'));
  await first;
  assert.equal(harness.ports.length, 1);
  harness.ports[0].disconnect();
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(harness.ports.length, 1);

  const retry = engine.retryUnknown(options, () => {});
  await until(() => harness.ports.length === 2 && harness.batchCalls.length === 2);
  const retryPayload = harness.batchCalls[1].message.payload;
  assert.equal(retryPayload.taskId, firstPayload.taskId);
  harness.ports[1].emit({
    type: 'stream-item',
    taskId: retryPayload.taskId,
    sessionId: retryPayload.sessionId,
    generation: retryPayload.generation,
    batchId: retryPayload.batchId,
    requestId: retryPayload.requestId,
    attempt: 2,
    item: { id: retryPayload.items[0].id, text: 'STREAM-TEXT' },
  });
  await new Promise((resolve) => setTimeout(resolve, 40));
  assert.equal(node.textContent.includes('STREAM-TEXT'), true);
  harness.ports[0].emit({
    type: 'stream-item',
    taskId: firstPayload.taskId,
    sessionId: firstPayload.sessionId,
    generation: firstPayload.generation,
    batchId: firstPayload.batchId,
    requestId: firstPayload.requestId,
    attempt: 1,
    item: { id: firstPayload.items[0].id, text: 'OLD-PORT' },
  });
  await new Promise((resolve) => setTimeout(resolve, 40));
  assert.equal(node.textContent.includes('OLD-PORT'), false);
  const connects = harness.ports.length;
  harness.ports[1].disconnect();
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(harness.ports.length, connects);
  harness.batchCalls[1].resolve(batchResult(retryPayload, 'FINAL-TEXT'));
  await retry;
  assert.equal(node.textContent.includes('STREAM-TEXT') || node.textContent.includes('FINAL-TEXT'), true);
});
