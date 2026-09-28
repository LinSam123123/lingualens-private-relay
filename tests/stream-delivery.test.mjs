import assert from 'node:assert/strict';
import test from 'node:test';

import {
  decideStreamApply,
  listPageWrites,
  listenForPagePort,
  publishStreamItem,
  readyDomIds,
  resetPagePortsForTests,
  shouldFlushDom,
} from '../src/shared/stream-delivery.ts';

function fakePort(sender) {
  const messageListeners = [];
  const disconnectListeners = [];
  return {
    sender,
    posted: [],
    disconnected: false,
    onMessage: { addListener(fn) { messageListeners.push(fn); } },
    onDisconnect: { addListener(fn) { disconnectListeners.push(fn); } },
    postMessage(message) { this.posted.push(message); },
    disconnect() {
      this.disconnected = true;
      for (const fn of disconnectListeners) fn();
    },
    emit(message) {
      for (const fn of messageListeners) fn(message);
    },
  };
}

const binding = {
  tabId: 7,
  frameId: 0,
  taskId: 'task-1',
  sessionId: 'session-1',
  generation: 2,
};

function state(overrides = {}) {
  return {
    taskId: 'task-1',
    sessionId: 'session-1',
    generation: 2,
    closed: false,
    translatedIds: new Set(),
    expectedIds: new Set(['seg-a', 'seg-b']),
    ...overrides,
  };
}

function itemMessage(overrides = {}) {
  return {
    type: 'stream-item',
    ...binding,
    batchId: 'batch-0001',
    requestId: 'request-1',
    attempt: 1,
    item: { id: 'seg-a', text: '你好' },
    ...overrides,
  };
}

test('page writes wait until every chunk of a DOM node is present', () => {
  const nodes = [
    { domItemId: 'node-1', chunkIds: ['seg-a', 'seg-b'] },
    { domItemId: 'node-2', chunkIds: ['seg-c'] },
  ];
  assert.deepEqual(readyDomIds(nodes, new Set(['seg-a'])), []);
  assert.deepEqual(readyDomIds(nodes, new Set(['seg-a', 'seg-b'])), ['node-1']);
  assert.equal(shouldFlushDom(1, 10, false), false);
  assert.equal(shouldFlushDom(1, 32, false), true);
  assert.equal(shouldFlushDom(1, 0, true), true);
});

test('late, duplicate, unknown, and foreign tasks do not apply', () => {
  assert.equal(decideStreamApply(state(), itemMessage()), 'apply');
  assert.equal(decideStreamApply(state({ closed: true }), itemMessage()), 'ignore');
  assert.equal(decideStreamApply(state({ generation: 3 }), itemMessage()), 'ignore');
  assert.equal(decideStreamApply(state({ taskId: 'other' }), itemMessage()), 'ignore');
  assert.equal(decideStreamApply(state({ translatedIds: new Set(['seg-a']) }), itemMessage()), 'ignore');
  assert.equal(decideStreamApply(state(), itemMessage({ item: { id: 'other', text: 'nope' } })), 'ignore');
  assert.equal(decideStreamApply(state(), itemMessage({ item: { id: 'seg-a', text: ' ' } })), 'ignore');
});

test('port listeners queue until initialization, then reject the wrong sender and foreign frames', async () => {
  resetPagePortsForTests();
  let resolveReady;
  const ready = new Promise((resolve) => { resolveReady = resolve; });
  const content = fakePort({ id: 'ext', tab: { id: 7 }, frameId: 0 });
  listenForPagePort(content, ready);
  content.emit({ type: 'bind', taskId: 'task-1', sessionId: 'session-1', generation: 2 });
  content.emit({
    type: 'page-write',
    taskId: 'task-1',
    sessionId: 'session-1',
    generation: 2,
    batchId: 'batch-0001',
    requestId: 'request-1',
    attempt: 1,
    text: 'should not be stored',
    authorization: 'Bearer secret',
  });
  assert.equal(publishStreamItem(itemMessage()), false);
  resolveReady('ext');
  await ready;
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.deepEqual(listPageWrites(), [{
    type: 'page-write',
    taskId: 'task-1',
    sessionId: 'session-1',
    generation: 2,
    batchId: 'batch-0001',
    requestId: 'request-1',
    attempt: 1,
  }]);
  assert.equal(JSON.stringify(listPageWrites()).includes('should not be stored'), false);
  assert.equal(publishStreamItem(itemMessage()), true);
  assert.equal(content.posted.find((message) => message.type === 'stream-item').item.text, '你好');
  assert.equal(content.posted.some((message) => message.type === 'bound'), true);
  assert.equal(publishStreamItem(itemMessage({ frameId: 1 })), false);
  assert.equal(publishStreamItem(itemMessage({ generation: 1 })), false);

  const outsider = fakePort({ id: 'other', tab: { id: 7 }, frameId: 0 });
  listenForPagePort(outsider, Promise.resolve('ext'));
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(outsider.disconnected, true);

  const options = fakePort({ id: 'ext', url: 'chrome-extension://ext/options.html' });
  listenForPagePort(options, Promise.resolve('ext'));
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(options.disconnected, true);
});
