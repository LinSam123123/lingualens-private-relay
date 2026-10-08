import { extractTranslationItems, isEligibleTranslationNode, type DomTranslationItem } from './dom-walker.ts';
import type {
  BatchItemResult,
  TranslationBatchRequest,
  TranslationBatchResult,
} from '../../shared/types';
import {
  buildBatches,
  buildNetworkItems,
  type BatchDefinition,
  type NetworkItem,
} from './page-batching.ts';
import {
  decideStreamApply,
  PAGE_PORT_NAME,
  STREAM_DOM_FLUSH_MS,
  type StreamItemMessage,
} from '../../shared/stream-delivery.ts';
import { NodeRevisions } from './node-revisions.ts';
import { DynamicPageObserver, nearViewport } from './dynamic-observer.ts';
import { failureKind, type FailureKind } from './failure-summary.ts';

export type DisplayMode = 'replace' | 'bilingual';

export interface PageTranslateOptions {
  targetLang: string;
  sourceLang: string;
  displayMode: DisplayMode;
  maxCharsPerRequest: number;
  maxItemsPerRequest: number;
  maxPageChars: number;
  maxPageRequests: number;
  continuous?: boolean;
  visibleOnly?: boolean;
  startPaused?: boolean;
}

export interface TranslateProgress {
  total: number;
  pending: number;
  done: number;
  errors: number;
  unknown: number;
  cancelled: number;
  /** Requests that ended abnormally after every one of their items was received. Not an item count. */
  abnormalBatches: number;
  listening?: boolean;
  budgetExhausted?: boolean;
  channelDisconnected?: boolean;
  navigationWaiting?: boolean;
  failures?: Array<{ kind: FailureKind; count: number }>;
}

type ProgressCallback = (progress: TranslateProgress) => void;

export class PageTranslateEngine {
  private domItems: DomTranslationItem[] = [];
  private domById = new Map<string, DomTranslationItem>();
  private chunksByDomId = new Map<string, NetworkItem[]>();
  private translatedChunks = new Map<string, string>();
  private itemFailures = new Map<string, BatchItemResult>();
  private bilingualMarkers: HTMLElement[] = [];
  private taskId = '';
  private sessionId = crypto.randomUUID();
  private batches: BatchDefinition[] = [];
  private isRunning = false;
  private isPaused = false;
  private isCancelled = false;
  private progress: TranslateProgress = {
    total: 0, pending: 0, done: 0, errors: 0, unknown: 0, cancelled: 0, abnormalBatches: 0,
  };
  private batchOutcomes = new Map<string, TranslationBatchResult['status']>();
  private generation = 0;
  private streamClosed = false;
  private displayMode: DisplayMode = 'bilingual';
  private progressListener: ProgressCallback | null = null;
  private streamPort: Browser.runtime.Port | null = null;
  private domRefresh = new Set<string>();
  private flushTimer: ReturnType<typeof setTimeout> | null = null;
  private pendingDomAck = new Map<string, { batchId: string; requestId: string; attempt: number }>();
  private reportedWriteKeys = new Set<string>();
  private revisions = new NodeRevisions();
  private observer: DynamicPageObserver | null = null;
  private sessionOptions: PageTranslateOptions | null = null;
  private pendingDynamic = new Map<string, DomTranslationItem>();
  private deferredBatches: BatchDefinition[] = [];
  private budgetExhausted = false;
  private suspended = false;
  private portLost = false;
  private journalCharged = false;
  private navigationWaiting = false;
  private documentCheck: ReturnType<typeof setTimeout> | null = null;

  documentReady(): void {
    if (this.isCancelled || !this.navigationWaiting) return;
    this.navigationWaiting = false;
    this.emitProgress();
    void this.pumpDynamic();
  }

  private checkDocument(attempt = 0): void {
    if (this.documentCheck || attempt >= 3) return;
    const identity = this.currentIdentity();
    this.documentCheck = setTimeout(async () => {
      this.documentCheck = null;
      if (!this.isCurrent(identity) || this.isCancelled || !this.navigationWaiting) return;
      const reply = await browser.runtime.sendMessage({
        type: 'PAGE_AUTO_READY', payload: { documentId: identity.sessionId },
      }).catch(() => null);
      if (!this.isCurrent(identity) || this.isCancelled) return;
      if (reply?.success && (!reply.data || reply.data.documentId === identity.sessionId)) this.documentReady();
      else this.checkDocument(attempt + 1);
    }, 500);
  }

  get listening(): boolean { return this.observer !== null && !this.isCancelled; }
  get automaticActive(): boolean { return this.sessionOptions?.continuous === true && !this.isCancelled; }
  get documentSessionId(): string { return this.sessionId; }

  get running(): boolean {
    return this.isRunning;
  }

  get paused(): boolean {
    return this.isPaused;
  }

  async start(options: PageTranslateOptions, onProgress: ProgressCallback): Promise<void> {
    if (this.isRunning) return;
    this.resetTaskState();
    this.isCancelled = false;
    this.isPaused = options.startPaused === true;
    this.isRunning = true;
    this.generation += 1;
    this.streamClosed = false;
    this.displayMode = options.displayMode;
    this.progressListener = onProgress;
    this.taskId = crypto.randomUUID();
    this.sessionOptions = { ...options };
    this.domItems = !options.visibleOnly || (!document.hidden && !this.isPaused)
      ? extractTranslationItems(document.body, options.maxPageChars, (node) =>
        !options.visibleOnly || Boolean(node.parentElement && nearViewport(node.parentElement)))
        .map((item) => this.revisions.claim(item)!).filter(Boolean)
      : [];
    this.domById = new Map(this.domItems.map((item) => [item.id, item]));
    if (options.continuous) this.watch();

    const networkItems = buildNetworkItems(this.domItems, options.maxCharsPerRequest);
    this.batches = buildBatches(
      networkItems,
      options.maxCharsPerRequest,
      options.maxItemsPerRequest,
    ).slice(0, options.maxPageRequests);
    const scheduledItems = this.batches.flatMap((batch) => batch.items);
    for (const item of scheduledItems) {
      const list = this.chunksByDomId.get(item.domItemId) ?? [];
      list.push(item);
      this.chunksByDomId.set(item.domItemId, list);
    }
    this.progress = {
      total: scheduledItems.length,
      pending: scheduledItems.length,
      done: 0,
      errors: 0,
      unknown: 0,
      cancelled: 0,
      abnormalBatches: 0,
    };
    onProgress({ ...this.progress });

    const identity = this.currentIdentity();
    await this.ensureStreamPort(identity);
    if (!this.isCurrent(identity)) return;
    const tasks = this.batches.map((batch) => this.submitBatch(batch, options, onProgress));
    await Promise.allSettled(tasks);
    await this.finishTask(identity);
  }

  private watch(): void {
    if (this.observer || typeof MutationObserver === 'undefined' || typeof IntersectionObserver === 'undefined') return;
    this.observer = new DynamicPageObserver(
      (root) => this.collectDynamic(root),
      (node) => this.revisions.isOwnText(node),
      () => !this.isPaused && !this.isCancelled && !this.budgetExhausted && !document.hidden,
    );
    document.addEventListener('visibilitychange', this.onVisibility);
    if (this.sessionOptions?.visibleOnly) this.observer.schedule(document.body);
  }

  private onVisibility = (): void => {
    void this.control(document.hidden || this.isPaused ? 'pause' : 'resume');
    if (!document.hidden) {
      this.observer?.wake();
      void this.pumpDynamic();
    }
  };

  private collectDynamic(root: Element): void {
    const options = this.sessionOptions;
    if (!options || !this.listening || this.budgetExhausted) return;
    for (const candidate of extractTranslationItems(root, options.maxPageChars, (node) => {
      const parent = node.parentElement;
      if (parent && nearViewport(parent)) return true;
      if (parent) this.observer?.defer(parent);
      return false;
    })) {
      const item = this.revisions.claim(candidate);
      if (!item) {
        const existing = this.revisions.itemFor(candidate.node);
        if (existing) this.domRefresh.add(existing.id);
        continue;
      }
      // A reused node no longer owns any marker belonging to its previous revision.
      for (const previous of this.domItems.filter((entry) => entry.node === item.node)) {
        for (const marker of this.bilingualMarkers.filter((entry) => entry.dataset.lingualensFor === previous.id)) marker.remove();
      }
      this.pendingDynamic.set(item.id, item);
    }
    this.flushDom(this.displayMode);
    void this.pumpDynamic();
  }

  /** Explicit supplementation is still viewport-gated and never retries an old revision. */
  supplement(explicit = true): void {
    if (!this.listening) return;
    if (explicit) this.portLost = false;
    if (explicit && this.navigationWaiting) this.checkDocument();
    this.observer?.schedule(document.body);
    if (explicit) void this.pumpDynamic();
  }

  private async pumpDynamic(): Promise<void> {
    if (this.isRunning || this.isPaused || this.isCancelled || this.suspended
      || this.portLost || this.navigationWaiting || document.hidden || this.budgetExhausted || !this.sessionOptions
      || (!this.listening && this.deferredBatches.length === 0)) return;
    const options = this.sessionOptions;
    const additions: DomTranslationItem[] = [];
    for (const [id, item] of this.pendingDynamic) {
      this.pendingDynamic.delete(id);
      if (!this.revisions.current(item)) continue;
      additions.push(item);
    }
    if (additions.length === 0 && this.deferredBatches.length === 0) { this.emitProgress(); return; }
    this.isRunning = true;
    this.domItems.push(...additions);
    for (const item of additions) this.domById.set(item.id, item);
    const batches = this.deferredBatches.splice(0).map((batch) => ({
      ...batch, items: batch.items.filter((item) => this.currentNetworkItem(item.id)),
    })).filter((batch) => batch.items.length > 0);
    const newBatches = buildBatches(buildNetworkItems(additions, options.maxCharsPerRequest),
      options.maxCharsPerRequest, options.maxItemsPerRequest);
    for (const batch of newBatches) {
      batch.batchId = `batch-${String(this.batches.length + 1).padStart(4, '0')}`;
      this.batches.push(batch);
      for (const item of batch.items) {
        const chunks = this.chunksByDomId.get(item.domItemId) ?? [];
        chunks.push(item);
        this.chunksByDomId.set(item.domItemId, chunks);
      }
    }
    batches.push(...newBatches);
    this.emitProgress();
    const identity = this.currentIdentity();
    await this.ensureStreamPort(identity);
    if (!this.isCurrent(identity) || this.isCancelled) return;
    if (document.hidden || this.isPaused || this.portLost) {
      this.deferredBatches.unshift(...batches);
      this.isRunning = false;
      this.emitProgress();
      return;
    }
    await Promise.allSettled(batches.map((batch) => this.submitBatch(batch, options, () => this.emitProgress())));
    await this.finishTask(identity);
  }

  private emitProgress(): void {
    this.recountProgress();
    this.progressListener?.({ ...this.progress });
  }

  private stopWatching(): void {
    if (this.documentCheck) clearTimeout(this.documentCheck);
    this.documentCheck = null;
    this.observer?.disconnect();
    this.observer = null;
    document.removeEventListener?.('visibilitychange', this.onVisibility);
    this.pendingDynamic.clear();
    this.deferredBatches = [];
  }

  async suspend(): Promise<void> {
    if (!this.listening) return;
    this.suspended = true;
    this.generation += 1;
    this.stopWatching();
    this.streamClosed = true;
    this.closeStreamPort();
    this.isRunning = false;
    for (const batch of this.batches) this.recordBatchFailure(batch, 'cancelled', 'PAGE_SUSPENDED');
    await this.control('suspend');
  }

  async reattach(): Promise<void> {
    if (!this.suspended || this.isCancelled || !this.sessionOptions) return;
    this.suspended = false;
    this.portLost = false;
    this.streamClosed = false;
    await this.control(this.isPaused ? 'pause' : 'resume');
    this.watch();
    this.supplement();
    this.emitProgress();
  }

  async pause(): Promise<void> {
    if ((!this.isRunning && !this.listening) || this.isPaused) return;
    this.isPaused = true;
    await this.control('pause');
  }

  async resume(): Promise<void> {
    if ((!this.isRunning && !this.listening) || !this.isPaused || this.isCancelled) return;
    this.isPaused = false;
    this.portLost = false;
    await this.control('resume');
    this.observer?.wake();
    void this.pumpDynamic();
  }

  async cancel(): Promise<void> {
    this.stopWatching();
    if (!this.taskId || this.isCancelled) return;
    this.isCancelled = true;
    this.generation += 1;
    this.streamClosed = true;
    this.isPaused = false;
    this.closeStreamPort();
    this.isRunning = false;
    await this.control('cancel');
  }

  async restore(): Promise<void> {
    this.stopWatching();
    this.generation += 1;
    this.streamClosed = true;
    this.closeStreamPort();
    const control = this.taskId ? this.control('restore') : Promise.resolve();
    this.isCancelled = true;
    this.isRunning = false;
    this.isPaused = false;
    for (const item of this.domItems) {
      this.revisions.restore(item);
    }
    this.removeBilingualMarkers();
    this.resetTaskState();
    await control;
  }

  async retryFailed(
    options: PageTranslateOptions,
    onProgress: ProgressCallback,
  ): Promise<void> {
    await this.retryItems(options, onProgress, 'failed');
  }

  async retryUnknown(
    options: PageTranslateOptions,
    onProgress: ProgressCallback,
  ): Promise<void> {
    await this.retryItems(options, onProgress, 'interrupted/unknown');
  }

  private async retryItems(
    options: PageTranslateOptions,
    onProgress: ProgressCallback,
    status: 'failed' | 'interrupted/unknown',
  ): Promise<void> {
    if (this.isRunning || this.budgetExhausted) return;
    const ids = [...this.itemFailures.values()]
      .filter((item) => item.status === status && this.currentNetworkItem(item.id))
      .map((item) => item.id);
    if (ids.length === 0) { this.emitProgress(); return; }
    // Same request id, fewer items. This is not an idempotent replay.
    const retryBatches = this.batches
      .map((batch) => ({ ...batch, items: batch.items.filter((item) => ids.includes(item.id)) }))
      .filter((batch) => batch.items.length > 0);
    this.isCancelled = false;
    this.streamClosed = false;
    this.isPaused = false;
    this.portLost = false;
    this.isRunning = true;
    this.progressListener = onProgress;
    for (const id of ids) this.itemFailures.delete(id);
    this.emitProgress();
    const identity = this.currentIdentity();
    await this.control('resume');
    if (!this.isCurrent(identity)) return;
    await this.ensureStreamPort(identity);
    if (!this.isCurrent(identity)) return;
    await Promise.allSettled(
      retryBatches.map((batch) => this.submitBatch(
        batch,
        options,
        onProgress,
        status === 'interrupted/unknown',
        status === 'failed',
      )),
    );
    await this.finishTask(identity);
  }

  switchMode(mode: DisplayMode): void {
    this.displayMode = mode;
    if (this.sessionOptions) this.sessionOptions.displayMode = mode;
    for (const item of this.domItems) {
      this.revisions.restore(item);
    }
    this.removeBilingualMarkers();
    for (const item of this.domItems) this.applyDomItemIfReady(item.id, mode);
  }

  private async submitBatch(
    batch: BatchDefinition,
    options: PageTranslateOptions,
    onProgress: ProgressCallback,
    manualRetryUnknown = false,
    manualRetryFailed = false,
  ): Promise<void> {
    const request: TranslationBatchRequest = {
      taskId: this.taskId,
      sessionId: this.sessionId,
      batchId: batch.batchId,
      requestId: batch.requestId,
      sourceLang: options.sourceLang,
      targetLang: options.targetLang,
      items: batch.items.map(({ id, text }) => ({ id, text })),
      manualRetryUnknown,
      manualRetryFailed,
      generation: this.generation,
      requiresExistingTask: this.journalCharged,
    };
    const identity = {
      taskId: request.taskId,
      sessionId: request.sessionId,
      generation: request.generation ?? this.generation,
    };
    try {
      const response = await browser.runtime.sendMessage({ type: 'TRANSLATE_BATCH', payload: request });
      if (!this.isCurrent(identity)) return;
      if (!response?.success) {
        if (response?.error === 'PAGE_DOCUMENT_NOT_READY' && !manualRetryFailed && !manualRetryUnknown) {
          this.navigationWaiting = true;
          if (!this.deferredBatches.some((entry) => entry.batchId === batch.batchId)) this.deferredBatches.push(batch);
          this.checkDocument();
          return;
        }
        if (response?.error === 'DOCUMENT_JOURNAL_LOST' || response?.error === 'BACKGROUND_UNAVAILABLE') {
          this.portLost = true;
          this.journalCharged = true;
        }
        this.recordBatchFailure(batch, 'interrupted/unknown', response?.error ?? 'BACKGROUND_UNAVAILABLE');
      } else {
        const result = response.data as TranslationBatchResult;
        if (result.items.some((item) => item.error === 'PAGE_BUDGET_EXCEEDED')) this.budgetExhausted = true;
        this.applyBatchResult(result, this.displayMode);
      }
    } catch {
      const recovered = await this.recoverBatch(request, identity);
      if (!this.isCurrent(identity)) return;
      if (recovered) this.applyBatchResult(recovered, this.displayMode);
      else {
        this.portLost = true;
        this.journalCharged = true;
        this.recordBatchFailure(batch, 'interrupted/unknown', 'BACKGROUND_INTERRUPTED');
      }
    } finally {
      if (!this.isCurrent(identity)) return;
      this.flushDom(this.displayMode);
      this.recountProgress();
      onProgress({ ...this.progress });
    }
  }

  private currentIdentity(): { taskId: string; sessionId: string; generation: number } {
    return { taskId: this.taskId, sessionId: this.sessionId, generation: this.generation };
  }

  private isCurrent(identity: { taskId: string; sessionId: string; generation: number }): boolean {
    return identity.taskId.length > 0
      && identity.taskId === this.taskId
      && identity.sessionId === this.sessionId
      && identity.generation === this.generation;
  }

  private async finishTask(identity: { taskId: string; sessionId: string; generation: number }): Promise<void> {
    if (!this.isCurrent(identity)) return;
    this.isRunning = false;
    if (this.listening || this.suspended || this.navigationWaiting || this.deferredBatches.length > 0) {
      this.emitProgress();
      if (!this.suspended) void this.pumpDynamic();
      return;
    }
    await browser.runtime.sendMessage({
      type: 'TASK_CONTROL',
      payload: { taskId: identity.taskId, sessionId: identity.sessionId, action: 'complete' },
    }).catch(() => undefined);
  }

  private async recoverBatch(
    request: TranslationBatchRequest,
    identity: { taskId: string; sessionId: string; generation: number },
  ): Promise<TranslationBatchResult | null> {
    try {
      const recovery = await browser.runtime.sendMessage({
        type: 'GET_TASK_RECOVERY',
        payload: { taskId: request.taskId, sessionId: request.sessionId },
      });
      if (!recovery?.success) return null;
      const journal = recovery.data as {
        requestsUsed: number;
        charsUsed: number;
        batches: Record<string, { status: string; attempt: number }>;
      };
      const batch = journal.batches[request.batchId];
      if (!batch) return null;

      if (batch.status === 'queued' || batch.status === 'completed') {
        if (!this.isCurrent(identity)) return null;
        await this.ensureStreamPort(identity);
        if (!this.isCurrent(identity)) return null;
        const resumed = await browser.runtime.sendMessage({ type: 'TRANSLATE_BATCH', payload: request });
        if (!this.isCurrent(identity)) return null;
        return resumed?.success ? resumed.data as TranslationBatchResult : null;
      }

      const status = batch.status === 'failed' || batch.status === 'cancelled'
        ? batch.status
        : 'interrupted/unknown';
      return {
        taskId: request.taskId,
        batchId: request.batchId,
        requestId: request.requestId,
        status,
        attempts: batch.attempt,
        requestsUsed: journal.requestsUsed,
        charsUsed: journal.charsUsed,
        items: request.items.map((item) => ({
          id: item.id,
          status,
          error: status === 'failed'
            ? 'RECOVERED_FAILED'
            : status === 'cancelled' ? 'CANCELLED' : 'MANUAL_RETRY_REQUIRED',
        })),
      };
    } catch {
      return null;
    }
  }

  private applyBatchResult(result: TranslationBatchResult, mode: DisplayMode): void {
    if (result.requestsUsed > 0) this.journalCharged = true;
    this.batchOutcomes.set(result.batchId, result.status);
    for (const item of result.items) {
      if (!this.currentNetworkItem(item.id)) {
        if (!this.translatedChunks.has(item.id)) this.itemFailures.set(item.id, { id: item.id, status: 'cancelled', error: 'NODE_REVISED' });
        continue;
      }
      if (item.status === 'completed' && item.translated !== undefined) {
        if (!this.streamClosed && !this.translatedChunks.has(item.id)) {
          this.translatedChunks.set(item.id, item.translated);
          this.queueDomItem(item.id, result.batchId, result.requestId, result.attempts);
        }
        if (this.translatedChunks.has(item.id)) this.itemFailures.delete(item.id);
      } else if (!this.translatedChunks.has(item.id)) {
        this.itemFailures.set(item.id, item);
      }
    }
    this.flushDom(mode);
  }

  private recordBatchFailure(
    batch: BatchDefinition,
    status: 'failed' | 'interrupted/unknown' | 'cancelled',
    error: string,
  ): void {
    for (const item of batch.items) {
      if (this.translatedChunks.has(item.id)) continue;
      this.itemFailures.set(item.id, { id: item.id, status, error });
    }
  }

  private applyDomItemIfReady(domItemId: string, mode: DisplayMode): boolean {
    const item = this.domById.get(domItemId);
    const chunks = this.chunksByDomId.get(domItemId) ?? [];
    if (!item || !this.revisions.current(item) || !isEligibleTranslationNode(item.node)
      || chunks.length === 0 || chunks.some((chunk) => !this.translatedChunks.has(chunk.id))) return false;
    const translated = chunks.map((chunk) => this.translatedChunks.get(chunk.id)!).join(' ');
    if (mode === 'replace') {
      return this.revisions.write(item, `${item.leadingWhitespace}${translated}${item.trailingWhitespace}`);
    }
    if (this.bilingualMarkers.some((marker) => marker.dataset.lingualensFor === domItemId)) return false;
    const marker = document.createElement('span');
    marker.dataset.lingualensTranslation = 'true';
    marker.dataset.lingualensFor = domItemId;
    marker.style.cssText = 'color:#1a73e8;margin-left:0.35em;font-size:max(12px,1em)';
    marker.textContent = translated;
    item.node.parentNode?.insertBefore(marker, item.node.nextSibling);
    this.bilingualMarkers.push(marker);
    return true;
  }

  private boundGeneration = 0;
  private boundTaskId = '';

  private async ensureStreamPort(identity: { taskId: string; sessionId: string; generation: number }): Promise<void> {
    if (!this.isCurrent(identity) || this.streamClosed) return;
    if (this.streamPort && this.boundTaskId === identity.taskId && this.boundGeneration === identity.generation) return;
    await this.openStreamPort(identity);
  }

  private openStreamPort(identity: { taskId: string; sessionId: string; generation: number }): Promise<void> {
    this.closeStreamPort();
    return new Promise((resolve) => {
      let settled = false;
      const finish = () => {
        if (settled) return;
        settled = true;
        resolve();
      };
      try {
        const port = browser.runtime.connect({ name: PAGE_PORT_NAME });
        this.streamPort = port;
        port.onMessage.addListener((message: unknown) => {
          if (this.streamPort !== port) return;
          const record = message as { type?: string; taskId?: string; sessionId?: string; generation?: number };
          if (record?.type === 'bound') {
            if (record.taskId === identity.taskId
              && record.sessionId === identity.sessionId
              && record.generation === identity.generation
              && this.isCurrent(identity)) {
              this.boundTaskId = identity.taskId;
              this.boundGeneration = identity.generation;
            }
            finish();
            return;
          }
          this.onStreamMessage(message);
        });
        port.onDisconnect.addListener(() => {
          if (this.streamPort === port) {
            this.streamPort = null;
            this.boundTaskId = '';
            this.boundGeneration = 0;
            this.portLost = true;
            this.emitProgress();
          }
          finish();
        });
        port.postMessage({
          type: 'bind',
          taskId: identity.taskId,
          sessionId: identity.sessionId,
          generation: identity.generation,
        });
      } catch {
        this.streamPort = null;
        finish();
      }
    });
  }

  private closeStreamPort(): void {
    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }
    const port = this.streamPort;
    this.streamPort = null;
    this.boundTaskId = '';
    this.boundGeneration = 0;
    port?.disconnect();
  }

  private onStreamMessage(message: unknown): void {
    if (!message || typeof message !== 'object') return;
    const value = message as Partial<StreamItemMessage>;
    if (value.type !== 'stream-item' || !value.item || !value.batchId || !value.requestId) return;
    const decision = decideStreamApply({
      taskId: this.taskId,
      sessionId: this.sessionId,
      generation: this.generation,
      closed: this.streamClosed,
      translatedIds: new Set(this.translatedChunks.keys()),
      expectedIds: new Set(this.batches.flatMap((batch) => batch.items.map((item) => item.id))),
    }, value as StreamItemMessage);
    if (decision !== 'apply') return;
    if (!this.currentNetworkItem(value.item.id)) return;
    this.translatedChunks.set(value.item.id, value.item.text);
    this.itemFailures.delete(value.item.id);
    this.queueDomItem(value.item.id, value.batchId, value.requestId, value.attempt);
    this.recountProgress();
    this.progressListener?.({ ...this.progress });
  }

  private queueDomItem(itemId: string, batchId: string, requestId: string, attempt: number | undefined): void {
    const network = this.batches.flatMap((batch) => batch.items).find((entry) => entry.id === itemId);
    if (!network) return;
    this.domRefresh.add(network.domItemId);
    if (Number.isInteger(attempt) && (attempt as number) >= 0) {
      // The chunk that makes the node ready owns the acknowledgement, not an earlier attempt.
      this.pendingDomAck.set(network.domItemId, { batchId, requestId, attempt: attempt as number });
    }
    if (this.flushTimer != null) return;
    this.flushTimer = setTimeout(() => this.flushDom(this.displayMode), STREAM_DOM_FLUSH_MS);
  }

  private flushDom(mode: DisplayMode): void {
    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }
    for (const domItemId of this.domRefresh) {
      const meta = this.pendingDomAck.get(domItemId);
      const wrote = this.applyDomItemIfReady(domItemId, mode);
      const dom = this.domById.get(domItemId);
      // A temporarily closed drawer retains both its successful result and write ownership.
      if (!wrote && dom && this.revisions.current(dom) && !isEligibleTranslationNode(dom.node)) continue;
      this.pendingDomAck.delete(domItemId);
      if (!wrote || !meta) continue;
      const key = `${this.taskId}:${meta.requestId}:${meta.attempt}`;
      if (this.reportedWriteKeys.has(key)) continue;
      this.reportedWriteKeys.add(key);
      try {
        this.streamPort?.postMessage({
          type: 'page-write',
          taskId: this.taskId,
          sessionId: this.sessionId,
          generation: this.generation,
          batchId: meta.batchId,
          requestId: meta.requestId,
          attempt: meta.attempt,
        });
      } catch {
        this.closeStreamPort();
        this.portLost = true;
      }
    }
    this.domRefresh.clear();
  }

  private recountProgress(): void {
    const scheduledItems = this.batches.flatMap((batch) => batch.items);
    let done = 0;
    let errors = 0;
    let unknown = 0;
    let cancelled = 0;
    const failures = new Map<FailureKind, number>();
    for (const network of scheduledItems) {
      const id = network.id;
      if (this.translatedChunks.has(id)) done++;
      else {
        const dom = this.domById.get(network.domItemId);
        if (!dom || !this.revisions.current(dom)) {
          this.itemFailures.set(id, { id, status: 'cancelled', error: 'NODE_REVISED' });
        }
        const failure = this.itemFailures.get(id);
        if (failure?.status === 'interrupted/unknown') unknown++;
        else if (failure?.status === 'cancelled') cancelled++;
        else if (failure) errors++;
        if (failure && failure.status !== 'cancelled') {
          const kind = failureKind(failure.error, failure.status);
          failures.set(kind, (failures.get(kind) ?? 0) + 1);
        }
      }
    }
    this.progress = {
      total: scheduledItems.length,
      pending: Math.max(0, scheduledItems.length - done - errors - unknown - cancelled),
      done,
      errors,
      unknown,
      cancelled,
      abnormalBatches: this.abnormalBatchCount(),
      listening: this.listening,
      budgetExhausted: this.budgetExhausted,
      channelDisconnected: this.portLost,
      navigationWaiting: this.navigationWaiting,
      failures: [...failures].map(([kind, count]) => ({ kind, count })),
    };
  }

  private abnormalBatchCount(): number {
    let count = 0;
    for (const [batchId, status] of this.batchOutcomes) {
      if (status === 'completed') continue;
      const batch = this.batches.find((entry) => entry.batchId === batchId);
      if (!batch || batch.items.length === 0) continue;
      if (batch.items.every((item) => this.translatedChunks.has(item.id))) count += 1;
    }
    return count;
  }

  private currentNetworkItem(id: string): boolean {
    const network = this.batches.flatMap((batch) => batch.items).find((item) => item.id === id);
    const dom = network && this.domById.get(network.domItemId);
    return Boolean(dom && this.revisions.current(dom));
  }

  private async control(action: 'pause' | 'resume' | 'cancel' | 'restore' | 'suspend'): Promise<void> {
    const taskId = this.taskId;
    const sessionId = this.sessionId;
    if (!taskId) return;
    await browser.runtime.sendMessage({
      type: 'TASK_CONTROL',
      payload: { taskId, sessionId, action },
    }).catch(() => undefined);
  }

  private removeBilingualMarkers(): void {
    for (const marker of this.bilingualMarkers) marker.remove();
    this.bilingualMarkers = [];
  }

  private resetTaskState(): void {
    this.stopWatching();
    this.revisions = new NodeRevisions();
    this.sessionOptions = null;
    this.budgetExhausted = false;
    this.suspended = false;
    this.portLost = false;
    this.journalCharged = false;
    this.navigationWaiting = false;
    this.domItems = [];
    this.domById.clear();
    this.closeStreamPort();
    this.translatedChunks.clear();
    this.itemFailures.clear();
    this.chunksByDomId.clear();
    this.batches = [];
    this.batchOutcomes.clear();
    this.domRefresh.clear();
    this.pendingDomAck.clear();
    this.reportedWriteKeys.clear();
    this.taskId = '';
    this.progress = {
      total: 0, pending: 0, done: 0, errors: 0, unknown: 0, cancelled: 0, abnormalBatches: 0,
    };
  }
}
