import assert from 'node:assert/strict';
import test from 'node:test';

import {
  buildBatches,
  buildNetworkItems,
  splitText,
  summarizeBatches,
  validateBatchLimits,
} from '../src/content/page-translator/page-batching.ts';

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

test('item cap of 0 preserves character-only batching', () => {
  const items = buildNetworkItems([
    { id: 'segment-000001', text: '12345' },
    { id: 'segment-000002', text: '67890' },
    { id: 'segment-000003', text: 'abc' },
  ], 10);
  assert.deepEqual(
    buildBatches(items, 10, 0).map((batch) => batch.items.map((item) => item.id)),
    buildBatches(items, 10).map((batch) => batch.items.map((item) => item.id)),
  );
});

test('flushes a new batch when the item cap is reached even if characters remain', () => {
  const items = buildNetworkItems([
    { id: 'segment-000001', text: 'aa' },
    { id: 'segment-000002', text: 'bb' },
    { id: 'segment-000003', text: 'cc' },
    { id: 'segment-000004', text: 'dd' },
  ], 8000);
  const batches = buildBatches(items, 8000, 2);
  assert.equal(batches.length, 2);
  assert.deepEqual(batches.map((batch) => batch.items.map((item) => item.id)), [
    ['segment-000001-part-1', 'segment-000002-part-1'],
    ['segment-000003-part-1', 'segment-000004-part-1'],
  ]);
  assert.equal(batches.every((batch) => batch.items.length <= 2), true);
});

test('does not split a single network item by item cap or translation length', () => {
  const items = buildNetworkItems([{ id: 'segment-000001', text: 'one long node' }], 8000);
  const batches = buildBatches(items, 8000, 1);
  assert.equal(batches.length, 1);
  assert.deepEqual(batches[0].items.map((item) => item.id), ['segment-000001-part-1']);
});

test('content and background share the same batch limit checks', () => {
  const items = [
    { id: 'a-part-1', text: 'hello' },
    { id: 'b-part-1', text: 'world' },
    { id: 'c-part-1', text: 'again' },
  ];
  assert.throws(() => validateBatchLimits(items, 8000, 2), /BATCH_ITEM_LIMIT/);
  assert.throws(() => validateBatchLimits([{ id: 'a-part-1', text: 'x'.repeat(21) }], 20, 0), /ITEM_TEXT_INVALID/);
  assert.throws(() => validateBatchLimits([
    { id: 'a-part-1', text: 'hello' },
    { id: 'b-part-1', text: 'world!' },
  ], 10, 0), /BATCH_CHAR_LIMIT/);
  validateBatchLimits(items.slice(0, 2), 8000, 2);
});
