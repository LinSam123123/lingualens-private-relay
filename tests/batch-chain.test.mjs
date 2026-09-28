import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import { combineBatchResult } from '../src/background/batch-result.ts';
import { classifyStreamItems } from '../src/background/scheduler-policy.ts';
import { statusBarFlags } from '../src/content/page-translator/status-bar-state.ts';

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
  const calls = [];
  globalThis.browser = {
    runtime: {
      connect() {
        const listeners = [];
        return {
          onMessage: { addListener(fn) { listeners.push(fn); } },
          onDisconnect: { addListener() {} },
          postMessage(message) {
            if (message?.type === 'bind') {
              queueMicrotask(() => listeners.forEach((fn) => fn({
                type: 'bound', taskId: message.taskId, sessionId: message.sessionId, generation: message.generation,
              })));
            }
          },
          disconnect() {},
        };
      },
      sendMessage(message) {
        if (message.type === 'TRANSLATE_BATCH') {
          return new Promise((resolve, reject) => calls.push({ message, resolve, reject }));
        }
        return Promise.resolve({ success: true, data: null });
      },
    },
  };
  return calls;
}

const pageOptions = {
  targetLang: 'zh-CN', sourceLang: 'en', displayMode: 'replace',
  maxCharsPerRequest: 8_000, maxItemsPerRequest: 0, maxPageChars: 100_000, maxPageRequests: 100,
};

function routedFromScheduler(payload, itemResults, schedulerStatus, attempts = 1) {
  const scheduled = {
    taskId: payload.taskId,
    batchId: payload.batchId,
    requestId: payload.requestId,
    status: schedulerStatus,
    attempts,
    requestsUsed: 1,
    charsUsed: 10,
    items: itemResults,
  };
  return combineBatchResult(payload, payload.items.map((item) => ({
    id: item.id,
    cachedText: null,
    scheduled: itemResults.find((entry) => entry.id === item.id),
  })), scheduled);
}

async function until(fn) {
  for (let i = 0; i < 40; i += 1) {
    if (fn()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error('timed out');
}

test('router keeps an abnormal scheduler status and the page does not call it a normal success', async () => {
  const router = await readFile(new URL('../src/background/message-router.ts', import.meta.url), 'utf8');
  assert.match(router, /combineBatchResult\(/);
  assert.equal(/items\.every\(\(item\) => item\.status === 'completed'\)\s*\?\s*'completed'/.test(router), false);

  const classified = classifyStreamItems({
    expectedIds: ['seg-a', 'seg-b'],
    acceptedIds: ['seg-a', 'seg-b'],
    rejected: [],
    terminal: null,
    cancelled: false,
    timedOut: true,
  });
  assert.equal(classified.status, 'interrupted/unknown');
  assert.deepEqual(classified.items.map((item) => item.status), ['completed', 'completed']);

  const preserved = combineBatchResult({
    taskId: 'task-chain-01', batchId: 'batch-0001', requestId: 'request-chain-01',
  }, [
    { id: 'seg-a', cachedText: null, scheduled: { id: 'seg-a', status: 'completed', translated: '甲' } },
    { id: 'seg-b', cachedText: null, scheduled: { id: 'seg-b', status: 'completed', translated: '乙' } },
  ], {
    taskId: 'task-chain-01', batchId: 'batch-0001', requestId: 'request-chain-01',
    status: classified.status, attempts: 1, requestsUsed: 1, charsUsed: 4,
    items: classified.items.map((item, index) => ({ ...item, translated: index ? '乙' : '甲' })),
  });
  assert.equal(preserved.status, 'interrupted/unknown');

  const cacheOnly = combineBatchResult({
    taskId: 'task-chain-01', batchId: 'batch-0001', requestId: 'request-chain-01',
  }, [
    { id: 'seg-a', cachedText: '甲' },
    { id: 'seg-b', cachedText: '乙' },
  ], null);
  assert.equal(cacheOnly.status, 'completed');

  const mixed = combineBatchResult({
    taskId: 'task-chain-01', batchId: 'batch-0001', requestId: 'request-chain-01',
  }, [
    { id: 'seg-a', cachedText: '甲' },
    { id: 'seg-b', cachedText: null, scheduled: { id: 'seg-b', status: 'completed', translated: '乙' } },
  ], {
    taskId: 'task-chain-01', batchId: 'batch-0001', requestId: 'request-chain-01',
    status: 'interrupted/unknown', attempts: 1, requestsUsed: 1, charsUsed: 2,
    items: [{ id: 'seg-b', status: 'completed', translated: '乙' }],
  });
  assert.equal(mixed.status, 'interrupted/unknown');
  assert.equal(mixed.items.every((item) => item.status === 'completed'), true);

  const { PageTranslateEngine } = await import('../src/content/page-translator/engine.ts');
  const calls = installBrowser();
  mount(['Hello chain paragraph']);
  const engine = new PageTranslateEngine();
  let progress = null;
  const run = engine.start(pageOptions, (next) => { progress = next; });
  await until(() => calls.length === 1);
  const payload = calls[0].message.payload;
  const clean = classifyStreamItems({
    expectedIds: payload.items.map((item) => item.id),
    acceptedIds: payload.items.map((item) => item.id),
    rejected: [],
    terminal: 'completed',
    cancelled: false,
    timedOut: false,
  });
  calls[0].resolve({
    success: true,
    data: routedFromScheduler(payload, payload.items.map((item) => ({
      id: item.id, status: 'completed', translated: '完整',
    })), clean.status),
  });
  await run;
  assert.equal(progress.abnormalBatches, 0);
  assert.equal(statusBarFlags(progress).showBatchAnomaly, false);
  assert.equal(engine.running, false);
});

test('all items received after a dropped stream stay visible without a retry or a fake success', async () => {
  const { PageTranslateEngine } = await import('../src/content/page-translator/engine.ts');
  const calls = installBrowser();
  mount(['Another public paragraph']);
  const engine = new PageTranslateEngine();
  let progress = null;
  const run = engine.start(pageOptions, (next) => { progress = next; });
  await until(() => calls.length === 1);
  const payload = calls[0].message.payload;
  const dropped = classifyStreamItems({
    expectedIds: payload.items.map((item) => item.id),
    acceptedIds: payload.items.map((item) => item.id),
    rejected: [],
    terminal: null,
    cancelled: false,
    timedOut: true,
  });
  const data = routedFromScheduler(payload, payload.items.map((item) => ({
    id: item.id, status: 'completed', translated: '已收到',
  })), dropped.status);
  assert.equal(data.status, 'interrupted/unknown');
  calls[0].resolve({ success: true, data });
  await run;
  assert.equal(progress.done, progress.total);
  assert.equal(progress.unknown, 0);
  assert.equal(progress.abnormalBatches, 1);
  assert.equal(progress.done + progress.unknown + progress.errors + progress.cancelled <= progress.total, true);
  const flags = statusBarFlags(progress);
  assert.equal(flags.showBatchAnomaly, true);
  assert.equal(flags.anomalyCount, 1);
  assert.equal(flags.overTotal, false);
  const retry = engine.retryUnknown(pageOptions, () => {});
  await retry;
  assert.equal(calls.length, 1);
  assert.equal(progress.abnormalBatches, 1);
});

test('a later clean retry clears the batch warning and a partial drop does not', async () => {
  const { PageTranslateEngine } = await import('../src/content/page-translator/engine.ts');
  const calls = installBrowser();
  mount(['First sentence here', 'Second sentence here']);
  const engine = new PageTranslateEngine();
  let progress = null;
  const run = engine.start(pageOptions, (next) => { progress = next; });
  await until(() => calls.length === 1);
  const payload = calls[0].message.payload;
  assert.equal(payload.items.length, 2);
  const [kept, missing] = payload.items;
  calls[0].resolve({
    success: true,
    data: routedFromScheduler(payload, [
      { id: kept.id, status: 'completed', translated: '甲' },
      { id: missing.id, status: 'interrupted/unknown', error: 'STREAM_INTERRUPTED_UNKNOWN' },
    ], 'interrupted/unknown'),
  });
  await run;
  assert.equal(progress.unknown, 1);
  assert.equal(progress.abnormalBatches, 0);
  assert.equal(statusBarFlags(progress).showBatchAnomaly, false);

  const retry = engine.retryUnknown(pageOptions, (next) => { progress = next; });
  await until(() => calls.length === 2);
  const retryPayload = calls[1].message.payload;
  assert.deepEqual(retryPayload.items.map((item) => item.id), [missing.id]);
  calls[1].resolve({
    success: true,
    data: routedFromScheduler(retryPayload, [
      { id: missing.id, status: 'completed', translated: '乙' },
    ], 'completed', 2),
  });
  await retry;
  assert.equal(progress.unknown, 0);
  assert.equal(progress.done, 2);
  assert.equal(progress.abnormalBatches, 0);
  assert.equal(statusBarFlags(progress).showBatchAnomaly, false);
});

test('a normal end with a missing id stays failed, and a new task ignores the old anomaly', async () => {
  const { PageTranslateEngine } = await import('../src/content/page-translator/engine.ts');
  const calls = installBrowser();
  const nodes = mount(['Stable sentence one', 'Stable sentence two']);
  const engine = new PageTranslateEngine();
  let progress = null;
  const first = engine.start(pageOptions, (next) => { progress = next; });
  await until(() => calls.length === 1);
  const payload = calls[0].message.payload;
  calls[0].resolve({
    success: true,
    data: routedFromScheduler(payload, [
      { id: payload.items[0].id, status: 'completed', translated: '甲' },
      { id: payload.items[1].id, status: 'failed', error: 'RESPONSE_MISSING_ITEM' },
    ], 'failed'),
  });
  await first;
  assert.equal(progress.errors, 1);
  assert.equal(progress.abnormalBatches, 0);
  assert.equal(statusBarFlags(progress).showBatchAnomaly, false);

  await engine.restore();
  const second = engine.start(pageOptions, (next) => { progress = next; });
  await until(() => calls.length === 2);
  calls[0].resolve({
    success: true,
    data: routedFromScheduler(payload, payload.items.map((item) => ({
      id: item.id, status: 'completed', translated: '旧异常',
    })), 'interrupted/unknown'),
  });
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(engine.running, true);
  assert.equal(nodes[0].textContent.includes('旧异常'), false);
  calls[1].resolve({
    success: true,
    data: routedFromScheduler(calls[1].message.payload, calls[1].message.payload.items.map((item) => ({
      id: item.id, status: 'completed', translated: '新译文',
    })), 'completed'),
  });
  await second;
  assert.equal(progress.abnormalBatches, 0);
  assert.equal(nodes.some((node) => node.textContent.includes('新译文')), true);
});
