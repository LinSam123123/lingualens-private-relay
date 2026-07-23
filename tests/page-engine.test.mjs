import assert from 'node:assert/strict';
import test from 'node:test';

import { buildBatches, buildNetworkItems, splitText } from '../src/content/page-translator/page-batching.ts';

test('splits oversized text at source boundaries without proportional output splitting', () => {
  const chunks = splitText('First sentence. Second sentence. Third sentence.', 22);
  assert.equal(chunks.length > 1, true);
  assert.equal(chunks.join(' ').replaceAll('  ', ' '), 'First sentence. Second sentence. Third sentence.');
  assert.equal(chunks.every((chunk) => chunk.length <= 22), true);
});

test('assigns stable part IDs and preserves DOM ownership', () => {
  const items = buildNetworkItems([
    { id: 'segment-000001', text: 'hello' },
    { id: 'segment-000002', text: 'world' },
  ], 20);
  assert.deepEqual(items.map((item) => item.id), [
    'segment-000001-part-1',
    'segment-000002-part-1',
  ]);
  assert.deepEqual(items.map((item) => item.domItemId), ['segment-000001', 'segment-000002']);
});

test('batches by actual character limit and assigns stable batch IDs', () => {
  const items = buildNetworkItems([
    { id: 'segment-000001', text: '12345' },
    { id: 'segment-000002', text: '67890' },
    { id: 'segment-000003', text: 'abc' },
  ], 10);
  const batches = buildBatches(items, 10);
  assert.deepEqual(batches.map((batch) => batch.batchId), ['batch-0001', 'batch-0002']);
  assert.equal(batches[0].items.reduce((sum, item) => sum + item.text.length, 0), 10);
  assert.match(batches[0].requestId, /^[0-9a-f-]{36}$/i);
});
