import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import {
  BATCH_DIAGNOSTICS_BUILD,
  batchDiagnosticsSnapshot,
  clearBatchDiagnostics,
  isBatchDiagnosticsEnabled,
  listBatchDiagnostics,
  recordBatchDiagnostic,
  resetBatchDiagnosticsForTests,
  sanitizeDiagnosticStatus,
  setBatchDiagnosticsEnabled,
} from '../src/background/batch-diagnostics.ts';

function sample(overrides = {}) {
  return {
    requestId: '11111111-2222-3333-4444-555555555555',
    attempt: 1,
    itemCount: 8,
    sourceChars: 1200,
    queuedMs: 40,
    headerMs: 800,
    bodyMs: 200,
    parseMs: 15,
    totalMs: 1055,
    status: 'completed',
    ...overrides,
  };
}

test('records nothing until diagnostics are enabled', () => {
  resetBatchDiagnosticsForTests();
  recordBatchDiagnostic(sample());
  assert.equal(isBatchDiagnosticsEnabled(), false);
  assert.deepEqual(listBatchDiagnostics(), []);
});

test('keeps a capped in-memory ring of sanitized batch timings', () => {
  resetBatchDiagnosticsForTests();
  setBatchDiagnosticsEnabled(true);
  for (let index = 0; index < 45; index++) {
    recordBatchDiagnostic(sample({
      requestId: `req-${String(index).padStart(8, '0')}`,
      attempt: index + 1,
      totalMs: index,
    }));
  }
  const listed = listBatchDiagnostics();
  assert.equal(listed.length, 40);
  assert.equal(listed[0].requestId, 'req-00000005');
  assert.equal(listed.at(-1).requestId, 'req-00000044');
  assert.equal(listed.every((entry) => Object.keys(entry).join(',') === [
    'requestId', 'attempt', 'itemCount', 'sourceChars', 'queuedMs',
    'headerMs', 'bodyMs', 'parseMs', 'firstTextDeltaMs', 'firstItemMs', 'firstPageWriteMs',
    'totalMs', 'status',
  ].join(',')), true);
});

test('drops extra fields and unsafe status strings', () => {
  resetBatchDiagnosticsForTests();
  setBatchDiagnosticsEnabled(true);
  recordBatchDiagnostic({
    ...sample(),
    status: 'failed: Bearer sk-live-secret and {"text":"page"}',
    requestId: 'short',
    text: 'page source',
    translated: '译文',
    authorization: 'Bearer secret',
  });
  const [entry] = listBatchDiagnostics();
  assert.equal(entry.status, 'failed');
  assert.equal(entry.requestId, 'invalid-id');
  assert.equal('text' in entry, false);
  assert.equal('translated' in entry, false);
  assert.equal('authorization' in entry, false);
});

test('accepts known terminal statuses and rejects first-token wording in module comments only', async () => {
  assert.equal(sanitizeDiagnosticStatus('completed'), 'completed');
  assert.equal(sanitizeDiagnosticStatus('interrupted/unknown:REQUEST_TIMEOUT_UNKNOWN'), 'interrupted/unknown:REQUEST_TIMEOUT_UNKNOWN');
  assert.equal(sanitizeDiagnosticStatus('failed:PAGE_BUDGET_EXCEEDED'), 'failed:PAGE_BUDGET_EXCEEDED');
  assert.equal(sanitizeDiagnosticStatus('Failed to fetch from https://relay.example/v1'), 'failed');
  const source = await readFile(new URL('../src/background/batch-diagnostics.ts', import.meta.url), 'utf8');
  assert.match(source, /Not model first-token time/);
  assert.equal(/first token/i.test(source.replace('Not model first-token time', '')), false);
});

test('snapshot reports the build marker and clear empties the buffer', () => {
  resetBatchDiagnosticsForTests();
  setBatchDiagnosticsEnabled(true);
  recordBatchDiagnostic(sample());
  const snapshot = batchDiagnosticsSnapshot();
  assert.equal(snapshot.build, BATCH_DIAGNOSTICS_BUILD);
  assert.equal(snapshot.enabled, true);
  assert.equal(snapshot.cap, 40);
  assert.equal(snapshot.entries.length, 1);
  clearBatchDiagnostics();
  assert.deepEqual(listBatchDiagnostics(), []);
  assert.equal(isBatchDiagnosticsEnabled(), true);
});
