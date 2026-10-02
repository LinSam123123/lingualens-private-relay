export const DYNAMIC_SETTLE_MS = 500;
export const VIEWPORT_MARGIN = 600;

function elementFor(node: Node): Element | null {
  return node.nodeType === 1 ? node as Element : node.parentElement;
}

export function isExtensionNode(node: Node): boolean {
  return Boolean(elementFor(node)?.closest('lingua-lens,[data-lingualens-translation]'));
}

export function nearViewport(element: Element): boolean {
  const rect = element.getBoundingClientRect();
  return rect.bottom >= -VIEWPORT_MARGIN && rect.top <= window.innerHeight + VIEWPORT_MARGIN
    && rect.right >= 0 && rect.left <= window.innerWidth;
}

/** Only dirty subtrees and deferred offscreen elements are inspected. */
export class DynamicPageObserver {
  private mutation: MutationObserver;
  private intersection: IntersectionObserver;
  private dirty = new Map<Element, number>();
  private observed = new Set<Element>();
  private timer: ReturnType<typeof setTimeout> | null = null;
  private closed = false;
  private scan: (root: Element) => void;
  private ownText: (node: Text) => boolean;
  private canDispatch: () => boolean;

  constructor(
    scan: (root: Element) => void,
    ownText: (node: Text) => boolean,
    canDispatch: () => boolean,
  ) {
    this.scan = scan;
    this.ownText = ownText;
    this.canDispatch = canDispatch;
    this.intersection = new IntersectionObserver((entries) => {
      for (const entry of entries) if (entry.isIntersecting) this.schedule(entry.target, false);
    }, { rootMargin: `${VIEWPORT_MARGIN}px` });
    this.mutation = new MutationObserver((records) => {
      for (const record of records) {
        if (isExtensionNode(record.target)) continue;
        if (record.type === 'characterData') {
          if (!this.ownText(record.target as Text)) this.schedule(record.target);
        } else if (record.type === 'attributes') {
          this.scheduleReveal(record.target);
        } else {
          for (const node of record.addedNodes) {
            if (!isExtensionNode(node)) this.schedule(node);
          }
        }
      }
    });
    this.mutation.observe(document.documentElement ?? document.body, {
      childList: true, subtree: true, characterData: true, attributes: true,
      attributeFilter: ['class', 'style', 'hidden', 'aria-hidden', 'contenteditable',
        'open', 'aria-expanded', 'aria-controls', 'data-state', 'inert'],
    });
    for (const type of ['toggle', 'transitionend', 'animationend']) {
      document.addEventListener?.(type, this.onReveal, true);
    }
  }

  private onReveal = (event: Event): void => {
    const target = event.target as Node | null;
    if (target && (target.nodeType === 1 || target.nodeType === 3)) this.scheduleReveal(target);
  };

  private scheduleReveal(node: Node): void {
    if (isExtensionNode(node)) return;
    this.schedule(node);
    // The expanded control and its article panel are often siblings.
    const controls = elementFor(node)?.getAttribute?.('aria-controls') ?? '';
    for (const id of controls.split(/\s+/).slice(0, 16)) {
      if (!id || id.length > 128) continue;
      const panel = document.getElementById?.(id);
      if (panel) this.schedule(panel);
    }
  }

  schedule(node: Node, settle = true): void {
    const element = elementFor(node);
    if (this.closed || !element || isExtensionNode(element)) return;
    if (settle || !this.dirty.has(element)) {
      this.dirty.set(element, Date.now() + (settle ? DYNAMIC_SETTLE_MS : 0));
    }
    this.observe(element);
    this.wake();
  }

  defer(element: Element): void {
    if (this.closed) return;
    this.dirty.set(element, Date.now());
    this.observe(element);
  }

  private observe(element: Element): void {
    if (this.observed.has(element)) return;
    this.observed.add(element);
    this.intersection.observe(element);
  }

  wake(): void {
    if (this.closed || this.timer !== null) return;
    this.timer = setTimeout(() => { this.timer = null; this.flush(); }, DYNAMIC_SETTLE_MS);
  }

  private flush(): void {
    if (this.closed || !this.canDispatch()) return;
    const now = Date.now();
    let unsettled = false;
    for (const [element, readyAt] of this.dirty) {
      if (!element.isConnected) {
        this.release(element);
        continue;
      }
      if (readyAt > now) { unsettled = true; continue; }
      if (!nearViewport(element)) continue;
      this.release(element);
      this.scan(element);
    }
    if (unsettled) this.wake();
  }

  private release(element: Element): void {
    this.dirty.delete(element);
    this.observed.delete(element);
    this.intersection.unobserve(element);
  }

  disconnect(): void {
    this.closed = true;
    this.mutation.disconnect();
    this.intersection.disconnect();
    for (const type of ['toggle', 'transitionend', 'animationend']) {
      document.removeEventListener?.(type, this.onReveal, true);
    }
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = null;
    this.dirty.clear();
    this.observed.clear();
  }
}
