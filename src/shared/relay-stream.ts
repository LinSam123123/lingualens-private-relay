import type { RelayProtocol, ReportedServiceTier } from './types';
import { extractServiceTier } from './relay-protocol.ts';

/** Output rule for streaming translation. Not Structured Outputs. */
export const JSONL_OUTPUT_RULES =
  'Output only newline-delimited JSON (JSONL), one compact object per line: {"id":"the original id","text":"translated text"}. Escape newlines inside text as \\n. No markdown, arrays, wrappers, or commentary. Return each requested id exactly once and do not invent ids.';

export const STREAM_LIMITS = {
  maxBytes: 8 * 1024 * 1024,
  maxSseLine: 1_000_000,
  maxEventData: 1_000_000,
  maxPendingJsonl: 150_000,
  maxItemText: 100_000,
};

export type StreamTerminalKind =
  | 'completed'
  | 'truncated'
  | 'provider-error'
  | 'incomplete'
  | 'unsafe';

export interface StreamAcceptedItem {
  id: string;
  text: string;
}

export interface StreamRejectedItem {
  id: string;
  reason: 'MISSING_TEXT' | 'NOT_STRING' | 'EMPTY_TEXT' | 'TEXT_TOO_LONG';
}

export type StreamParserEvent =
  | { type: 'text-delta' }
  | { type: 'item'; item: StreamAcceptedItem }
  | { type: 'rejected'; item: StreamRejectedItem }
  | { type: 'ignored'; id: string; reason: 'unknown' | 'duplicate' }
  | { type: 'terminal'; kind: StreamTerminalKind; code: string };

interface PayloadRecord {
  [key: string]: unknown;
}

function asRecord(value: unknown): PayloadRecord | null {
  return value && typeof value === 'object' ? value as PayloadRecord : null;
}

function textFromDeltaContent(content: unknown): string | null {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return null;
  let text = '';
  for (const part of content) {
    const record = asRecord(part);
    if (!record || typeof record.text !== 'string') return null;
    text += record.text;
  }
  return text;
}

/**
 * Incremental SSE + JSONL parser.
 * Network chunks, SSE events, and complete JSONL objects are separate boundaries.
 * A terminal event does not by itself mean the batch succeeded.
 */
export class RelayEventStreamParser {
  private readonly decoder = new TextDecoder();
  private readonly protocol: RelayProtocol;
  private readonly expected: Set<string>;
  private readonly seen = new Set<string>();
  private readonly rejected = new Map<string, StreamRejectedItem['reason']>();
  private line = '';
  private eventData: string[] = [];
  private pending = '';
  private skipLF = false;
  private sawText = false;
  private stopped = false;
  private bytes = 0;
  private tier: ReportedServiceTier | null = null;

  constructor(protocol: RelayProtocol, expectedIds: Iterable<string>) {
    this.protocol = protocol;
    this.expected = new Set(expectedIds);
  }

  get acceptedIds(): string[] {
    return [...this.seen];
  }

  get reportedServiceTier(): ReportedServiceTier | null {
    return this.tier;
  }

  push(chunk: Uint8Array): StreamParserEvent[] {
    if (this.stopped) return [];
    this.bytes += chunk.byteLength;
    if (this.bytes > STREAM_LIMITS.maxBytes) return [this.stop('unsafe', 'RESPONSE_TOO_LARGE')];
    return this.consumeText(this.decoder.decode(chunk, { stream: true }));
  }

  finish(): StreamParserEvent[] {
    if (this.stopped) return [];
    const events = this.consumeText(this.decoder.decode());
    if (this.stopped) return events;
    if (this.line) {
      events.push(...this.sseLine(this.line));
      this.line = '';
    }
    if (this.stopped) return events;
    events.push(...this.dispatchEvent());
    if (!this.stopped) events.push(this.stop('incomplete', 'INCOMPLETE_RESPONSE'));
    return events;
  }

  private consumeText(text: string): StreamParserEvent[] {
    const events: StreamParserEvent[] = [];
    for (const char of text) {
      if (this.stopped) return events;
      if (this.skipLF) {
        this.skipLF = false;
        if (char === '\n') continue;
      }
      if (char === '\r' || char === '\n') {
        events.push(...this.sseLine(this.line));
        this.line = '';
        this.skipLF = char === '\r';
      } else {
        this.line += char;
        if (this.line.length > STREAM_LIMITS.maxSseLine) {
          events.push(this.stop('unsafe', 'SSE_LINE_TOO_LONG'));
          return events;
        }
      }
    }
    return events;
  }

  private sseLine(value: string): StreamParserEvent[] {
    if (this.stopped) return [];
    if (!value) return this.dispatchEvent();
    if (value.startsWith(':')) return [];
    if (value.startsWith('data:')) {
      this.eventData.push(value.slice(5).replace(/^ /, ''));
      const size = this.eventData.reduce((sum, part) => sum + part.length, 0);
      if (size > STREAM_LIMITS.maxEventData) return [this.stop('unsafe', 'SSE_EVENT_TOO_LARGE')];
    }
    return [];
  }

  private dispatchEvent(): StreamParserEvent[] {
    if (this.stopped || this.eventData.length === 0) return [];
    const data = this.eventData.join('\n');
    this.eventData = [];
    if (data === '[DONE]') {
      if (this.protocol === 'chat-completions') return [this.stop('incomplete', 'INCOMPLETE_RESPONSE')];
      return [];
    }
    try {
      return this.onPayload(JSON.parse(data) as unknown);
    } catch {
      return [this.stop('unsafe', 'INVALID_RESPONSE')];
    }
  }

  private onPayload(payload: unknown): StreamParserEvent[] {
    const record = asRecord(payload);
    if (!record) return [this.stop('unsafe', 'INVALID_RESPONSE')];
    this.tier = extractServiceTier(record) ?? this.tier;
    if (record.error || record.type === 'error' || record.type === 'response.failed') {
      return [this.stop('provider-error', 'STREAM_PROVIDER_ERROR')];
    }
    if (this.protocol === 'responses') return this.onResponses(record);
    return this.onChat(record);
  }

  private onChat(record: PayloadRecord): StreamParserEvent[] {
    const choices = Array.isArray(record.choices) ? record.choices : [];
    const choice = asRecord(choices.find((entry) => asRecord(entry)?.index === 0) ?? choices[0]);
    const delta = asRecord(choice?.delta);
    if (delta?.refusal) return [this.stop('unsafe', 'INVALID_RESPONSE')];
    const events: StreamParserEvent[] = [];
    if (delta && 'content' in delta) {
      const text = textFromDeltaContent(delta.content);
      if (text === null && delta.content != null) return [this.stop('unsafe', 'INVALID_RESPONSE')];
      if (text) events.push(...this.textDelta(text));
    }
    if (this.stopped) return events;
    const finish = choice?.finish_reason;
    if (typeof finish === 'string' && finish) {
      if (finish === 'stop') {
        events.push(...this.flushPending(false));
        if (!this.stopped) events.push(this.stop('completed', 'STREAM_COMPLETED'));
      } else {
        events.push(...this.flushPending(true));
        if (!this.stopped) events.push(this.stop('truncated', 'RESPONSE_TRUNCATED'));
      }
    }
    return events;
  }

  private onResponses(record: PayloadRecord): StreamParserEvent[] {
    const type = record.type;
    if (type === 'response.output_text.delta') {
      if (typeof record.delta !== 'string') return [this.stop('unsafe', 'INVALID_RESPONSE')];
      return this.textDelta(record.delta);
    }
    if (type === 'response.refusal.delta') return [this.stop('unsafe', 'INVALID_RESPONSE')];
    if (type === 'response.incomplete') {
      const events = this.flushPending(true);
      if (!this.stopped) events.push(this.stop('truncated', 'RESPONSE_TRUNCATED'));
      return events;
    }
    if (type === 'response.completed') {
      const response = asRecord(record.response);
      const status = response?.status;
      const events = this.flushPending(Boolean(status && status !== 'completed'));
      if (this.stopped) return events;
      if (status && status !== 'completed') events.push(this.stop('truncated', 'RESPONSE_TRUNCATED'));
      else events.push(this.stop('completed', 'STREAM_COMPLETED'));
      return events;
    }
    return [];
  }

  private textDelta(text: string): StreamParserEvent[] {
    if (!text) return [];
    if (this.stopped) return [this.stop('unsafe', 'TEXT_AFTER_TERMINAL')];
    const events: StreamParserEvent[] = [];
    if (!this.sawText) {
      this.sawText = true;
      events.push({ type: 'text-delta' });
    }
    this.pending += text;
    if (this.pending.length > STREAM_LIMITS.maxPendingJsonl) {
      events.push(this.stop('unsafe', 'JSONL_BUFFER_TOO_LONG'));
      return events;
    }
    let cut = this.pending.indexOf('\n');
    while (cut >= 0) {
      let value = this.pending.slice(0, cut);
      this.pending = this.pending.slice(cut + 1);
      if (value.endsWith('\r')) value = value.slice(0, -1);
      events.push(...this.acceptLine(value));
      if (this.stopped) return events;
      cut = this.pending.indexOf('\n');
    }
    return events;
  }

  private flushPending(dropUnparseable: boolean): StreamParserEvent[] {
    let value = this.pending;
    this.pending = '';
    if (value.endsWith('\r')) value = value.slice(0, -1);
    if (!value.trim()) return [];
    if (dropUnparseable) {
      try {
        JSON.parse(value);
      } catch {
        return [];
      }
    }
    return this.acceptLine(value);
  }

  private acceptLine(value: string): StreamParserEvent[] {
    if (!value.trim()) return [];
    let parsed: unknown;
    try {
      parsed = JSON.parse(value);
    } catch {
      return [this.stop('unsafe', 'STREAM_INVALID_JSONL')];
    }
    const record = asRecord(parsed);
    if (!record || typeof record.id !== 'string' || !record.id) {
      return [this.stop('unsafe', 'STREAM_INVALID_JSONL')];
    }
    if (!this.expected.has(record.id)) return [{ type: 'ignored', id: record.id, reason: 'unknown' }];
    if (this.seen.has(record.id)) return [{ type: 'ignored', id: record.id, reason: 'duplicate' }];
    if (!Object.prototype.hasOwnProperty.call(record, 'text')) {
      this.rejected.set(record.id, 'MISSING_TEXT');
      return [{ type: 'rejected', item: { id: record.id, reason: 'MISSING_TEXT' } }];
    }
    if (typeof record.text !== 'string') {
      this.rejected.set(record.id, 'NOT_STRING');
      return [{ type: 'rejected', item: { id: record.id, reason: 'NOT_STRING' } }];
    }
    if (!record.text.trim()) {
      this.rejected.set(record.id, 'EMPTY_TEXT');
      return [{ type: 'rejected', item: { id: record.id, reason: 'EMPTY_TEXT' } }];
    }
    if (record.text.length > STREAM_LIMITS.maxItemText) {
      this.rejected.set(record.id, 'TEXT_TOO_LONG');
      return [{ type: 'rejected', item: { id: record.id, reason: 'TEXT_TOO_LONG' } }];
    }
    this.rejected.delete(record.id);
    this.seen.add(record.id);
    return [{ type: 'item', item: { id: record.id, text: record.text } }];
  }

  private stop(kind: StreamTerminalKind, code: string): StreamParserEvent {
    this.stopped = true;
    this.pending = '';
    this.eventData = [];
    return { type: 'terminal', kind, code };
  }
}

export function parseRelaySse(
  protocol: RelayProtocol,
  expectedIds: Iterable<string>,
  chunks: Uint8Array[],
  eof = true,
): StreamParserEvent[] {
  const parser = new RelayEventStreamParser(protocol, expectedIds);
  const events: StreamParserEvent[] = [];
  for (const chunk of chunks) events.push(...parser.push(chunk));
  if (eof) events.push(...parser.finish());
  return events;
}
