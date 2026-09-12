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

export function buildBatches(
  items: NetworkItem[],
  maxChars: number,
  maxItems = 0,
): BatchDefinition[] {
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
    const overChars = current.length > 0 && chars + item.text.length > maxChars;
    const overItems = maxItems > 0 && current.length >= maxItems;
    if (overChars || overItems) flush();
    current.push(item);
    chars += item.text.length;
  }
  flush();
  return batches;
}

export function validateBatchLimits(
  items: Array<{ id: string; text: string }>,
  maxChars: number,
  maxItems = 0,
): void {
  if (!Array.isArray(items) || items.length === 0) throw new Error('BATCH_EMPTY');
  if (maxItems > 0 && items.length > maxItems) throw new Error('BATCH_ITEM_LIMIT');
  const ids = new Set<string>();
  let chars = 0;
  for (const item of items) {
    if (!item.id || item.id.length > 128 || ids.has(item.id)) throw new Error('ITEM_ID_INVALID');
    if (!item.text || item.text.length > maxChars) throw new Error('ITEM_TEXT_INVALID');
    ids.add(item.id);
    chars += item.text.length;
  }
  if (chars > maxChars) throw new Error('BATCH_CHAR_LIMIT');
}

export function summarizeBatches(batches: BatchDefinition[]): {
  batchCount: number;
  itemCount: number;
  minItems: number;
  maxItems: number;
  minChars: number;
  maxChars: number;
  totalChars: number;
} {
  if (batches.length === 0) {
    return {
      batchCount: 0, itemCount: 0, minItems: 0, maxItems: 0, minChars: 0, maxChars: 0, totalChars: 0,
    };
  }
  const itemCounts = batches.map((batch) => batch.items.length);
  const charCounts = batches.map((batch) => batch.items.reduce((sum, item) => sum + item.text.length, 0));
  return {
    batchCount: batches.length,
    itemCount: itemCounts.reduce((sum, count) => sum + count, 0),
    minItems: Math.min(...itemCounts),
    maxItems: Math.max(...itemCounts),
    minChars: Math.min(...charCounts),
    maxChars: Math.max(...charCounts),
    totalChars: charCounts.reduce((sum, count) => sum + count, 0),
  };
}
