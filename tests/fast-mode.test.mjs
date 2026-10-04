import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import test from 'node:test';
import { DEFAULT_SETTINGS } from '../src/shared/constants.ts';
import { buildRelayBody, extractServiceTier } from '../src/shared/relay-protocol.ts';
import { RelayAdapter } from '../src/providers/relay.ts';
import { TranslationScheduler } from '../src/background/scheduler.ts';
import { isTranslationBatchRequest } from '../src/background/message-policy.ts';
import { getTaskJournal } from '../src/background/task-journal.ts';
import {
  listBatchDiagnostics, recordBatchDiagnostic, resetBatchDiagnosticsForTests,
  setBatchDiagnosticsEnabled,
} from '../src/background/batch-diagnostics.ts';

const originalFetch = globalThis.fetch;
const originalBrowser = globalThis.browser;
test.afterEach(() => {
  globalThis.fetch = originalFetch;
  globalThis.browser = originalBrowser;
  resetBatchDiagnosticsForTests();
});

const items = [{ id: 'seg-priority', text: 'Hello' }];
const languages = { sourceLang: 'en', targetLang: 'zh-CN' };
const config = (overrides = {}) => ({
  ...DEFAULT_SETTINGS.providers[0],
  baseUrl: 'http://127.0.0.1:9/v1', model: 'mock-model', apiKey: 'fake-test-key',
  ...overrides,
});
const timing = () => ({ headerMs: null, bodyMs: null, parseMs: null });
const frame = (data) => `data: ${JSON.stringify(data)}\n\n`;

function reply(protocol, streamed, tier, id = items[0].id) {
  const metadata = tier === undefined ? {} : { service_tier: tier };
  const output = { id, text: 'translated' };
  if (streamed) {
    const line = `${JSON.stringify(output)}\n`;
    const text = protocol === 'responses'
      ? frame({ type: 'response.output_text.delta', delta: line })
        + frame({ type: 'response.completed', response: { status: 'completed', ...metadata } })
      : frame({ choices: [{ index: 0, delta: { content: line }, finish_reason: null }], ...metadata })
        + frame({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] });
    return new Response(text, { headers: { 'Content-Type': 'text/event-stream' } });
  }
  const content = JSON.stringify({ items: [output] });
  return Response.json(protocol === 'responses'
    ? { output_text: content, ...metadata }
    : { choices: [{ message: { content } }], ...metadata });
}

function mountJournal() {
  let stored = {};
  globalThis.browser = { storage: { session: {
    async get() { return structuredClone(stored); },
    async set(value) { Object.assign(stored, structuredClone(value)); },
  } } };
}

function batch(suffix = 'test') {
  return {
    taskId: `task-priority-${suffix}`, sessionId: `session-priority-${suffix}`,
    batchId: `batch-priority-${suffix}`, requestId: `request-priority-${suffix}`,
    ...languages, items,
  };
}

test('ordinary mode is unchanged and only boolean true opts into Priority', () => {
  assert.equal(DEFAULT_SETTINGS.providers[0].fastMode, false);
  assert.equal(DEFAULT_SETTINGS.providers[0].maxConcurrency, 2);
  assert.equal(DEFAULT_SETTINGS.providers[0].timeoutMs, 25_000);
  assert.equal(DEFAULT_SETTINGS.providers[0].streamTranslations, false);
  for (const protocol of ['chat-completions', 'responses']) {
    for (const streamed of [false, true]) {
      const oldBody = buildRelayBody(protocol, 'mock-model', 'prompt', '{}', 0.2, streamed);
      for (const disabled of [undefined, false, 'true', 1, {}, null]) {
        assert.deepEqual(buildRelayBody(protocol, 'mock-model', 'prompt', '{}', 0.2, streamed, disabled), oldBody);
      }
      assert.deepEqual(buildRelayBody(protocol, 'mock-model', 'prompt', '{}', 0.2, streamed, true), {
        ...oldBody, service_tier: 'priority',
      });
    }
  }
});

test('both protocols and transports send Priority only when saved opt-in is true', async () => {
  for (const protocol of ['chat-completions', 'responses']) {
    for (const streamed of [false, true]) {
      for (const fastMode of [false, true]) {
        let calls = 0;
        globalThis.fetch = async (url, init) => {
          calls++;
          assert.equal(url.endsWith(protocol === 'responses' ? '/responses' : '/chat/completions'), true);
          assert.equal(init.headers['X-Translation-Request-Id'], 'request-priority-test');
          assert.equal(init.redirect, 'error');
          const body = JSON.parse(init.body);
          assert.equal(body.service_tier, fastMode ? 'priority' : undefined);
          assert.equal(body.stream === true, streamed);
          return reply(protocol, streamed, fastMode ? 'priority' : 'default');
        };
        const adapter = new RelayAdapter(config({ protocol, fastMode }));
        const metrics = timing();
        if (streamed) {
          const events = [];
          for await (const event of adapter.streamItems(items, languages, { requestId: 'request-priority-test', timing: metrics })) events.push(event);
          assert.equal(events.find((event) => event.type === 'item').item.text, 'translated');
          assert.equal(events.at(-1).kind, 'completed');
        } else {
          assert.equal((await adapter.translateItems(items, languages, { requestId: 'request-priority-test', timing: metrics })).get(items[0].id), 'translated');
        }
        assert.equal(metrics.requestedServiceTier, fastMode ? 'priority' : null);
        assert.equal(metrics.reportedServiceTier, fastMode ? 'priority' : 'default');
        assert.equal(calls, 1);
      }
    }
  }
});

test('model lists are unchanged; connection tests distinguish requested and reported tiers', async () => {
  for (const protocol of ['chat-completions', 'responses']) {
    for (const tier of [undefined, 'default', 'priority']) {
      const requests = [];
      globalThis.fetch = async (url, init) => {
        requests.push({ url, init });
        if (url.endsWith('/models')) {
          assert.equal(init.body, undefined);
          return Response.json({ data: [{ id: 'mock-model' }] });
        }
        assert.equal(JSON.parse(init.body).service_tier, 'priority');
        assert.equal(init.redirect, 'manual');
        return reply(protocol, false, tier, 'connection-test');
      };
      const result = await new RelayAdapter(config({ protocol, fastMode: true })).testConnectionDetailed();
      assert.equal(result.formatCompatible, true);
      assert.equal(result.requestedServiceTier, 'priority');
      assert.equal(result.reportedServiceTier, tier ?? null);
      assert.equal(requests.length, 2);
      assert.equal(JSON.stringify(result).includes('fake-test-key'), false);
    }
  }
});

test('metadata is whitelisted and model output cannot claim a service tier', async () => {
  for (const unsafe of ['Bearer fake-secret', '<script>alert(1)</script>', {}, true]) {
    assert.equal(extractServiceTier({ service_tier: unsafe }), null);
  }
  assert.equal(extractServiceTier({ output_text: '{"service_tier":"priority"}' }), null);
  assert.equal(extractServiceTier({ response: { service_tier: 'priority' } }), 'priority');
  for (const protocol of ['chat-completions', 'responses']) {
    for (const streamed of [false, true]) {
      globalThis.fetch = async () => reply(protocol, streamed, undefined);
      const adapter = new RelayAdapter(config({ protocol, fastMode: true }));
      const metrics = { ...timing(), reportedServiceTier: 'priority' };
      if (streamed) {
        for await (const _event of adapter.streamItems(items, languages, { timing: metrics })) { /* Consume the stream. */ }
      } else await adapter.translateItems(items, languages, { timing: metrics });
      assert.equal(metrics.requestedServiceTier, 'priority');
      assert.equal(metrics.reportedServiceTier, null);
    }
  }
});

test('selection translation uses the same saved Priority setting', async () => {
  let calls = 0;
  globalThis.fetch = async (_url, init) => {
    calls++;
    assert.equal(JSON.parse(init.body).service_tier, 'priority');
    return reply('chat-completions', false, 'priority', 'selection');
  };
  const result = await new RelayAdapter(config({ fastMode: true })).translate({ text: 'Hello', ...languages });
  assert.equal(result.translated, 'translated');
  assert.equal(calls, 1);
});

test('explicit tier rejection fails once without downgrade and retains spent budgets', async () => {
  mountJournal();
  for (const protocol of ['chat-completions', 'responses']) {
    for (const streamed of [false, true]) {
      for (const status of [400, 403, 422]) {
        let calls = 0;
        globalThis.fetch = async (_url, init) => {
          calls++;
          assert.equal(JSON.parse(init.body).service_tier, 'priority');
          return Response.json({ error: { message: 'service_tier priority is unsupported; fake-secret' } }, { status });
        };
        const settings = config({ protocol, streamTranslations: streamed, fastMode: true, retryGatewayErrors: true });
        const request = batch(`${protocol}-${streamed}-${status}`);
        const result = await new TranslationScheduler().submit(request, 1, 0, new RelayAdapter(settings), settings);
        assert.equal(result.status, 'failed');
        assert.equal(result.items[0].error, 'FAST_MODE_REJECTED');
        assert.equal(result.attempts, 1);
        assert.equal(result.requestsUsed, 1);
        assert.equal(result.charsUsed, 5);
        assert.equal(calls, 1);
        assert.equal(JSON.stringify(result).includes('fake-secret'), false);
        const journal = await getTaskJournal(request.taskId, request.sessionId);
        assert.equal(journal.batches[request.batchId].requestId, request.requestId);
        assert.equal(journal.requestsUsed, 1);
      }
    }
  }
});

test('connection rejection has a sanitized error and never replays the request', async () => {
  let calls = 0;
  globalThis.fetch = async (url) => {
    calls++;
    return url.endsWith('/models') ? Response.json({ data: [] })
      : Response.json({ error: 'service_tier rejected, fake-secret' }, { status: 422 });
  };
  const result = await new RelayAdapter(config({ fastMode: true })).testConnectionDetailed();
  assert.equal(result.message, 'FAST_MODE_REJECTED');
  assert.equal(result.httpStatus, 422);
  assert.equal(result.requestedServiceTier, 'priority');
  assert.equal(result.reportedServiceTier, null);
  assert.equal(JSON.stringify(result).includes('fake-secret'), false);
  assert.equal(calls, 2);
});

test('ambiguous Priority fetch failures stay unknown without a standard-mode retry', async () => {
  mountJournal();
  for (const streamed of [false, true]) {
    let calls = 0;
    globalThis.fetch = async (_url, init) => {
      calls++;
      assert.equal(JSON.parse(init.body).service_tier, 'priority');
      throw new TypeError('Failed to fetch');
    };
    const settings = config({ fastMode: true, streamTranslations: streamed });
    const request = batch(`network-${streamed}`);
    const result = await new TranslationScheduler().submit(request, 1, 0, new RelayAdapter(settings), settings);
    assert.equal(result.status, 'interrupted/unknown');
    assert.equal(result.requestsUsed, 1);
    assert.equal(calls, 1);
  }
});

test('an allowed 429 retry retains Priority and request ID while charging each dispatch', async () => {
  mountJournal();
  let calls = 0;
  globalThis.fetch = async (_url, init) => {
    calls++;
    assert.equal(init.headers['X-Translation-Request-Id'], 'request-priority-rate');
    assert.equal(JSON.parse(init.body).service_tier, 'priority');
    if (calls === 1) return Response.json({ error: 'rate limited' }, { status: 429, headers: { 'Retry-After': '0' } });
    return reply('chat-completions', false, 'priority');
  };
  setBatchDiagnosticsEnabled(true);
  const settings = config({ fastMode: true });
  const result = await new TranslationScheduler().submit(batch('rate'), 1, 0, new RelayAdapter(settings), settings);
  assert.equal(result.status, 'completed');
  assert.equal(result.requestsUsed, 2);
  assert.equal(result.charsUsed, 10);
  assert.equal(result.attempts, 2);
  assert.equal(calls, 2);
  const rows = listBatchDiagnostics();
  assert.equal(rows.length, 2);
  assert.equal(rows[0].requestedServiceTier, 'priority');
  assert.equal(rows[0].reportedServiceTier, null);
  assert.equal(rows[1].requestedServiceTier, 'priority');
  assert.equal(rows[1].reportedServiceTier, 'priority');
});

test('tier diagnostics do not retain secrets or arbitrary metadata', () => {
  setBatchDiagnosticsEnabled(true);
  recordBatchDiagnostic({
    taskId: 'task-priority-log', requestId: 'request-priority-log', attempt: 1,
    itemCount: 1, sourceChars: 5, queuedMs: 0, headerMs: null, bodyMs: null,
    parseMs: null, totalMs: 10, status: 'completed',
    requestedServiceTier: 'Bearer fake-secret', reportedServiceTier: 'fake-secret',
  });
  const [row] = listBatchDiagnostics();
  assert.equal(row.requestedServiceTier, null);
  assert.equal(row.reportedServiceTier, null);
  assert.equal(JSON.stringify(row).includes('fake-secret'), false);
});

test('content scripts cannot override the saved fast mode in translation payloads', () => {
  const request = batch('validation');
  assert.equal(isTranslationBatchRequest(request), true);
  for (const extra of [{ fastMode: true }, { service_tier: 'priority' }, { serviceTier: 'priority' }]) {
    assert.equal(isTranslationBatchRequest({ ...request, ...extra }), false);
  }
});

test('real settings routing migrates strict opt-in, protects updates, and invalidates cache', async () => {
  const bundled = await build({
    entryPoints: [fileURLToPath(new URL('../src/background/message-router.ts', import.meta.url))],
    bundle: true, write: false, format: 'esm', platform: 'node', logLevel: 'silent',
  });
  const router = await import(`data:text/javascript;base64,${Buffer.from(bundled.outputFiles[0].text).toString('base64')}`);
  const settings = structuredClone(DEFAULT_SETTINGS);
  delete settings.providers[0].fastMode;
  const local = { settings };
  const session = { translationCache: { old: { result: { translated: 'old', cached: false }, accessedAt: Date.now() } } };
  let cacheClears = 0;
  const area = (store) => ({
    async get(key) { return { [key]: structuredClone(store[key]) }; },
    async set(value) { Object.assign(store, structuredClone(value)); },
    async remove(key) {
      delete store[key];
      if (key === 'translationCache') cacheClears++;
    },
  });
  globalThis.browser = {
    runtime: { id: 'extension-priority' },
    storage: { local: area(local), session: area(session) },
  };
  const optionsSender = { id: 'extension-priority', url: 'chrome-extension://extension-priority/options.html' };
  const pageSender = { id: 'extension-priority', url: 'https://example.test/article', tab: { id: 1 } };
  assert.equal((await router.getSettings()).providers[0].fastMode, false);
  local.settings.providers[0].fastMode = 'true';
  assert.equal((await router.getSettings()).providers[0].fastMode, false);
  local.settings.providers[0].fastMode = false;
  const initialCache = await router.handleMessage({ type: 'GET_CACHE_STATS' }, optionsSender);
  assert.equal(initialCache.data.size, 1);
  const payload = {
    keyStorageMode: 'session', providers: [{ ...settings.providers[0], fastMode: true }],
  };
  assert.deepEqual(await router.handleMessage({ type: 'SAVE_SETTINGS', payload }, pageSender), {
    success: false, error: 'OPTIONS_ONLY',
  });
  assert.equal(local.settings.providers[0].fastMode, false);
  assert.equal(cacheClears, 0);
  const saved = await router.handleMessage({ type: 'SAVE_SETTINGS', payload }, optionsSender);
  assert.equal(saved.success, true);
  assert.equal(saved.data.providers[0].fastMode, true);
  assert.equal(local.settings.providers[0].fastMode, true);
  assert.equal(cacheClears, 1);
  assert.equal((await router.handleMessage({ type: 'GET_CACHE_STATS' }, optionsSender)).data.size, 0);
  await router.handleMessage({ type: 'SAVE_SETTINGS', payload }, optionsSender);
  assert.equal(cacheClears, 1);
  const firefoxSender = { id: 'extension-priority', url: 'moz-extension://test-uuid/options.html' };
  const disabled = await router.handleMessage({
    type: 'SAVE_SETTINGS', payload: { ...payload, providers: [{ ...settings.providers[0], fastMode: false }] },
  }, firefoxSender);
  assert.equal(disabled.success, true);
  assert.equal(local.settings.providers[0].fastMode, false);
  assert.equal(cacheClears, 2);
});
