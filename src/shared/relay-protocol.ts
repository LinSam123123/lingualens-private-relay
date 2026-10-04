import type { RelayProtocol, ReportedServiceTier } from './types';

export function sanitizeServiceTier(value: unknown): ReportedServiceTier | null {
  switch (value) {
    case 'auto': case 'default': case 'flex': case 'scale': case 'priority': case 'ultrafast':
      return value;
    default:
      return null;
  }
}

/** Read API metadata only, never model output or an arbitrary error string. */
export function extractServiceTier(data: unknown): ReportedServiceTier | null {
  if (!data || typeof data !== 'object') return null;
  const record = data as Record<string, unknown>;
  const direct = sanitizeServiceTier(record.service_tier);
  if (direct) return direct;
  const response = record.response;
  return response && typeof response === 'object'
    ? sanitizeServiceTier((response as Record<string, unknown>).service_tier)
    : null;
}

export interface TranslationEnvelopeItem {
  id: string;
  text: string;
}

export interface TranslationEnvelope {
  items: TranslationEnvelopeItem[];
}

function textFromContentParts(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .map((part) => {
      if (!part || typeof part !== 'object') return '';
      const value = part as Record<string, unknown>;
      return typeof value.text === 'string' ? value.text : '';
    })
    .join('');
}

export function extractRelayText(data: unknown, protocol: RelayProtocol): string {
  if (!data || typeof data !== 'object') return '';
  const value = data as Record<string, unknown>;

  if (protocol === 'chat-completions') {
    const choices = value.choices;
    if (!Array.isArray(choices) || !choices[0] || typeof choices[0] !== 'object') return '';
    const message = (choices[0] as Record<string, unknown>).message;
    if (!message || typeof message !== 'object') return '';
    return textFromContentParts((message as Record<string, unknown>).content).trim();
  }

  if (typeof value.output_text === 'string') return value.output_text.trim();
  if (!Array.isArray(value.output)) return '';
  return value.output
    .map((entry) => {
      if (!entry || typeof entry !== 'object') return '';
      return textFromContentParts((entry as Record<string, unknown>).content);
    })
    .join('')
    .trim();
}

function unwrapJsonFence(value: string): string {
  const trimmed = value.trim();
  const fenced = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  return fenced ? fenced[1].trim() : trimmed;
}

export function parseTranslationEnvelope(raw: string): TranslationEnvelope {
  let parsed: unknown;
  try {
    parsed = JSON.parse(unwrapJsonFence(raw));
  } catch {
    throw new Error('RESPONSE_FORMAT_INCOMPATIBLE');
  }
  if (!parsed || typeof parsed !== 'object' || !Array.isArray((parsed as { items?: unknown }).items)) {
    throw new Error('RESPONSE_FORMAT_INCOMPATIBLE');
  }

  const seen = new Set<string>();
  const items: TranslationEnvelopeItem[] = [];
  for (const entry of (parsed as { items: unknown[] }).items) {
    if (!entry || typeof entry !== 'object') continue;
    const item = entry as Record<string, unknown>;
    const text = typeof item.text === 'string'
      ? item.text
      : typeof item.translation === 'string'
        ? item.translation
        : '';
    if (typeof item.id !== 'string' || !item.id || !text || seen.has(item.id)) continue;
    seen.add(item.id);
    items.push({ id: item.id, text });
  }
  if (items.length === 0) throw new Error('RESPONSE_FORMAT_INCOMPATIBLE');
  return { items };
}

export function buildRelayBody(
  protocol: RelayProtocol,
  model: string,
  systemPrompt: string,
  inputJson: string,
  temperature: number,
  stream = false,
  fastMode = false,
): Record<string, unknown> {
  if (protocol === 'responses') {
    return {
      model,
      instructions: systemPrompt,
      input: inputJson,
      temperature,
      ...(stream ? { stream: true } : {}),
      ...(fastMode === true ? { service_tier: 'priority' } : {}),
    };
  }
  return {
    model,
    messages: [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: inputJson },
    ],
    temperature,
    stream,
    ...(fastMode === true ? { service_tier: 'priority' } : {}),
  };
}
