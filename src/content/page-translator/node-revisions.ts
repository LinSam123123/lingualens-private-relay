import type { DomTranslationItem } from './dom-walker.ts';

interface Revision {
  item: DomTranslationItem;
  version: number;
  written: string;
}

/** A website edit invalidates a translation even before MutationObserver runs. */
export class NodeRevisions {
  private records = new WeakMap<Text, Revision>();

  claim(item: DomTranslationItem): DomTranslationItem | null {
    const prior = this.records.get(item.node);
    if (prior && item.originalText === prior.written) return null;
    const version = (prior?.version ?? 0) + 1;
    const current = { ...item, id: version === 1 ? item.id : `${item.id}-r${version}` };
    this.records.set(item.node, { item: current, version, written: item.originalText });
    return current;
  }

  current(item: DomTranslationItem): boolean {
    const record = this.records.get(item.node);
    return item.node.isConnected !== false && Boolean(item.node.parentNode)
      && record?.item.id === item.id && item.node.textContent === record.written;
  }

  write(item: DomTranslationItem, value: string): boolean {
    if (!this.current(item)) return false;
    this.records.get(item.node)!.written = value;
    item.node.textContent = value;
    return true;
  }

  restore(item: DomTranslationItem): boolean {
    return this.write(item, item.originalText);
  }

  isOwnText(node: Text): boolean {
    return this.records.get(node)?.written === node.textContent;
  }
}
