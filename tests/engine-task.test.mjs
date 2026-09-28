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
  globalThis.browser = {
    runtime: {
      connect() {
        return {
          onMessage: { addListener() {} },
          onDisconnect: { addListener() {} },
          postMessage() {},
          disconnect() {},
        };
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
  return { batchCalls, sent };
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
