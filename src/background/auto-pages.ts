import type { RuntimeSenderLike } from './message-policy.ts';
import {
  isTopPageSender, ordinaryOrigin, parseAutoPageConfig, parseDocumentId, samePageUrl,
  type AutoPageState,
} from '../shared/auto-page-policy.ts';

const STORAGE_KEY = 'autoPageTabs';

interface AutoPageDependencies {
  extensionId: () => string;
  read: () => Promise<Record<string, AutoPageState>>;
  write: (states: Record<string, AutoPageState>) => Promise<void>;
  tabUrl: (tabId: number) => Promise<string | undefined>;
  liveDocument?: (tabId: number) => Promise<{ documentId: string; url: string } | null>;
}

/** Serialize navigation and page messages so a stale stop cannot erase a new document. */
export class AutoPages {
  private dependencies: AutoPageDependencies;
  private queue: Promise<unknown> = Promise.resolve();
  constructor(dependencies: AutoPageDependencies) { this.dependencies = dependencies; }

  private async matchesDocument(tabId: number, documentId: string, senderUrl: string | undefined): Promise<boolean> {
    const url = await this.dependencies.tabUrl(tabId);
    if (!this.dependencies.liveDocument) return samePageUrl(senderUrl, url);
    if (!ordinaryOrigin(url) || ordinaryOrigin(senderUrl) !== ordinaryOrigin(url)) return false;
    const live = await this.dependencies.liveDocument(tabId).catch(() => null);
    const latest = await this.dependencies.tabUrl(tabId);
    return live?.documentId === documentId && samePageUrl(live.url, latest)
      && ordinaryOrigin(senderUrl) === ordinaryOrigin(latest);
  }

  private transaction<T>(operation: (states: Record<string, AutoPageState>) => Promise<T>): Promise<T> {
    const next = this.queue.then(async () => {
      const states = await this.dependencies.read();
      return operation(states);
    });
    this.queue = next.catch(() => undefined);
    return next;
  }

  async initialize(): Promise<void> {
    await this.transaction(async (states) => {
      for (const [id, state] of Object.entries(states)) {
        let url: string | undefined;
        try { url = await this.dependencies.tabUrl(Number(id)); } catch { /* tab closed */ }
        if (!parseDocumentId(state.documentId) || !parseAutoPageConfig({
          sourceLang: state.sourceLang, targetLang: state.targetLang, displayMode: state.displayMode,
        }) || ordinaryOrigin(url) !== state.origin) delete states[id];
      }
      await this.dependencies.write(states);
    });
  }

  async message(type: string, payload: unknown, sender: RuntimeSenderLike,
    beforeDocumentChange?: () => Promise<void>): Promise<AutoPageState | null> {
    if (!isTopPageSender(sender, this.dependencies.extensionId())) throw new Error('TOP_CONTENT_SCRIPT_REQUIRED');
    const value = payload && typeof payload === 'object' ? payload as Record<string, unknown> : {};
    const documentId = parseDocumentId(value.documentId);
    const fields = type === 'PAGE_AUTO_START' ? ['documentId', 'config']
      : type === 'PAGE_AUTO_MODE' ? ['documentId', 'displayMode']
      : type === 'PAGE_AUTO_PAUSE' ? ['documentId', 'paused'] : ['documentId'];
    if (!documentId || Object.keys(value).some((key) => !fields.includes(key))) throw new Error('INVALID_AUTO_PAGE_REQUEST');
    const tabId = sender.tab!.id!;
    return this.transaction(async (states) => {
      const url = await this.dependencies.tabUrl(tabId);
      if (!await this.matchesDocument(tabId, documentId, sender.url)) throw new Error('STALE_PAGE');
      const origin = ordinaryOrigin(url)!;
      let state: AutoPageState | undefined = states[String(tabId)];
      if (state && state.origin !== origin) {
        delete states[String(tabId)];
        await this.dependencies.write(states);
        state = undefined;
      }
      if (state?.navigationPending && state.documentId === documentId
        && (type === 'PAGE_AUTO_START' || type === 'PAGE_AUTO_READY')) throw new Error('STALE_PAGE');
      if (type === 'PAGE_AUTO_START') {
        const config = parseAutoPageConfig(value.config);
        if (!config) throw new Error('INVALID_AUTO_PAGE_CONFIG');
        if (state && state.documentId !== documentId) await beforeDocumentChange?.();
        state = { ...config, origin, documentId, paused: false };
        states[String(tabId)] = state;
        await this.dependencies.write(states);
      } else if (type === 'PAGE_AUTO_READY') {
        if (state && state.documentId !== documentId) {
          await beforeDocumentChange?.();
          state = { ...state, documentId, navigationPending: false };
          states[String(tabId)] = state;
          await this.dependencies.write(states);
        }
      } else if (state?.documentId === documentId) {
        if (type === 'PAGE_AUTO_STOP') {
          delete states[String(tabId)];
          state = undefined;
        } else if (type === 'PAGE_AUTO_PAUSE') {
          if (typeof value.paused !== 'boolean') throw new Error('INVALID_AUTO_PAGE_REQUEST');
          state = { ...state, paused: value.paused };
          states[String(tabId)] = state;
        } else if (type === 'PAGE_AUTO_MODE') {
          if (value.displayMode !== 'replace' && value.displayMode !== 'bilingual') throw new Error('INVALID_AUTO_PAGE_REQUEST');
          state = { ...state, displayMode: value.displayMode };
          states[String(tabId)] = state;
        }
        await this.dependencies.write(states);
      }
      return state ? { ...state } : null;
    });
  }

  async navigation(tabId: number, url: string | undefined, loading = false, completed = false): Promise<boolean | null> {
    return this.transaction(async (states) => {
      const state = states[String(tabId)];
      if (state && url !== undefined && ordinaryOrigin(url) !== state.origin) {
        delete states[String(tabId)];
        await this.dependencies.write(states);
        return false;
      }
      if (state && loading && !state.navigationPending) {
        states[String(tabId)] = { ...state, navigationPending: true };
        await this.dependencies.write(states);
      }
      if (state?.navigationPending && completed && this.dependencies.liveDocument
        && await this.matchesDocument(tabId, state.documentId, state.origin)) {
        states[String(tabId)] = { ...state, navigationPending: false };
        await this.dependencies.write(states);
      }
      return state ? true : null;
    });
  }

  async assertLiveDocument(documentId: string, sender: RuntimeSenderLike): Promise<void> {
    if (!isTopPageSender(sender, this.dependencies.extensionId())) throw new Error('TOP_CONTENT_SCRIPT_REQUIRED');
    await this.transaction(async (states) => {
      const tabId = sender.tab!.id!;
      if (!await this.matchesDocument(tabId, documentId, sender.url)) throw new Error('STALE_PAGE');
      const state = states[String(tabId)];
      if (state && (state.navigationPending || state.documentId !== documentId)) throw new Error('STALE_PAGE');
    });
  }

  async remove(tabId: number): Promise<void> {
    await this.transaction(async (states) => {
      if (!(String(tabId) in states)) return;
      delete states[String(tabId)];
      await this.dependencies.write(states);
    });
  }
}

export const autoPages = new AutoPages({
  extensionId: () => browser.runtime.id,
  read: async () => ((await browser.storage.session.get(STORAGE_KEY))[STORAGE_KEY] ?? {}) as Record<string, AutoPageState>,
  write: async (states) => { await browser.storage.session.set({ [STORAGE_KEY]: states }); },
  tabUrl: async (tabId) => (await browser.tabs.get(tabId)).url,
  liveDocument: async (tabId) => {
    const nonce = crypto.randomUUID();
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const result = await Promise.race([
        browser.tabs.sendMessage(tabId, { type: 'PAGE_DOCUMENT_PROBE', nonce }, { frameId: 0 }),
        new Promise<null>((resolve) => { timer = setTimeout(() => resolve(null), 1500); }),
      ]) as { nonce?: string; documentId?: string; url?: string } | null;
      return result?.nonce === nonce && parseDocumentId(result.documentId) && typeof result.url === 'string'
        ? { documentId: result.documentId!, url: result.url } : null;
    } finally { clearTimeout(timer); }
  },
});
