import assert from 'node:assert/strict';
import test from 'node:test';
import { NodeRevisions } from '../src/content/page-translator/node-revisions.ts';

function fixture() {
  const node = { textContent: 'Original paragraph', parentNode: {}, isConnected: true };
  const item = { id: 'segment-1', node, originalText: node.textContent, text: node.textContent,
    leadingWhitespace: '', trailingWhitespace: '' };
  return { node, item, revisions: new NodeRevisions() };
}

test('own translation writes never create another revision', () => {
  const { item, node, revisions } = fixture();
  const first = revisions.claim(item);
  assert.ok(revisions.write(first, 'Translated'));
  assert.equal(revisions.isOwnText(node), true);
  assert.equal(revisions.claim({ ...item, originalText: node.textContent }), null);
  assert.ok(revisions.restore(first));
  assert.equal(node.textContent, item.originalText);
});

test('website edits invalidate results immediately and restore only the latest owned text', () => {
  const { item, node, revisions } = fixture();
  const first = revisions.claim(item);
  node.textContent = 'New website content';
  assert.equal(revisions.current(first), false);
  assert.equal(revisions.write(first, 'Late translation'), false);
  assert.equal(revisions.restore(first), false);
  const second = revisions.claim({ ...item, originalText: node.textContent, text: node.textContent });
  assert.notEqual(second.id, first.id);
  assert.ok(revisions.write(second, 'New translation'));
  assert.equal(revisions.restore(first), false);
  assert.ok(revisions.restore(second));
  assert.equal(node.textContent, 'New website content');
});

test('removed nodes and virtual-list revisions cannot receive old translations', () => {
  const { item, node, revisions } = fixture();
  const first = revisions.claim(item);
  node.isConnected = false;
  assert.equal(revisions.write(first, 'Removed'), false);
  node.isConnected = true;
  node.textContent = 'Reused virtual list row';
  const next = revisions.claim({ ...item, originalText: node.textContent });
  assert.ok(next.id.endsWith('-r2'));
  assert.equal(revisions.current(first), false);
});
