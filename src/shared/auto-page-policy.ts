import type { RuntimeSenderLike } from '../background/message-policy.ts';

export interface AutoPageConfig {
  sourceLang: string;
  targetLang: string;
  displayMode: 'replace' | 'bilingual';
}

export interface AutoPageState extends AutoPageConfig {
  origin: string;
  documentId: string;
  paused: boolean;
  navigationPending?: boolean;
}

export function ordinaryOrigin(url: string | undefined): string | null {
  try {
    const parsed = new URL(url ?? '');
    return ['http:', 'https:'].includes(parsed.protocol) ? parsed.origin : null;
  } catch { return null; }
}

export function parseDocumentId(value: unknown): string | null {
  return typeof value === 'string' && /^[a-zA-Z0-9-]{8,128}$/.test(value) ? value : null;
}

export function parseAutoPageConfig(value: unknown): AutoPageConfig | null {
  if (!value || typeof value !== 'object') return null;
  const record = value as Record<string, unknown>;
  if (Object.keys(record).some((key) => !['sourceLang', 'targetLang', 'displayMode'].includes(key))) return null;
  if (typeof record.sourceLang !== 'string' || !record.sourceLang || record.sourceLang.length > 32) return null;
  if (typeof record.targetLang !== 'string' || !record.targetLang || record.targetLang.length > 32) return null;
  if (!['replace', 'bilingual'].includes(String(record.displayMode))) return null;
  return { sourceLang: record.sourceLang, targetLang: record.targetLang,
    displayMode: record.displayMode as AutoPageConfig['displayMode'] };
}

export function isTopPageSender(sender: RuntimeSenderLike, extensionId: string): boolean {
  return sender.id === extensionId && Number.isInteger(sender.tab?.id)
    && (sender.tab!.id as number) >= 0 && (sender.frameId ?? 0) === 0
    && ordinaryOrigin(sender.url) !== null;
}

export function samePageUrl(senderUrl: string | undefined, tabUrl: string | undefined): boolean {
  try {
    const left = new URL(senderUrl ?? '');
    const right = new URL(tabUrl ?? '');
    left.hash = ''; right.hash = '';
    return left.href === right.href && ordinaryOrigin(left.href) !== null;
  } catch { return false; }
}
