import type { TranslationItem } from '../../shared/types';

export interface NetworkItem extends TranslationItem {
  domItemId: string;
  chunkIndex: number;
}

export interface BatchDefinition {
  batchId: string;
  requestId: string;
  items: NetworkItem[];
}

export function splitText(text: string, limit: number): string[] {
  if (text.length <= limit) return [text];
  const chunks: string[] = [];
  let remaining = text;
  while (remaining.length > limit) {
    const region = remaining.slice(0, limit + 1);
    const candidates = [region.lastIndexOf('\n'), region.lastIndexOf('. '), region.lastIndexOf('。'), region.lastIndexOf(' ')];
    const splitAt = Math.max(...candidates);
    const end = splitAt >= Math.floor(limit * 0.5) ? splitAt + 1 : limit;
    chunks.push(remaining.slice(0, end).trim());
    remaining = remaining.slice(end).trimStart();
  }
  if (remaining) chunks.push(remaining);
  return chunks;
}

export function buildNetworkItems(
  domItems: Array<{ id: string; text: string }>,
  maxChars: number,
): NetworkItem[] {
  return domItems.flatMap((item) => splitText(item.text, maxChars).map((text, chunkIndex) => ({
    id: `${item.id}-part-${chunkIndex + 1}`,
    text,
    domItemId: item.id,
    chunkIndex,
  })));
}

export function buildBatches(items: NetworkItem[], maxChars: number): BatchDefinition[] {
  const batches: BatchDefinition[] = [];
  let current: NetworkItem[] = [];
  let chars = 0;

  const flush = () => {
    if (current.length === 0) return;
    batches.push({
      batchId: `batch-${String(batches.length + 1).padStart(4, '0')}`,
      requestId: crypto.randomUUID(),
      items: current,
    });
    current = [];
    chars = 0;
  };

  for (const item of items) {
    if (current.length > 0 && chars + item.text.length > maxChars) flush();
    current.push(item);
    chars += item.text.length;
  }
  flush();
  return batches;
}
