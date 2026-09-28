import assert from 'node:assert/strict';
import test from 'node:test';

import { RelayAdapter } from '../src/providers/relay.ts';
import { TranslationScheduler } from '../src/background/scheduler.ts';

function sse(data) {
  return `data: ${JSON.stringify(data)}\n\n`;
}

function chat(content, finish = null) {
  return sse({ choices: [{ index: 0, delta: { content }, finish_reason: finish }] });
}

function hang(text) {
  const bytes = new TextEncoder().encode(text);
  return new ReadableStream({
    start(controller) {
      controller.enqueue(bytes);
    },
  });
}

function providerConfig() {
  return {
    id: 'private-relay',
    type: 'relay',
    name: 'Private Relay',
    enabled: true,
    baseUrl: 'http://127.0.0.1:9/v1',
    model: 'mock-model',
    protocol: 'chat-completions',
    timeoutMs: 25_000,
  };
}

async function collect(adapter, frames, timing) {
  const events = [];
  const started = Date.now();
  globalThis.fetch = async () => new Response(hang(frames), {
    headers: { 'content-type': 'text/event-stream' },
  });
  for await (const event of adapter.streamItems(
    [{ id: 'seg-a', text: 'Hello' }, { id: 'seg-b', text: 'World' }],
    { sourceLang: 'en', targetLang: 'zh-CN' },
    { requestId: 'request-adapter-1', timing },
  )) {
    events.push(event);
  }
  return { events, elapsed: Date.now() - started, timing };
}

test('a terminal event releases the reader before the body closes', async () => {
  const adapter = new RelayAdapter(providerConfig());
  const item = `${JSON.stringify({ id: 'seg-a', text: '你好' })}\n${JSON.stringify({ id: 'seg-b', text: '世界' })}\n`;
  const cases = [
    ['completed', chat(item) + chat('', 'stop')],
    ['truncated', chat(item) + chat('', 'length')],
    ['provider-error', chat(`${JSON.stringify({ id: 'seg-a', text: '你好' })}\n`) + sse({ error: { message: 'secret provider body' } })],
    ['unsafe', chat(`${JSON.stringify({ id: 'seg-a', text: '你好' })}\n`) + chat('```json\n')],
  ];
  for (const [kind, frames] of cases) {
    const timing = { headerMs: null, bodyMs: null, parseMs: null, firstTextDeltaMs: null, firstItemMs: null };
    const { events, elapsed } = await collect(adapter, frames, timing);
    assert.equal(events.some((event) => event.type === 'item'), true, kind);
    assert.equal(events.at(-1)?.type, 'terminal', kind);
    assert.equal(events.at(-1).kind, kind, kind);
    assert.equal(elapsed < 1000, true, kind);
    assert.equal(JSON.stringify(events).includes('secret provider body'), false);
    assert.equal(timing.parseMs < 500, true, kind);
  }
});

test('parse time does not include waiting on reader.read', async () => {
  const adapter = new RelayAdapter(providerConfig());
  const first = chat(JSON.stringify({ id: 'seg-a', text: '你好' }));
  const rest = chat(`\n${JSON.stringify({ id: 'seg-b', text: '世界' })}\n`) + chat('', 'stop');
  const timing = { headerMs: null, bodyMs: null, parseMs: null, firstTextDeltaMs: null, firstItemMs: null };
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const bytesA = new TextEncoder().encode(first);
  const bytesB = new TextEncoder().encode(rest);
  globalThis.fetch = async () => new Response(new ReadableStream({
    async start(controller) {
      controller.enqueue(bytesA);
      await gate;
      controller.enqueue(bytesB);
    },
  }), { headers: { 'content-type': 'text/event-stream' } });
  const pending = (async () => {
    const events = [];
    for await (const event of adapter.streamItems(
      [{ id: 'seg-a', text: 'Hello' }, { id: 'seg-b', text: 'World' }],
      { sourceLang: 'en', targetLang: 'zh-CN' },
      { timing },
    )) events.push(event);
    return events;
  })();
  await new Promise((resolve) => setTimeout(resolve, 60));
  release();
  const events = await pending;
  assert.equal(events.at(-1)?.kind, 'completed');
  assert.equal(timing.parseMs < 40, true, String(timing.parseMs));
});

test('the next queued batch starts after a terminal event without waiting for EOF', async () => {
  let store = {};
  globalThis.browser = {
    storage: {
      session: {
        async get() { return structuredClone(store); },
        async set(value) { store = structuredClone(value); },
      },
    },
  };
  let calls = 0;
  const payload = chat(`${JSON.stringify({ id: 'seg-a', text: '你好' })}\n${JSON.stringify({ id: 'seg-b', text: '世界' })}\n`)
    + chat('', 'stop');
  globalThis.fetch = async () => {
    calls += 1;
    return new Response(hang(payload), { headers: { 'content-type': 'text/event-stream' } });
  };
  const scheduler = new TranslationScheduler();
  const relay = new RelayAdapter({ ...providerConfig(), streamTranslations: true, maxConcurrency: 1 });
  const pending = [0, 1].map((index) => scheduler.submit({
    taskId: 'task-stream',
    sessionId: 'session-stream',
    batchId: `batch-${index}`,
    requestId: `request-slot-${index}`,
    sourceLang: 'en',
    targetLang: 'zh-CN',
    items: [{ id: 'seg-a', text: 'Hello' }, { id: 'seg-b', text: 'World' }],
    generation: 1,
  }, 4, 0, relay, {
    ...providerConfig(),
    streamTranslations: true,
    maxConcurrency: 1,
    maxPageRequests: 10,
    maxPageChars: 100_000,
    maxCharsPerRequest: 8_000,
    maxItemsPerRequest: 0,
  }));
  const results = await Promise.race([
    Promise.all(pending),
    new Promise((_, reject) => setTimeout(() => reject(new Error('slot was not released')), 1000)),
  ]);
  assert.equal(calls, 2);
  assert.equal(results.every((result) => result.status === 'completed'), true);
  assert.equal(scheduler.activeSlotCount, 0);
});
