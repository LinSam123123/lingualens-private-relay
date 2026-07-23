import type { TranslateRequest } from '../shared/types';

export interface RuntimeSenderLike {
  id?: string;
  url?: string;
  tab?: { id?: number };
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
