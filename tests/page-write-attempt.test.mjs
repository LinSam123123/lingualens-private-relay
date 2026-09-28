import assert from 'node:assert/strict';
import test from 'node:test';

import {
  listBatchDiagnostics,
  resetBatchDiagnosticsForTests,
  setBatchDiagnosticsEnabled,
} from '../src/background/batch-diagnostics.ts';
import { TranslationScheduler } from '../src/background/scheduler.ts';
import { listenForPagePort, resetPagePortsForTests } from '../src/shared/stream-delivery.ts';

globalThis.NodeFilter = { SHOW_TEXT: 4, FILTER_ACCEPT: 1, FILTER_REJECT: 2, FILTER_SKIP: 3 };
globalThis.getComputedStyle = () => ({
  display: 'block', visibility: 'visible', opacity: '1', position: 'static',
});

function mount(texts) {
  const nodes = texts.map((value) => {
    const parent = {
      nodeType: 1, tagName: 'P', className: '', isContentEditable: false,
      childNodes: [], parentElement: null, parentNode: null,
      hasAttribute: () => false, getAttribute: () => null, closest: () => null, textContent: value,
    };
    const node = { nodeType: 3, textContent: value, parentElement: parent, parentNode: parent };
    parent.childNodes = [node];
    return node;
  });
  const body = {
    nodeType: 1, tagName: 'BODY', className: '', isContentEditable: false,
    childNodes: nodes.map((node) => node.parentElement),
    parentElement: null, parentNode: null,
    hasAttribute: () => false, getAttribute: () => null, closest: () => null,
  };
  for (const node of nodes) {
    node.parentElement.parentElement = body;
    node.parentElement.parentNode = body;
  }
  globalThis.document = {
    body,
    createTreeWalker() {
      const pending = [...nodes];
      return { nextNode() { return pending.shift() ?? null; } };
    },
    createElement() { return { dataset: {}, style: {}, textContent: '', remove() {} }; },
  };
  return nodes;
}

function installBrowser() {
  let store = {};
  const calls = [];
  const pageWrites = [];
  const ports = [];
  globalThis.browser = {
    storage: {
      session: {
        async get() { return structuredClone(store); },
        async set(value) { store = structuredClone(value); },
      },
    },
    runtime: {
      connect() {
        const messageListeners = [];
        const port = {
          onMessage: { addListener(fn) { messageListeners.push(fn); } },
          onDisconnect: { addListener() {} },
          postMessage(message) {
            if (message?.type === 'page-write') pageWrites.push(message);
            if (message?.type === 'bind') {
              queueMicrotask(() => messageListeners.forEach((fn) => fn({
                type: 'bound',
                taskId: message.taskId,
                sessionId: message.sessionId,
                generation: message.generation,
              })));
            }
          },
          disconnect() {},
          emit(message) { messageListeners.forEach((fn) => fn(message)); },
        };
        ports.push(port);
        return port;
      },
      sendMessage(message) {
        if (message.type === 'TRANSLATE_BATCH') {
          return new Promise((resolve) => calls.push({ message, resolve }));
        }
        return Promise.resolve({ success: true, data: null });
      },
    },
  };
  return { calls, pageWrites, ports };
}

const relayConfig = {
  id: 'private-relay', type: 'relay', name: 'Private Relay', enabled: true,
  baseUrl: 'http://127.0.0.1:9/v1', model: 'mock-model', protocol: 'chat-completions',
  streamTranslations: true, timeoutMs: 25_000, maxConcurrency: 2,
  maxCharsPerRequest: 8_000, maxItemsPerRequest: 0, maxPageChars: 100_000, maxPageRequests: 20,
};

function pageOptions(maxChars = 8_000) {
  return {
    targetLang: 'zh-CN', sourceLang: 'en', displayMode: 'replace',
    maxCharsPerRequest: maxChars, maxItemsPerRequest: 0, maxPageChars: 100_000, maxPageRequests: 20,
  };
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function until(fn) {
  for (let i = 0; i < 40; i += 1) {
    if (fn()) return;
    await sleep(5);
  }
  throw new Error('timed out');
}

async function settledCalls(browser, minimum) {
  let previous = -1;
  let stable = 0;
  for (let i = 0; i < 50; i += 1) {
    const count = browser.calls.length;
    if (count >= minimum && count === previous) {
      stable += 1;
      if (stable >= 3) return;
    } else {
      stable = 0;
      previous = count;
    }
    await sleep(5);
  }
  throw new Error(`timed out waiting for calls, saw ${browser.calls.length}`);
}

function hub() {
  resetPagePortsForTests();
  const listeners = [];
  const port = {
    sender: { id: 'ext', tab: { id: 4 }, frameId: 0 },
    onMessage: { addListener(fn) { listeners.push(fn); } },
    onDisconnect: { addListener() {} },
    postMessage() {},
    disconnect() {},
  };
  listenForPagePort(port, Promise.resolve('ext'));
  return {
    async deliver(write) {
      await new Promise((resolve) => setTimeout(resolve, 0));
      for (const listener of listeners) {
        listener({
          type: 'bind', taskId: write.taskId, sessionId: write.sessionId, generation: write.generation,
        });
        listener(write);
      }
    },
  };
}

test('each attempt gets its own write acknowledgement from the real page engine', async () => {
  const { PageTranslateEngine } = await import('../src/content/page-translator/engine.ts');
  resetBatchDiagnosticsForTests();
  setBatchDiagnosticsEnabled(true);
  const browser = installBrowser();
  const background = hub();
  const [firstNode, secondNode] = mount(['First visible sentence', 'Second visible sentence']);
  const engine = new PageTranslateEngine();
  const scheduler = new TranslationScheduler();
  const firstRun = engine.start(pageOptions(), () => {});
  await until(() => browser.calls.length === 1);
  const payload = browser.calls[0].message.payload;
  const first = await scheduler.submit(payload, 4, 0, {
    async *streamItems(items) {
      yield { type: 'item', item: { id: items[0].id, text: '甲' } };
    },
    async translateItems() { throw new Error('BLOCKING_FALLBACK'); },
  }, relayConfig);
  assert.equal(first.status, 'interrupted/unknown');
  assert.equal(first.items.filter((item) => item.status === 'completed').length, 1);
  browser.calls[0].resolve({ success: true, data: first });
  await firstRun;
  await new Promise((resolve) => setTimeout(resolve, 40));
  assert.equal(firstNode.textContent, '甲');
  assert.equal(secondNode.textContent, 'Second visible sentence');
  assert.deepEqual(browser.pageWrites.map((write) => write.attempt), [first.attempts]);
  await background.deliver(browser.pageWrites[0]);
  const attemptOne = listBatchDiagnostics().find((entry) => entry.requestId === payload.requestId && entry.attempt === first.attempts);
  assert.equal(typeof attemptOne.firstPageWriteMs, 'number');

  const retry = engine.retryUnknown(pageOptions(), () => {});
  await until(() => browser.calls.length === 2);
  const retryPayload = browser.calls[1].message.payload;
  assert.equal(retryPayload.requestId, payload.requestId);
  assert.equal(retryPayload.items.length, 1);
  const second = await scheduler.submit({ ...retryPayload, manualRetryUnknown: true }, 4, 0, {
    async *streamItems(items) {
      yield { type: 'text-delta' };
      yield { type: 'item', item: { id: items[0].id, text: '乙' } };
      yield { type: 'terminal', kind: 'completed', code: 'STREAM_COMPLETED' };
    },
    async translateItems() { throw new Error('BLOCKING_FALLBACK'); },
  }, relayConfig);
  assert.equal(second.attempts > first.attempts, true);
  const beforeSecondWrite = listBatchDiagnostics().find((entry) => entry.attempt === second.attempts);
  assert.equal(beforeSecondWrite.firstPageWriteMs, null);
  browser.ports.at(-1).emit({
    type: 'stream-item',
    taskId: retryPayload.taskId,
    sessionId: retryPayload.sessionId,
    generation: retryPayload.generation,
    batchId: retryPayload.batchId,
    requestId: retryPayload.requestId,
    attempt: second.attempts,
    item: { id: retryPayload.items[0].id, text: '乙' },
  });
  await new Promise((resolve) => setTimeout(resolve, 40));
  const secondWrite = browser.pageWrites.find((write) => write.attempt === second.attempts);
  assert.ok(secondWrite);
  assert.equal(browser.pageWrites.filter((write) => write.attempt === first.attempts).length, 1);
  await background.deliver(secondWrite);
  browser.calls[1].resolve({ success: true, data: second });
  await retry;
  const rows = listBatchDiagnostics().filter((entry) => entry.requestId === payload.requestId);
  assert.equal(rows.find((entry) => entry.attempt === first.attempts).firstPageWriteMs, attemptOne.firstPageWriteMs);
  assert.equal(secondNode.textContent, '乙');
  assert.equal(typeof rows.find((entry) => entry.attempt === second.attempts).firstPageWriteMs, 'number');
  assert.notEqual(
    rows.find((entry) => entry.attempt === second.attempts).firstPageWriteMs,
    null,
  );
});

test('one attempt acknowledges once, a split node is owned by the completing attempt, and a new task is isolated', async () => {
  const { PageTranslateEngine } = await import('../src/content/page-translator/engine.ts');
  resetBatchDiagnosticsForTests();
  setBatchDiagnosticsEnabled(true);
  const browser = installBrowser();
  const background = hub();
  const [alpha, beta] = mount(['Alpha sentence', 'Beta sentence']);
  const engine = new PageTranslateEngine();
  const scheduler = new TranslationScheduler();
  const narrow = { ...relayConfig, maxCharsPerRequest: 12 };
  const run = engine.start(pageOptions(), () => {});
  await until(() => browser.calls.length === 1);
  const payload = browser.calls[0].message.payload;
  const both = await scheduler.submit(payload, 4, 0, {
    async *streamItems(items) {
      yield { type: 'item', item: { id: items[0].id, text: 'A' } };
      yield { type: 'item', item: { id: items[1].id, text: 'B' } };
      yield { type: 'terminal', kind: 'completed', code: 'STREAM_COMPLETED' };
    },
    async translateItems() { throw new Error('BLOCKING_FALLBACK'); },
  }, relayConfig);
  browser.calls[0].resolve({ success: true, data: both });
  await run;
  await sleep(40);
  assert.equal(alpha.textContent, 'A');
  assert.equal(beta.textContent, 'B');
  assert.equal(browser.pageWrites.filter((write) => write.attempt === both.attempts).length, 1);
  await background.deliver(browser.pageWrites[0]);
  const oldTiming = listBatchDiagnostics().find((entry) => (
    entry.requestId === payload.requestId && entry.attempt === both.attempts
  )).firstPageWriteMs;
  assert.equal(typeof oldTiming, 'number');

  await engine.restore();
  browser.pageWrites.length = 0;
  const original = 'A much longer public paragraph that has to be split across chunks.';
  const [paragraph] = mount([original]);
  const again = engine.start(pageOptions(12), () => {});
  await settledCalls(browser, 2);
  const longCalls = browser.calls.slice(1);
  const chunkIds = longCalls.flatMap((call) => call.message.payload.items.map((item) => item.id));
  assert.equal(longCalls.length > 1, true);
  assert.equal(chunkIds.length > 1, true);
  const partial = await scheduler.submit(longCalls[0].message.payload, 5, 0, {
    async *streamItems(items) {
      yield { type: 'item', item: { id: items[0].id, text: '段' } };
    },
    async translateItems() { throw new Error('BLOCKING_FALLBACK'); },
  }, narrow);
  longCalls[0].resolve({ success: true, data: partial });
  for (const call of longCalls.slice(1)) {
    const dropped = await scheduler.submit(call.message.payload, 5, 0, {
      async *streamItems() {},
      async translateItems() { throw new Error('BLOCKING_FALLBACK'); },
    }, narrow);
    assert.equal(dropped.status, 'interrupted/unknown');
    call.resolve({ success: true, data: dropped });
  }
  await again;
  await sleep(40);
  assert.equal(paragraph.textContent, original);
  assert.equal(browser.pageWrites.length, 0);
  browser.ports.at(-1).emit({
    type: 'stream-item',
    taskId: payload.taskId,
    sessionId: payload.sessionId,
    generation: payload.generation,
    batchId: payload.batchId,
    requestId: payload.requestId,
    attempt: both.attempts,
    item: { id: payload.items[0].id, text: '旧任务' },
  });
  assert.equal(paragraph.textContent, original);
  const partialRow = () => listBatchDiagnostics().find((entry) => (
    entry.requestId === longCalls[0].message.payload.requestId && entry.attempt === partial.attempts
  ));
  assert.equal(partialRow().firstPageWriteMs, null);

  const retry = engine.retryUnknown(pageOptions(12), () => {});
  await settledCalls(browser, browser.calls.length + 1);
  const retryCalls = browser.calls.slice(1 + longCalls.length);
  const lastChunkId = chunkIds[chunkIds.length - 1];
  const completingCall = retryCalls.find((call) => call.message.payload.items.some((item) => item.id === lastChunkId));
  assert.ok(completingCall);
  const earlier = retryCalls.filter((call) => call !== completingCall);
  assert.equal(earlier.length > 0, true);
  for (const call of earlier) {
    const done = await scheduler.submit({ ...call.message.payload, manualRetryUnknown: true }, 5, 0, {
      async *streamItems(items) {
        for (const item of items) yield { type: 'item', item: { id: item.id, text: '齐' } };
        yield { type: 'terminal', kind: 'completed', code: 'STREAM_COMPLETED' };
      },
      async translateItems() { throw new Error('BLOCKING_FALLBACK'); },
    }, narrow);
    call.resolve({ success: true, data: done });
    await sleep(0);
  }
  await sleep(40);
  assert.equal(browser.pageWrites.length, 0);
  assert.equal(paragraph.textContent, original);
  const finished = await scheduler.submit({ ...completingCall.message.payload, manualRetryUnknown: true }, 5, 0, {
    async *streamItems(items) {
      for (const item of items) yield { type: 'item', item: { id: item.id, text: '齐' } };
      yield { type: 'terminal', kind: 'completed', code: 'STREAM_COMPLETED' };
    },
    async translateItems() { throw new Error('BLOCKING_FALLBACK'); },
  }, narrow);
  assert.notEqual(finished.attempts, partial.attempts);
  browser.ports.at(-1).emit({
    type: 'stream-item',
    taskId: completingCall.message.payload.taskId,
    sessionId: completingCall.message.payload.sessionId,
    generation: completingCall.message.payload.generation,
    batchId: completingCall.message.payload.batchId,
    requestId: completingCall.message.payload.requestId,
    attempt: finished.attempts,
    item: { id: lastChunkId, text: '齐' },
  });
  await sleep(40);
  assert.equal(paragraph.textContent.includes('段'), true);
  assert.equal(paragraph.textContent.includes('齐'), true);
  assert.equal(browser.pageWrites.length, 1);
  const completingWrite = browser.pageWrites[0];
  assert.equal(completingWrite.attempt, finished.attempts);
  assert.equal(completingWrite.requestId, completingCall.message.payload.requestId);
  assert.equal(browser.pageWrites.some((write) => write.attempt === partial.attempts), false);
  completingCall.resolve({ success: true, data: finished });
  await retry;
  await sleep(40);
  assert.equal(browser.pageWrites.length, 1);

  const lateOld = {
    type: 'page-write',
    taskId: payload.taskId,
    sessionId: payload.sessionId,
    generation: payload.generation,
    batchId: payload.batchId,
    requestId: payload.requestId,
    attempt: both.attempts,
  };
  const idleAttempt = earlier[0].message.payload;
  const idleRow = () => listBatchDiagnostics().find((entry) => (
    entry.requestId === idleAttempt.requestId && entry.attempt > partial.attempts
  ));
  assert.equal(idleRow().firstPageWriteMs, null);
  await background.deliver(lateOld);
  assert.equal(partialRow().firstPageWriteMs, null);
  assert.equal(idleRow().firstPageWriteMs, null);
  assert.equal(listBatchDiagnostics().find((entry) => (
    entry.requestId === payload.requestId && entry.attempt === both.attempts
  )).firstPageWriteMs, oldTiming);
  await background.deliver(completingWrite);
  assert.equal(partialRow().firstPageWriteMs, null);
  assert.equal(idleRow().firstPageWriteMs, null);
  assert.equal(typeof listBatchDiagnostics().find((entry) => (
    entry.requestId === completingWrite.requestId && entry.attempt === finished.attempts
  )).firstPageWriteMs, 'number');
  assert.equal(listBatchDiagnostics().find((entry) => (
    entry.requestId === payload.requestId && entry.attempt === both.attempts
  )).firstPageWriteMs, oldTiming);
});
