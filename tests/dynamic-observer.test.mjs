import assert from 'node:assert/strict';
import test from 'node:test';
import { DynamicPageObserver } from '../src/content/page-translator/dynamic-observer.ts';

test('subtree-only mutations debounce, ignore own writes/markers and retain offscreen work', async () => {
  let mutation, intersection;
  const body = { nodeType: 1 };
  globalThis.document = { body };
  globalThis.window = { innerWidth: 1000, innerHeight: 600 };
  globalThis.MutationObserver = class {
    constructor(fn) { mutation = fn; }
    observe(root, options) { assert.equal(root, body); assert.equal(options.subtree, true); }
    disconnect() {}
  };
  globalThis.IntersectionObserver = class {
    constructor(fn, options) { intersection = fn; assert.equal(options.rootMargin, '600px'); }
    observe() {}
    unobserve() {}
    disconnect() {}
  };
  let top = 5000, enabled = true;
  const parent = { nodeType: 1, isConnected: true, closest: () => null,
    getBoundingClientRect: () => ({ top, bottom: top + 30, left: 0, right: 100 }) };
  const own = { nodeType: 3, parentElement: parent };
  const external = { nodeType: 3, parentElement: parent };
  const marker = { nodeType: 1, closest: () => ({}) };
  const scans = [];
  const observer = new DynamicPageObserver((root) => scans.push(root), (node) => node === own, () => enabled);
  mutation([{ type: 'characterData', target: own }, { type: 'childList', target: parent, addedNodes: [marker] }]);
  await new Promise((resolve) => setTimeout(resolve, 600));
  assert.equal(scans.length, 0);
  mutation([{ type: 'characterData', target: external }]);
  await new Promise((resolve) => setTimeout(resolve, 600));
  assert.equal(scans.length, 0);
  top = 100; enabled = false;
  intersection([{ target: parent, isIntersecting: true }]);
  await new Promise((resolve) => setTimeout(resolve, 600));
  assert.equal(scans.length, 0);
  enabled = true; observer.wake();
  await new Promise((resolve) => setTimeout(resolve, 600));
  assert.deepEqual(scans, [parent]);
  assert.equal(scans.includes(body), false);
  observer.disconnect();
});
