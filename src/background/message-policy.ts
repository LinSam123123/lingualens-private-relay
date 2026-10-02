import type { TranslateRequest, TranslationBatchRequest } from '../shared/types';

export interface RuntimeSenderLike {
  id?: string;
  url?: string;
  tab?: { id?: number };
  frameId?: number;
}

export function isOwnExtensionSender(sender: RuntimeSenderLike, extensionId: string): boolean {
  return sender.id === extensionId;
}

export function isOptionsSender(sender: RuntimeSenderLike, extensionId: string): boolean {
  return isOwnExtensionSender(sender, extensionId) && Boolean(sender.url?.endsWith('/options.html'));
}

export function isTranslateRequest(value: unknown): value is TranslateRequest {
  if (!value || typeof value !== 'object') return false;
  const request = value as Partial<TranslateRequest>;
  return typeof request.text === 'string'
    && request.text.length > 0
    && request.text.length <= 100_000
    && typeof request.sourceLang === 'string'
    && request.sourceLang.length <= 32
    && typeof request.targetLang === 'string'
    && request.targetLang.length <= 32;
}

export function isTranslationBatchRequest(value: unknown): value is TranslationBatchRequest {
  if (!value || typeof value !== 'object') return false;
  const request = value as Record<string, unknown>;
  const fields = ['taskId', 'sessionId', 'batchId', 'requestId', 'sourceLang', 'targetLang',
    'items', 'manualRetryUnknown', 'manualRetryFailed', 'requiresExistingTask', 'generation'];
  if (Object.keys(request).some((key) => !fields.includes(key))) return false;
  for (const field of ['taskId', 'sessionId', 'batchId', 'requestId']) {
    if (typeof request[field] !== 'string' || !/^[a-zA-Z0-9-]{8,128}$/.test(request[field] as string)) return false;
  }
  for (const field of ['sourceLang', 'targetLang']) {
    if (typeof request[field] !== 'string' || !(request[field] as string).length || (request[field] as string).length > 32) return false;
  }
  for (const field of ['manualRetryUnknown', 'manualRetryFailed', 'requiresExistingTask']) {
    if (request[field] !== undefined && typeof request[field] !== 'boolean') return false;
  }
  if (request.generation !== undefined && (!Number.isInteger(request.generation) || (request.generation as number) < 1)) return false;
  if (!Array.isArray(request.items) || !request.items.length || request.items.length > 4000) return false;
  const ids = new Set<string>();
  let chars = 0;
  for (const item of request.items) {
    if (!item || typeof item !== 'object' || Object.keys(item).some((key) => !['id', 'text'].includes(key))) return false;
    if (typeof item.id !== 'string' || !item.id || item.id.length > 128 || ids.has(item.id)) return false;
    if (typeof item.text !== 'string' || !item.text.trim()) return false;
    chars += item.text.length;
    if (chars > 20_000) return false;
    ids.add(item.id);
  }
  return true;
}
