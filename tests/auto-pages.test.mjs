import assert from 'node:assert/strict';
import test from 'node:test';
import { AutoPages } from '../src/background/auto-pages.ts';
import { parseAutoPageConfig } from '../src/shared/auto-page-policy.ts';
import { isTranslationBatchRequest } from '../src/background/message-policy.ts';
import { PageCheckQueue } from '../src/content/page-translator/page-check-queue.ts';
import { observePageLocation } from '../src/content/page-translator/location-observer.ts';

test('local route observer catches push/back without tabs events, deduplicates and cleans up', () => {
  const target = new EventTarget();
  target.location = { href: 'https://example.com/start' };
  target.navigation = new EventTarget();
  let tick;
  let cleared = false;
  target.setInterval = (callback) => { tick = callback; return 1; };
  target.clearInterval = () => { cleared = true; };
  const seen = [];
  const stop = observePageLocation(() => seen.push(target.location.href), target);
  tick();
  target.location.href = 'https://example.com/detail';
  target.navigation.dispatchEvent(new Event('currententrychange'));
  tick();
  target.location.href = 'https://example.com/start';
  target.dispatchEvent(new Event('popstate'));
  tick();
  target.location.href = 'https://example.com/fallback';
  tick();
  assert.deepEqual(seen, ['https://example.com/detail', 'https://example.com/start', 'https://example.com/fallback']);
  stop();
  assert.equal(cleared, true);
  target.location.href = 'https://example.com/stopped';
  target.dispatchEvent(new Event('popstate'));
  target.navigation.dispatchEvent(new Event('currententrychange'));
  assert.equal(seen.length, 3);
});

const config = { sourceLang: 'en', targetLang: 'zh-CN', displayMode: 'replace' };
const sender = { id: 'extension', tab: { id: 7 }, frameId: 0, url: 'https://example.com/chapter1' };
function harness(probe = false) {
  let states = {};
  let url = sender.url;
  let reads = 0;
  let liveId = 'document-0001';
  let liveUrl;
  const dependencies = {
    extensionId: () => 'extension',
    read: async () => { reads++; return structuredClone(states); },
    write: async (next) => { states = structuredClone(next); },
    tabUrl: async () => url,
    ...(probe ? { liveDocument: async () => ({ documentId: liveId, url: liveUrl ?? url }) } : {}),
  };
  const service = new AutoPages(dependencies);
  return { service, rebuild: () => new AutoPages(dependencies),
    setUrl(next) { url = next; }, setLive(id, nextUrl) { liveId = id; liveUrl = nextUrl; }, states: () => states, reads: () => reads };
}

test('live document proof permits repeated SPA query/path changes with a frozen sender URL', async () => {
  const h = harness(true);
  await h.service.message('PAGE_AUTO_START', { documentId: 'document-0001', config }, sender);
  for (const path of ['/portfolio?tab=external', '/portfolio?tab=domains', '/settings?tab=dns', '/chapter1']) {
    h.setUrl(`https://example.com${path}`);
    await h.service.navigation(7, `https://example.com${path}`);
    await h.service.assertLiveDocument('document-0001', sender);
    const ready = await h.service.message('PAGE_AUTO_READY', { documentId: 'document-0001' }, sender);
    assert.equal(ready.documentId, 'document-0001');
  }
  const rebuilt = h.rebuild();
  await rebuilt.initialize();
  await rebuilt.assertLiveDocument('document-0001', sender);
});

test('loading blocks dispatch until completion proves the same document; reload still rejects the old document', async () => {
  const h = harness(true);
  await h.service.message('PAGE_AUTO_START', { documentId: 'document-0001', config }, sender);
  await h.service.navigation(7, sender.url, true);
  await assert.rejects(h.service.assertLiveDocument('document-0001', sender), /STALE_PAGE/);
  await h.service.navigation(7, sender.url, false, true);
  await h.service.assertLiveDocument('document-0001', sender);
  await h.service.navigation(7, sender.url, true);
  h.setLive('document-0002');
  await h.service.navigation(7, sender.url, false, true);
  await assert.rejects(h.service.assertLiveDocument('document-0001', sender), /STALE_PAGE/);
  await assert.rejects(h.service.message('PAGE_AUTO_READY', { documentId: 'document-0001' }, sender), /STALE_PAGE/);
  await h.service.message('PAGE_AUTO_READY', { documentId: 'document-0002' }, sender);
  await h.service.assertLiveDocument('document-0002', sender);
  await assert.rejects(h.service.assertLiveDocument('document-0001', sender), /STALE_PAGE/);
  h.setUrl('https://other.example/page');
  await assert.rejects(h.service.assertLiveDocument('document-0002', sender), /STALE_PAGE/);
});

test('live proof rejects mismatched URL, foreign frame and false document claims', async () => {
  const h = harness(true);
  h.setLive('document-0002');
  await assert.rejects(h.service.message('PAGE_AUTO_START', { documentId: 'document-0001', config }, sender), /STALE_PAGE/);
  h.setLive('document-0001', 'https://example.com/not-current');
  await assert.rejects(h.service.assertLiveDocument('document-0001', sender), /STALE_PAGE/);
  h.setLive('document-0001');
  await assert.rejects(h.service.assertLiveDocument('document-0001', { ...sender, frameId: 1 }), /TOP_CONTENT_SCRIPT_REQUIRED/);
});

test('dock start and SPA continuation work without an activeTab URL grant', async () => {
  const h = harness(true);
  h.setLive('document-0001', sender.url);
  h.setUrl(undefined);
  const started = await h.service.message('PAGE_AUTO_START', { documentId: 'document-0001', config }, sender);
  assert.equal(started.origin, 'https://example.com');
  await h.service.assertLiveDocument('document-0001', sender);
  h.setLive('document-0001', 'https://example.com/next');
  await h.service.message('PAGE_AUTO_READY', { documentId: 'document-0001' }, sender);
  const rebuilt = h.rebuild();
  await rebuilt.initialize();
  assert.equal(h.states()['7'].documentId, 'document-0001');
  await rebuilt.assertLiveDocument('document-0001', sender);
  await h.service.navigation(7, undefined, true);
  await assert.rejects(h.service.assertLiveDocument('document-0001', sender), /STALE_PAGE/);
  await h.service.navigation(7, undefined, false, true);
  await h.service.assertLiveDocument('document-0001', sender);
});

test('hidden tab URLs do not bypass document/origin checks or keep cross-site continuation', async () => {
  const h = harness(true);
  h.setLive('document-0001', sender.url);
  h.setUrl(undefined);
  await h.service.message('PAGE_AUTO_START', { documentId: 'document-0001', config }, sender);
  h.setLive('document-0002', sender.url);
  await assert.rejects(h.service.assertLiveDocument('document-0001', sender), /STALE_PAGE/);
  await h.service.message('PAGE_AUTO_READY', { documentId: 'document-0002' }, sender);
  h.setLive('document-0003', 'https://other.example/page');
  await assert.rejects(h.service.assertLiveDocument('document-0003', sender), /STALE_PAGE/);
  assert.equal(await h.service.message('PAGE_AUTO_READY', { documentId: 'document-0003' },
    { ...sender, url: 'https://other.example/page' }), null);
  assert.deepEqual(h.states(), {});
});

test('document replacement cancels once under concurrent handshakes; SPA changes never cancel', async () => {
  const h = harness(true);
  let cancellations = 0;
  const cancel = async () => { cancellations++; await Promise.resolve(); };
  await h.service.message('PAGE_AUTO_START', { documentId: 'document-0001', config }, sender, cancel);
  h.setUrl('https://example.com/portfolio?tab=external');
  await h.service.message('PAGE_AUTO_READY', { documentId: 'document-0001' }, sender, cancel);
  assert.equal(cancellations, 0);
  h.setLive('document-0002');
  const first = h.service.message('PAGE_AUTO_READY', { documentId: 'document-0002' }, sender, cancel);
  const second = h.service.message('PAGE_AUTO_READY', { documentId: 'document-0002' }, sender, cancel);
  assert.deepEqual(await first, await second);
  assert.equal(cancellations, 1);
  await assert.rejects(h.service.message('PAGE_AUTO_READY', { documentId: 'document-0001' }, sender, cancel), /STALE_PAGE/);
  assert.equal(cancellations, 1);
});

test('same-origin chapters continue, repeated ready is stable, a stale stop cannot disable the new page', async () => {
  const h = harness();
  await h.service.message('PAGE_AUTO_START', { documentId: 'document-0001', config }, sender);
  h.setUrl('https://example.com/chapter2');
  assert.equal(await h.service.navigation(7, 'https://example.com/chapter2'), true);
  const nextSender = { ...sender, url: 'https://example.com/chapter2' };
  const first = await h.service.message('PAGE_AUTO_READY', { documentId: 'document-0002' }, nextSender);
  const again = await h.service.message('PAGE_AUTO_READY', { documentId: 'document-0002' }, nextSender);
  assert.deepEqual(again, first);
  await h.service.message('PAGE_AUTO_STOP', { documentId: 'document-0001' }, nextSender);
  assert.equal(h.states()['7'].documentId, 'document-0002');
  assert.equal(await h.service.navigation(7, 'https://other.example/chapter3'), false);
  assert.deepEqual(h.states(), {});
  assert.equal(await h.service.message('PAGE_AUTO_READY', { documentId: 'document-0003' },
    { ...sender, url: 'https://other.example/chapter3' }).catch(() => null), null);
});

test('pause is carried into the next document, stop and tab removal clear session state', async () => {
  const h = harness();
  await h.service.message('PAGE_AUTO_START', { documentId: 'document-0001', config }, sender);
  await h.service.message('PAGE_AUTO_PAUSE', { documentId: 'document-0001', paused: true }, sender);
  const ready = await h.service.message('PAGE_AUTO_READY', { documentId: 'document-0002' }, sender);
  assert.equal(ready.paused, true);
  await h.service.message('PAGE_AUTO_STOP', { documentId: 'document-0002' }, sender);
  assert.deepEqual(h.states(), {});
  await h.service.message('PAGE_AUTO_START', { documentId: 'document-0001', config }, sender);
  await h.service.remove(7);
  assert.deepEqual(h.states(), {});
});

test('new SW instance uses session state and initialization removes mismatched tabs', async () => {
  const h = harness();
  await h.service.message('PAGE_AUTO_START', { documentId: 'document-0001', config }, sender);
  const rebuilt = h.rebuild();
  await rebuilt.initialize();
  const recovered = await rebuilt.message('PAGE_AUTO_READY', { documentId: 'document-0001' }, sender);
  assert.equal(recovered.targetLang, config.targetLang);
  assert.equal(h.states()['7'].origin, 'https://example.com');
  h.setUrl('https://elsewhere.example');
  await rebuilt.initialize();
  assert.deepEqual(h.states(), {});
});

test('rejects non-top senders, stale URLs, key/config injection and oversized fields before writing', async () => {
  const h = harness();
  for (const badSender of [{ ...sender, id: 'foreign' }, { ...sender, frameId: 3 }, { ...sender, tab: undefined }]) {
    await assert.rejects(h.service.message('PAGE_AUTO_START', { documentId: 'document-0001', config }, badSender),
      /TOP_CONTENT_SCRIPT_REQUIRED/);
  }
  assert.equal(h.reads(), 0);
  await assert.rejects(h.service.message('PAGE_AUTO_START', {
    documentId: 'document-0001', config: { ...config, apiKey: 'fake-secret' },
  }, sender), /INVALID_AUTO_PAGE_CONFIG/);
  await assert.rejects(h.service.message('PAGE_AUTO_READY', { documentId: 'document-0001', url: sender.url }, sender),
    /INVALID_AUTO_PAGE_REQUEST/);
  h.setUrl('https://example.com/different');
  await assert.rejects(h.service.message('PAGE_AUTO_START', { documentId: 'document-0001', config }, sender), /STALE_PAGE/);
  assert.equal(parseAutoPageConfig({ ...config, targetLang: 'x'.repeat(33) }), null);
  assert.deepEqual(h.states(), {});
});

test('loading fences the old document, including same-URL reload, until a new handshake', async () => {
  const h = harness();
  await h.service.message('PAGE_AUTO_START', { documentId: 'document-0001', config }, sender);
  await h.service.assertLiveDocument('document-0001', sender);
  await h.service.navigation(7, sender.url, true);
  await assert.rejects(h.service.assertLiveDocument('document-0001', sender), /STALE_PAGE/);
  await assert.rejects(h.service.message('PAGE_AUTO_READY', { documentId: 'document-0001' }, sender), /STALE_PAGE/);
  await h.service.message('PAGE_AUTO_READY', { documentId: 'document-0002' }, sender);
  await h.service.assertLiveDocument('document-0002', sender);
  await assert.rejects(h.service.assertLiveDocument('document-0001', sender), /STALE_PAGE/);
});

test('batch input rejects URL/key injection and oversized items, and accepts the journal guard', () => {
  const request = { taskId: 'task-0001', sessionId: 'session-0001', batchId: 'batch-0001',
    requestId: 'request-0001', sourceLang: 'en', targetLang: 'zh-CN',
    items: [{ id: 'node-1', text: 'Hello paragraph' }], requiresExistingTask: true, generation: 1 };
  assert.equal(isTranslationBatchRequest(request), true);
  assert.equal(isTranslationBatchRequest({ ...request, baseUrl: 'https://example.com' }), false);
  assert.equal(isTranslationBatchRequest({ ...request, apiKey: 'fake-key' }), false);
  assert.equal(isTranslationBatchRequest({ ...request, items: [{ id: 'node-1', text: 'x'.repeat(20_001) }] }), false);
  assert.equal(isTranslationBatchRequest({ ...request, generation: 0 }), false);
});

test('an unavailable URL during loading does not disarm continuation or authorize the stale document', async () => {
  const h = harness();
  await h.service.message('PAGE_AUTO_START', { documentId: 'document-0001', config }, sender);
  h.setUrl(undefined);
  assert.equal(await h.service.navigation(7, undefined, true), true);
  assert.ok(h.states()['7'].navigationPending);
  await assert.rejects(h.service.assertLiveDocument('document-0001', sender), /STALE_PAGE/);
  h.setUrl('https://example.com/chapter2');
  await h.service.navigation(7, 'https://example.com/chapter2');
  const next = await h.service.message('PAGE_AUTO_READY', { documentId: 'document-0002' },
    { ...sender, url: 'https://example.com/chapter2' });
  assert.equal(next.navigationPending, false);
  assert.equal(next.origin, 'https://example.com');
  assert.equal(await h.service.navigation(7, 'about:blank', true), false);
});

test('navigation checks during a pending handshake run once more instead of being lost', async () => {
  const queue = new PageCheckQueue();
  let release;
  const calls = [];
  const first = queue.run(async () => {
    calls.push('early');
    await new Promise((resolve) => { release = resolve; });
  });
  await Promise.resolve();
  queue.run(async () => { calls.push('superseded'); });
  queue.run(async () => { calls.push('final-url'); });
  release();
  await first;
  assert.deepEqual(calls, ['early', 'final-url']);
  await queue.run(async () => { calls.push('next'); });
  assert.deepEqual(calls, ['early', 'final-url', 'next']);
});

test('stopping a page removes trailing navigation checks without cancelling the active response guard', async () => {
  const queue = new PageCheckQueue();
  let release;
  const calls = [];
  const active = queue.run(async () => {
    calls.push('active');
    await new Promise((resolve) => { release = resolve; });
  });
  await Promise.resolve();
  queue.run(async () => { calls.push('late'); });
  queue.clear();
  release();
  await active;
  assert.deepEqual(calls, ['active']);
});
