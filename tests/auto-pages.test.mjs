import assert from 'node:assert/strict';
import test from 'node:test';
import { AutoPages } from '../src/background/auto-pages.ts';
import { parseAutoPageConfig } from '../src/shared/auto-page-policy.ts';
import { isTranslationBatchRequest } from '../src/background/message-policy.ts';

const config = { sourceLang: 'en', targetLang: 'zh-CN', displayMode: 'replace' };
const sender = { id: 'extension', tab: { id: 7 }, frameId: 0, url: 'https://example.com/chapter1' };
function harness() {
  let states = {};
  let url = sender.url;
  let reads = 0;
  const dependencies = {
    extensionId: () => 'extension',
    read: async () => { reads++; return structuredClone(states); },
    write: async (next) => { states = structuredClone(next); },
    tabUrl: async () => url,
  };
  const service = new AutoPages(dependencies);
  return { service, rebuild: () => new AutoPages(dependencies),
    setUrl(next) { url = next; }, states: () => states, reads: () => reads };
}

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
