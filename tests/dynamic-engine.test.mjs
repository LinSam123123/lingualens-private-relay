import assert from 'node:assert/strict';
import test from 'node:test';
import { PageTranslateEngine } from '../src/content/page-translator/engine.ts';
import { TranslationScheduler } from '../src/background/scheduler.ts';
import { getTaskJournal, initializeTaskJournal, removeOtherDocumentJournals, ensureTask, consumeDispatchBudget, ensureTaskControl } from '../src/background/task-journal.ts';

const options = { targetLang: 'zh-CN', sourceLang: 'en', displayMode: 'replace',
  maxCharsPerRequest: 500, maxItemsPerRequest: 5, maxPageChars: 100_000, maxPageRequests: 100, continuous: true };

function mount() {
  const mutations = [];
  const intersections = [];
  const listeners = new Map();
  globalThis.NodeFilter = { SHOW_TEXT: 4, FILTER_ACCEPT: 1, FILTER_REJECT: 2 };
  globalThis.window = { innerHeight: 800, innerWidth: 1200 };
  globalThis.getComputedStyle = (el) => ({
    display: el.hidden ? 'none' : 'block', visibility: 'visible', opacity: '1', position: 'static',
  });
  globalThis.MutationObserver = class {
    constructor(callback) { this.callback = callback; mutations.push(this); }
    observe() { this.active = true; }
    disconnect() { this.active = false; }
    emit(records) { if (this.active) this.callback(records); }
  };
  globalThis.IntersectionObserver = class {
    constructor(callback, config) { this.callback = callback; this.config = config; this.targets = new Set(); intersections.push(this); }
    observe(target) { this.targets.add(target); }
    unobserve(target) { this.targets.delete(target); }
    disconnect() { this.targets.clear(); }
    enter(target) { this.callback([{ target, isIntersecting: true }]); }
  };
  const element = (tagName = 'P', top = 0) => ({
    nodeType: 1, tagName, className: '', isContentEditable: false, isConnected: true, top,
    childNodes: [], parentElement: null, parentNode: null, dataset: {}, style: {},
    hasAttribute(name) { return (name === 'hidden' && this.hidden) || (name === 'data-lingualens-translation' && this.dataset.lingualensTranslation); },
    getAttribute() { return null; },
    closest(selector) {
      for (let el = this; el; el = el.parentElement) {
        if (selector.includes('lingua-lens') && (el.tagName === 'LINGUA-LENS' || el.dataset.lingualensTranslation)) return el;
      }
      return null;
    },
    getBoundingClientRect() { return { top: this.top, bottom: this.top + 20, left: 0, right: 600 }; },
    insertBefore(node) { node.parentNode = this; node.parentElement = this; this.childNodes.push(node); },
    remove() {
      this.isConnected = false;
      if (this.parentNode) this.parentNode.childNodes = this.parentNode.childNodes.filter((n) => n !== this);
    },
  });
  const body = element('BODY');
  const nodes = [];
  const emit = (record) => { for (const observer of mutations) observer.emit([record]); };
  const add = (value, top = 0, hidden = false) => {
    const parent = element('P', top);
    parent.hidden = hidden;
    parent.parentNode = body; parent.parentElement = body;
    const node = { nodeType: 3, textContent: value, parentNode: parent, parentElement: parent, isConnected: true };
    parent.childNodes.push(node); body.childNodes.push(parent); nodes.push(node);
    emit({ type: 'childList', target: body, addedNodes: [parent] });
    return node;
  };
  const walk = (root) => root.childNodes.flatMap((child) => child.nodeType === 3 ? [child] : walk(child));
  globalThis.document = {
    body, hidden: false,
    addEventListener(name, fn) { listeners.set(name, fn); },
    removeEventListener(name) { listeners.delete(name); },
    createElement: () => element('SPAN'),
    createTreeWalker(root, _type, filter) {
      const pending = walk(root).filter((node) => filter.acceptNode(node) === 1);
      return { nextNode: () => pending.shift() ?? null };
    },
  };
  return { add, emit, nodes, body, mutations, intersections, element, visibility(hidden) {
    document.hidden = hidden; listeners.get('visibilitychange')?.();
  } };
}

function browserHarness(maxPageRequests = 100) {
  const calls = [];
  let stored = {};
  let delay = false;
  const scheduler = new TranslationScheduler();
  const relay = {
    async translateItems(items, _request, { signal }) {
      calls.push(items);
      if (delay) await new Promise((resolve, reject) => {
        const timer = setTimeout(resolve, 1000);
        signal.addEventListener('abort', () => { clearTimeout(timer); reject(new DOMException('Cancelled', 'AbortError')); }, { once: true });
      });
      return new Map(items.map((item) => [item.id, `[translated] ${item.text}`]));
    },
  };
  const sent = [];
  globalThis.browser = {
    storage: { session: {
      async get(key) { return { [key]: structuredClone(stored[key]) }; },
      async set(value) { stored = { ...stored, ...structuredClone(value) }; },
    } },
    runtime: {
      connect() {
        let onMessage;
        return {
          onMessage: { addListener(fn) { onMessage = fn; } }, onDisconnect: { addListener() {} },
          postMessage(message) { if (message.type === 'bind') queueMicrotask(() => onMessage({ ...message, type: 'bound' })); },
          disconnect() {},
        };
      },
      async sendMessage(message) {
        sent.push(message);
        if (message.type === 'TRANSLATE_BATCH') return { success: true,
          data: await scheduler.submit(message.payload, 7, 0, relay, {
            maxConcurrency: 2, maxCharsPerRequest: 500, maxItemsPerRequest: 5,
            maxPageRequests, maxPageChars: 100_000, timeoutMs: 25_000,
          }) };
        if (message.type === 'TASK_CONTROL') {
          const p = message.payload;
          return { success: true, data: await scheduler.control(p.taskId, p.sessionId, p.action) };
        }
        if (message.type === 'GET_TASK_RECOVERY') return { success: true,
          data: await getTaskJournal(message.payload.taskId, message.payload.sessionId) };
        return { success: true };
      },
    },
  };
  return { calls, sent, scheduler, stored: () => stored, setDelay(value) { delay = value; },
    clearJournal() { stored.relayTaskJournal = {}; } };
}

async function until(predicate, timeout = 2500) {
  const end = Date.now() + timeout;
  while (!predicate()) {
    if (Date.now() > end) throw new Error('timed out');
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

test('initial snapshot, dynamic revision, offscreen and hidden nodes reuse one budget without own-write loops', async () => {
  const dom = mount();
  const first = dom.add('First source paragraph');
  const h = browserHarness();
  const engine = new PageTranslateEngine();
  const progress = [];
  await engine.start(options, (p) => progress.push(p));
  assert.equal(engine.listening, true);
  assert.equal(h.sent.some((m) => m.payload?.action === 'complete'), false);
  dom.emit({ type: 'characterData', target: first });
  await new Promise((resolve) => setTimeout(resolve, 600));
  assert.equal(h.calls.length, 1);
  const second = dom.add('New delayed paragraph');
  await until(() => second.textContent.startsWith('[translated]'));
  assert.equal(h.calls.length, 2);
  const requestIds = h.sent.filter((m) => m.type === 'TRANSLATE_BATCH').map((m) => m.payload);
  assert.equal(new Set(requestIds.map((p) => p.taskId)).size, 1);
  assert.equal(new Set(requestIds.map((p) => p.batchId)).size, 2);
  const offscreen = dom.add('Far below the viewport', 5000);
  const hidden = dom.add('Initially hidden content', 0, true);
  await new Promise((resolve) => setTimeout(resolve, 650));
  assert.equal(h.calls.length, 2);
  offscreen.parentElement.top = 100;
  dom.intersections.at(-1).enter(offscreen.parentElement);
  hidden.parentElement.hidden = false;
  dom.emit({ type: 'attributes', target: hidden.parentElement });
  await until(() => offscreen.textContent.startsWith('[translated]') && hidden.textContent.startsWith('[translated]'));
  first.textContent = 'Website changed the paragraph';
  dom.emit({ type: 'characterData', target: first });
  await until(() => first.textContent === '[translated] Website changed the paragraph');
  const journal = Object.values(h.stored().relayTaskJournal)[0];
  assert.ok(journal.requestsUsed >= 4);
  assert.ok(journal.charsUsed > 'First source paragraph'.length);
  assert.equal(progress.at(-1).listening, true);
  await engine.restore();
  assert.equal(first.textContent, 'Website changed the paragraph');
  assert.equal(second.textContent, 'New delayed paragraph');
  assert.equal(engine.listening, false);
});

test('pause, visibility, suspend/reattach and cancel never replay translated nodes', async () => {
  const dom = mount();
  dom.add('First paragraph');
  const h = browserHarness();
  const engine = new PageTranslateEngine();
  await engine.start(options, () => {});
  await engine.pause();
  const added = dom.add('Added while paused');
  await new Promise((resolve) => setTimeout(resolve, 650));
  assert.equal(h.calls.length, 1);
  await engine.resume();
  await until(() => added.textContent.startsWith('[translated]'));
  dom.visibility(true);
  const background = dom.add('Added in background');
  await new Promise((resolve) => setTimeout(resolve, 650));
  assert.equal(background.textContent, 'Added in background');
  dom.visibility(false);
  await until(() => background.textContent.startsWith('[translated]'));
  const used = Object.values(h.stored().relayTaskJournal)[0].requestsUsed;
  await engine.suspend();
  const suspended = Object.values(h.stored().relayTaskJournal)[0];
  assert.equal(suspended.status, 'suspend');
  await removeOtherDocumentJournals(7, 'new-document');
  assert.equal(Object.values(h.stored().relayTaskJournal)[0].requestsUsed, used);
  await engine.reattach();
  const next = dom.add('After bfcache reattach');
  await until(() => next.textContent.startsWith('[translated]'));
  await engine.cancel();
  dom.add('After cancellation');
  const calls = h.calls.length;
  await new Promise((resolve) => setTimeout(resolve, 650));
  assert.equal(h.calls.length, calls);
});

test('incremental requests cannot reset or refund the document fetch budget', async () => {
  const dom = mount();
  dom.add('First paragraph');
  const h = browserHarness(2);
  const engine = new PageTranslateEngine();
  const progress = [];
  await engine.start({ ...options, maxPageRequests: 2 }, (p) => progress.push(p));
  const next = dom.add('Second paragraph');
  await until(() => next.textContent.startsWith('[translated]'));
  dom.add('Third paragraph over budget');
  await until(() => progress.at(-1).budgetExhausted === true);
  assert.equal(h.calls.length, 2);
  assert.equal(Object.values(h.stored().relayTaskJournal)[0].requestsUsed, 2);
  engine.supplement();
  await new Promise((resolve) => setTimeout(resolve, 650));
  assert.equal(h.calls.length, 2);
  await initializeTaskJournal();
  assert.equal(Object.values(h.stored().relayTaskJournal)[0].requestsUsed, 2);
  await engine.cancel();
});

test('a website edit during dispatch rejects the old response and restore does not overwrite it', async () => {
  const dom = mount();
  const node = dom.add('Source before dispatch');
  const h = browserHarness();
  h.setDelay(true);
  const engine = new PageTranslateEngine();
  const initial = engine.start(options, () => {});
  await until(() => h.calls.length === 1);
  node.textContent = 'Website changed during dispatch';
  await initial;
  assert.equal(node.textContent, 'Website changed during dispatch');
  await engine.restore();
  assert.equal(node.textContent, 'Website changed during dispatch');
});

test('a drawer hidden during dispatch retains results and writes on reveal without another fetch', async () => {
  const dom = mount();
  const node = dom.add('Drawer paragraph before hiding');
  const h = browserHarness();
  h.setDelay(true);
  const engine = new PageTranslateEngine();
  const initial = engine.start(options, () => {});
  await until(() => h.calls.length === 1);
  node.parentElement.hidden = true;
  await initial;
  assert.equal(node.textContent, 'Drawer paragraph before hiding');
  node.parentElement.hidden = false;
  dom.emit({ type: 'attributes', target: node.parentElement, attributeName: 'hidden' });
  await until(() => node.textContent === '[translated] Drawer paragraph before hiding');
  assert.equal(h.calls.length, 1);
  await engine.restore();
  assert.equal(node.textContent, 'Drawer paragraph before hiding');
});

test('closed native details skip body text and translate it after open, not on every toggle', async () => {
  const dom = mount();
  const details = dom.element('DETAILS');
  let open = false;
  details.hasAttribute = (name) => name === 'open' && open;
  details.parentElement = dom.body; details.parentNode = dom.body;
  const summary = dom.element('SUMMARY');
  const summaryText = { nodeType: 3, textContent: 'Expandable article summary',
    parentElement: summary, parentNode: summary, isConnected: true };
  summary.parentElement = details; summary.parentNode = details; summary.childNodes.push(summaryText);
  summary.contains = (node) => node === summaryText;
  const paragraph = dom.element('P');
  paragraph.parentElement = details; paragraph.parentNode = details;
  const node = { nodeType: 3, textContent: 'Article hidden inside native details',
    parentElement: paragraph, parentNode: paragraph, isConnected: true };
  paragraph.childNodes.push(node);
  details.childNodes.push(summary, paragraph);
  details.children = [summary, paragraph];
  dom.body.childNodes.push(details);
  const h = browserHarness();
  const engine = new PageTranslateEngine();
  await engine.start(options, () => {});
  assert.equal(node.textContent, 'Article hidden inside native details');
  assert.equal(summaryText.textContent, '[translated] Expandable article summary');
  open = true;
  dom.emit({ type: 'attributes', target: details, attributeName: 'open' });
  await until(() => node.textContent.startsWith('[translated]'));
  const count = h.calls.length;
  open = false;
  dom.emit({ type: 'attributes', target: details, attributeName: 'open' });
  open = true;
  dom.emit({ type: 'attributes', target: details, attributeName: 'open' });
  await new Promise((resolve) => setTimeout(resolve, 650));
  assert.equal(h.calls.length, count);
  await engine.restore();
  assert.equal(node.textContent, 'Article hidden inside native details');
});

test('visible prose inside a dropdown drawer is not mistaken for menu controls', async () => {
  const dom = mount();
  const node = dom.add('Visible prose in an expandable drawer');
  node.parentElement.className = 'dropdown-content';
  const menu = dom.add('Menu control should stay original');
  menu.parentElement.getAttribute = (name) => name === 'role' ? 'menu' : null;
  const h = browserHarness();
  const engine = new PageTranslateEngine();
  await engine.start(options, () => {});
  assert.equal(node.textContent, '[translated] Visible prose in an expandable drawer');
  assert.equal(menu.textContent, 'Menu control should stay original');
  await engine.restore();
});

test('automatic continuation selects nearby text before applying the document character cap', async () => {
  const dom = mount();
  const far = dom.add('Far offscreen text '.repeat(10), 5000);
  const nearby = dom.add('Nearby article');
  const h = browserHarness();
  const engine = new PageTranslateEngine();
  await engine.start({ ...options, maxPageChars: 50, visibleOnly: true }, () => {});
  assert.equal(nearby.textContent, '[translated] Nearby article');
  assert.equal(far.textContent, 'Far offscreen text '.repeat(10));
  assert.equal(h.calls.length, 1);
  await engine.restore();
});

test('a lost charged journal cannot silently recreate a fresh incremental budget', async () => {
  const dom = mount();
  dom.add('First translated paragraph');
  const h = browserHarness();
  const engine = new PageTranslateEngine();
  const progress = [];
  await engine.start(options, (p) => progress.push(p));
  h.clearJournal();
  dom.add('Added after journal disappeared');
  await until(() => progress.at(-1).channelDisconnected);
  assert.equal(h.calls.length, 1);
  assert.deepEqual(h.stored().relayTaskJournal, {});
  engine.supplement();
  await new Promise((resolve) => setTimeout(resolve, 650));
  assert.equal(h.calls.length, 1);
  await engine.cancel();
});

test('SW reconstruction changes dispatched to unknown and never replays it, while queued work keeps the budget', async () => {
  mount();
  const h = browserHarness();
  const request = { taskId: 'restart-task', sessionId: 'restart-session', batchId: 'batch-0001',
    requestId: 'restart-request', sourceLang: 'en', targetLang: 'zh-CN',
    items: [{ id: 'node-1', text: 'Original source' }] };
  await ensureTask(request, 7);
  await consumeDispatchBudget(request.taskId, request.sessionId, request.batchId,
    { requests: 1, chars: 15 }, { maxRequests: 10, maxChars: 1000 }, 1);
  const queued = { ...request, batchId: 'batch-0002', requestId: 'queued-request' };
  await ensureTask(queued, 7);
  await initializeTaskJournal();
  const rebuilt = new TranslationScheduler();
  let fetches = 0;
  const relay = { async translateItems(items) { fetches++; return new Map(items.map((item) => [item.id, 'Translated'])); } };
  const config = { maxConcurrency: 2, maxPageRequests: 10, maxPageChars: 1000, maxCharsPerRequest: 500 };
  const unknown = await rebuilt.submit(request, 7, 0, relay, config);
  assert.equal(unknown.status, 'interrupted/unknown');
  assert.equal(unknown.requestsUsed, 1);
  assert.equal(fetches, 0);
  const done = await rebuilt.submit({ ...queued, requiresExistingTask: true }, 7, 0, relay, config);
  assert.equal(done.status, 'completed');
  assert.equal(done.requestsUsed, 2);
  assert.equal(fetches, 1);
  const journalText = JSON.stringify(h.stored());
  assert.equal(journalText.includes('Original source'), false);
  assert.equal(journalText.includes('Translated'), false);
});

test('cancelling before the first batch arrives records an owned tombstone and prevents fetch', async () => {
  mount();
  const h = browserHarness();
  const request = { taskId: 'early-task', sessionId: 'early-session', batchId: 'batch-0001',
    requestId: 'early-request', sourceLang: 'en', targetLang: 'zh-CN',
    items: [{ id: 'node-1', text: 'Original source' }] };
  await ensureTaskControl(request.taskId, request.sessionId, 7, 'cancel');
  await assert.rejects(ensureTaskControl(request.taskId, 'different-session', 8, 'resume'), /TASK_OWNER_MISMATCH/);
  let fetches = 0;
  const relay = { async translateItems() { fetches++; return new Map(); } };
  const cancelled = await h.scheduler.submit(request, 7, 0, relay, {
    maxPageRequests: 100, maxPageChars: 100_000, maxCharsPerRequest: 500,
  });
  assert.equal(cancelled.status, 'cancelled');
  assert.equal(cancelled.requestsUsed, 0);
  assert.equal(fetches, 0);
  assert.equal(Object.values(h.stored().relayTaskJournal)[0].status, 'cancel');
});
