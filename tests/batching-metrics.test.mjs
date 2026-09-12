import assert from 'node:assert/strict';
import test from 'node:test';

import {
  buildBatches,
  buildNetworkItems,
  summarizeBatches,
} from '../src/content/page-translator/page-batching.ts';

function mixedPageItems() {
  const items = [];
  for (let index = 0; index < 80; index++) {
    items.push({ id: `short-${String(index + 1).padStart(3, '0')}`, text: `nav item ${index + 1} `.repeat(4).trim() });
  }
  for (let index = 0; index < 20; index++) {
    items.push({
      id: `medium-${String(index + 1).padStart(3, '0')}`,
      text: `A medium paragraph ${index + 1} with a working link and a bold phrase. `.repeat(4).trim(),
    });
  }
  for (let index = 0; index < 8; index++) {
    items.push({
      id: `long-${String(index + 1).padStart(3, '0')}`,
      text: `Long paragraph ${index + 1}: this block is meant to stay one DOM node and should not be split by translation length. `.repeat(16).trim(),
    });
  }
  for (let index = 0; index < 2; index++) {
    items.push({
      id: `xl-${String(index + 1).padStart(3, '0')}`,
      text: `Oversized source node ${index + 1} that exceeds a 2000-character batch and must split on source punctuation. `.repeat(60).trim(),
    });
  }
  return items;
}

const CANDIDATES = [
  { name: 'current-8000-unlimited', maxChars: 8_000, maxItems: 0 },
  { name: 'exp-2000-20', maxChars: 2_000, maxItems: 20 },
  { name: 'exp-3000-30', maxChars: 3_000, maxItems: 30 },
];

test('reports structural batch metrics for the three experiment candidates', () => {
  const domItems = mixedPageItems();
  const rows = CANDIDATES.map((candidate) => {
    const networkItems = buildNetworkItems(domItems, candidate.maxChars);
    const batches = buildBatches(networkItems, candidate.maxChars, candidate.maxItems).slice(0, 100);
    const summary = summarizeBatches(batches);
    const overItemCap = candidate.maxItems > 0
      && batches.some((batch) => batch.items.length > candidate.maxItems);
    const overCharCap = batches.some(
      (batch) => batch.items.reduce((sum, item) => sum + item.text.length, 0) > candidate.maxChars,
    );
    return {
      name: candidate.name,
      networkItems: networkItems.length,
      fetchBatches: summary.batchCount,
      scheduledItems: summary.itemCount,
      minItems: summary.minItems,
      maxItems: summary.maxItems,
      minChars: summary.minChars,
      maxChars: summary.maxChars,
      totalChars: summary.totalChars,
      overItemCap,
      overCharCap,
    };
  });

  console.log(JSON.stringify({ kind: 'batching-metrics', rows }, null, 2));

  for (const row of rows) {
    assert.equal(row.overItemCap, false, row.name);
    assert.equal(row.overCharCap, false, row.name);
    assert.equal(row.fetchBatches <= 100, true, row.name);
    assert.equal(row.scheduledItems > 0, true, row.name);
  }

  const current = rows.find((row) => row.name === 'current-8000-unlimited');
  const small = rows.find((row) => row.name === 'exp-2000-20');
  const mid = rows.find((row) => row.name === 'exp-3000-30');
  assert.ok(current && small && mid);
  assert.equal(small.maxItems <= 20, true);
  assert.equal(mid.maxItems <= 30, true);
  assert.equal(small.fetchBatches >= current.fetchBatches, true);
  assert.equal(mid.fetchBatches >= current.fetchBatches, true);
});

test('source-boundary split keeps DOM ownership for oversized nodes', () => {
  const items = mixedPageItems().filter((item) => item.id.startsWith('xl-'));
  const network = buildNetworkItems(items, 2_000);
  assert.equal(network.every((item) => item.text.length <= 2_000), true);
  assert.equal(network.every((item) => item.domItemId.startsWith('xl-')), true);
  assert.equal(new Set(network.map((item) => item.domItemId)).size, 2);
});
