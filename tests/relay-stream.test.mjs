import assert from 'node:assert/strict';
import test from 'node:test';

import { buildRelayBody } from '../src/shared/relay-protocol.ts';
import {
  JSONL_OUTPUT_RULES,
  RelayEventStreamParser,
  parseRelaySse,
} from '../src/shared/relay-stream.ts';

const ids = ['seg-a', 'seg-b'];
const translated = [
  { id: 'seg-a', text: '你好\n"World" {x}' },
  { id: 'seg-b', text: '世界' },
];

function event(data) {
  return `data: ${JSON.stringify(data)}\r\n\r\n`;
}

function delta(content) {
  return event({ choices: [{ index: 0, delta: { content }, finish_reason: null }] });
}

function end() {
  return event({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] }) + 'data: [DONE]\n\n';
}

function chunksOf(text, size = 1) {
  const bytes = new TextEncoder().encode(text);
  const chunks = [];
  for (let at = 0; at < bytes.length; at += size) chunks.push(bytes.slice(at, at + size));
  return chunks;
}

function itemsFrom(events) {
  return events.filter((entry) => entry.type === 'item').map((entry) => entry.item);
}

function terminalOf(events) {
  return events.find((entry) => entry.type === 'terminal');
}

test('chat SSE handles split UTF-8, CRLF, comments, and escaped newlines', () => {
  const text = translated.map((item) => JSON.stringify(item)).join('\n') + '\n';
  const frames = `: keepalive\r\n\r\n${delta(text.slice(0, 12))}${delta(text.slice(12))}${end()}`;
  const events = parseRelaySse('chat-completions', ids, chunksOf(frames, 1));
  assert.deepEqual(itemsFrom(events), translated);
  assert.equal(events.filter((entry) => entry.type === 'text-delta').length, 1);
  assert.equal(terminalOf(events)?.kind, 'completed');
  assert.match(JSONL_OUTPUT_RULES, /JSONL/);
  const body = buildRelayBody('chat-completions', 'manual-model', 'system', '{}', 0.2, true);
  assert.equal(body.stream, true);
  assert.equal('response_format' in body, false);
  const quiet = buildRelayBody('chat-completions', 'manual-model', 'system', '{}', 0.2, false);
  assert.equal(quiet.stream, false);
});

test('responses uses output deltas, ignores reasoning and done text, and accepts a final line without newline', () => {
  const frames = event({ type: 'response.reasoning_text.delta', delta: 'not a translation' })
    + event({ type: 'response.output_text.delta', delta: `${JSON.stringify(translated[0])}\n` })
    + event({ type: 'response.output_text.done', text: JSON.stringify(translated[0]) })
    + event({ type: 'response.output_text.delta', delta: JSON.stringify(translated[1]) })
    + event({ type: 'response.completed', response: { status: 'completed' } });
  const events = parseRelaySse('responses', ids, chunksOf(frames, 7));
  assert.deepEqual(itemsFrom(events), translated);
  assert.equal(events.filter((entry) => entry.type === 'text-delta').length, 1);
  assert.equal(terminalOf(events)?.kind, 'completed');
  const body = buildRelayBody('responses', 'manual-model', JSONL_OUTPUT_RULES, '{}', 0.2, true);
  assert.equal(body.stream, true);
  assert.equal('text' in body, false);
});

test('a complete JSONL item is visible before the terminal event and a partial line is not', () => {
  const parser = new RelayEventStreamParser('chat-completions', ids);
  const partial = parser.push(new TextEncoder().encode(delta(JSON.stringify(translated[0]))));
  assert.deepEqual(itemsFrom(partial), []);
  const ready = parser.push(new TextEncoder().encode(delta('\n')));
  assert.deepEqual(itemsFrom(ready).map((item) => item.id), ['seg-a']);
  const done = parser.push(new TextEncoder().encode(delta(`${JSON.stringify(translated[1])}\n`) + end()));
  assert.deepEqual(itemsFrom(done).map((item) => item.id), ['seg-b']);
  assert.equal(terminalOf(done)?.kind, 'completed');
});

test('duplicate and unknown ids do not overwrite or publish, and invalid JSONL stops the stream', () => {
  const first = delta(`${JSON.stringify(translated[0])}\n`);
  const duplicate = parseRelaySse('chat-completions', ids, chunksOf(
    first + delta(`${JSON.stringify(translated[0])}\n`) + delta(`${JSON.stringify(translated[1])}\n`) + end(),
    9,
  ));
  assert.deepEqual(itemsFrom(duplicate), translated);
  assert.equal(duplicate.some((entry) => entry.type === 'ignored' && entry.reason === 'duplicate'), true);

  const unknown = parseRelaySse('chat-completions', ids, chunksOf(
    first + delta('{"id":"other","text":"nope"}\n') + delta(`${JSON.stringify(translated[1])}\n`) + end(),
    8,
  ));
  assert.deepEqual(itemsFrom(unknown), translated);
  assert.equal(unknown.some((entry) => entry.type === 'ignored' && entry.reason === 'unknown'), true);

  const invalid = parseRelaySse('chat-completions', ids, chunksOf(
    first + delta('```json\n'),
    5,
  ));
  assert.deepEqual(itemsFrom(invalid), [translated[0]]);
  assert.equal(terminalOf(invalid)?.code, 'STREAM_INVALID_JSONL');
  assert.equal(terminalOf(invalid)?.kind, 'unsafe');
});

test('invalid items stay rejected while later valid items still publish', () => {
  for (const [value, reason] of [
    [{}, 'MISSING_TEXT'],
    [{ text: null }, 'NOT_STRING'],
    [{ text: ['private provider text'] }, 'NOT_STRING'],
    [{ text: ' \n\t' }, 'EMPTY_TEXT'],
    [{ text: 'x'.repeat(100_001) }, 'TEXT_TOO_LONG'],
  ]) {
    const frames = delta(`${JSON.stringify({ id: 'seg-a', ...value })}\n`)
      + delta(`${JSON.stringify(translated[1])}\n`)
      + end();
    const events = parseRelaySse('chat-completions', ids, chunksOf(frames, 64));
    assert.deepEqual(itemsFrom(events), [translated[1]]);
    const rejected = events.find((entry) => entry.type === 'rejected');
    assert.equal(rejected?.item.reason, reason);
    assert.equal(JSON.stringify(rejected).includes('private provider text'), false);
    assert.equal(terminalOf(events)?.kind, 'completed');
  }
});

test('a later valid line can fill an id that was rejected, but cannot replace an accepted line', () => {
  const frames = delta('{"id":"seg-a","text":null}\n')
    + delta(`${JSON.stringify(translated[1])}\n`)
    + delta(`${JSON.stringify(translated[0])}\n`)
    + end();
  const events = parseRelaySse('chat-completions', ids, chunksOf(frames, 11));
  assert.deepEqual(itemsFrom(events), [translated[1], translated[0]]);
});

test('truncation, provider errors, and EOF keep earlier items and do not look like success', () => {
  const kept = delta(`${JSON.stringify(translated[0])}\n`);
  const length = parseRelaySse('chat-completions', ids, chunksOf(
    kept + event({ choices: [{ index: 0, delta: { content: '{"id":"seg-b","text":"unfin' }, finish_reason: 'length' }] }),
  ));
  assert.deepEqual(itemsFrom(length), [translated[0]]);
  assert.equal(terminalOf(length)?.kind, 'truncated');

  const provider = parseRelaySse('chat-completions', ids, chunksOf(
    kept + event({ error: { message: 'secret provider body' } }),
  ));
  assert.deepEqual(itemsFrom(provider), [translated[0]]);
  assert.equal(terminalOf(provider)?.code, 'STREAM_PROVIDER_ERROR');
  assert.equal(JSON.stringify(provider).includes('secret provider body'), false);

  const eof = parseRelaySse('chat-completions', ids, chunksOf(kept + delta('{"id":"seg-b","text":"unfinished')));
  assert.deepEqual(itemsFrom(eof), [translated[0]]);
  assert.equal(terminalOf(eof)?.kind, 'incomplete');
});

test('several SSE events in one packet stay separate from JSONL lines', () => {
  const packet = delta(`${JSON.stringify(translated[0])}\n`) + delta(`${JSON.stringify(translated[1])}\n`) + end();
  const events = parseRelaySse('chat-completions', ids, [new TextEncoder().encode(packet)]);
  assert.deepEqual(itemsFrom(events).map((item) => item.id), ['seg-a', 'seg-b']);
  assert.equal(terminalOf(events)?.kind, 'completed');
});
