import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import {
  buildRelayBody,
  extractRelayText,
  parseTranslationEnvelope,
} from '../src/shared/relay-protocol.ts';

test('extracts Chat Completions string and content-part responses', () => {
  assert.equal(extractRelayText({ choices: [{ message: { content: '{"items":[]}' } }] }, 'chat-completions'), '{"items":[]}');
  assert.equal(extractRelayText({ choices: [{ message: { content: [{ text: 'one' }, { text: 'two' }] } }] }, 'chat-completions'), 'onetwo');
});

test('extracts Responses API top-level and nested output text', () => {
  assert.equal(extractRelayText({ output_text: 'direct' }, 'responses'), 'direct');
  assert.equal(extractRelayText({ output: [{ content: [{ type: 'output_text', text: 'nested' }] }] }, 'responses'), 'nested');
});

test('parses pure and fenced JSON while preserving stable IDs', () => {
  assert.deepEqual(parseTranslationEnvelope('{"items":[{"id":"seg-1","text":"译文"}]}').items, [
    { id: 'seg-1', text: '译文' },
  ]);
  assert.deepEqual(parseTranslationEnvelope('```json\n{"items":[{"id":"seg-2","translation":"ok"}]}\n```').items, [
    { id: 'seg-2', text: 'ok' },
  ]);
  assert.throws(() => parseTranslationEnvelope('not json'), /RESPONSE_FORMAT_INCOMPATIBLE/);
});

test('builds protocol-specific bodies without structured-output parameters', () => {
  const chat = buildRelayBody('chat-completions', 'manual-model', 'system', '{}', 0.2);
  assert.equal(chat.model, 'manual-model');
  assert.equal('response_format' in chat, false);
  assert.equal(Array.isArray(chat.messages), true);

  const responses = buildRelayBody('responses', 'manual-model', 'system', '{}', 0.2);
  assert.equal(responses.instructions, 'system');
  assert.equal(responses.input, '{}');
  assert.equal('text' in responses, false);
});

test('redirect diagnostics instruct users to enter the final Base URL', async () => {
  const [english, chinese] = await Promise.all([
    readFile(new URL('../src/locales/en.json', import.meta.url), 'utf8').then(JSON.parse),
    readFile(new URL('../src/locales/zh-CN.json', import.meta.url), 'utf8').then(JSON.parse),
  ]);
  assert.match(english.options.redirectNotAllowed, /final Base URL/i);
  assert.match(chinese.options.redirectNotAllowed, /\u6700\u7ec8 Base URL/);
  assert.match(english.options.streamTranslationsHelp, /not automatically resent/i);
  assert.match(chinese.options.streamTranslationsHelp, /不会自动改发非流式/);
  assert.match(chinese.options.concurrencyHelp, /5–10/);
});
