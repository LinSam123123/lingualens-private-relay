import { extractTranslationItems, type DomTranslationItem } from './dom-walker';
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
} from './page-batching';
import {
  decideStreamApply,
  PAGE_PORT_NAME,
  STREAM_DOM_FLUSH_MS,
  type StreamItemMessage,
} from '../../shared/stream-delivery';

export type DisplayMode = 'replace' | 'bilingual';

export interface PageTranslateOptions {
  targetLang: string;
  sourceLang: string;
  displayMode: DisplayMode;
  maxCharsPerRequest: number;
  maxItemsPerRequest: number;
  maxPageChars: number;
  maxPageRequests: number;
}

export interface TranslateProgress {
  total: number;
  pending: number;
  done: number;
  errors: number;
  unknown: number;
  cancelled: number;
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
    total: 0, pending: 0, done: 0, errors: 0, unknown: 0, cancelled: 0,
  };
  private generation = 0;
  private streamClosed = false;
  private displayMode: DisplayMode = 'bilingual';
  private progressListener: ProgressCallback | null = null;
  private streamPort: Browser.runtime.Port | null = null;
  private domRefresh = new Set<string>();
  private flushTimer: ReturnType<typeof setTimeout> | null = null;
  private reportedWrites = new Set<string>();

  get running(): boolean {
    return this.isRunning;
  }

  get paused(): boolean {
    return this.isPaused;
  }

  async start(options: PageTranslateOptions, onProgress: ProgressCallback): Promise<void> {
    if (this.isRunning) return;
    this.resetTaskState();
    this.isRunning = true;
    this.generation += 1;
    this.streamClosed = false;
    this.displayMode = options.displayMode;
    this.progressListener = onProgress;
    this.taskId = crypto.randomUUID();
    this.openStreamPort();
    this.domItems = extractTranslationItems(document.body, options.maxPageChars);
    this.domById = new Map(this.domItems.map((item) => [item.id, item]));

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
    };
    onProgress({ ...this.progress });

    const tasks = this.batches.map((batch) => this.submitBatch(batch, options, onProgress));
    await Promise.allSettled(tasks);
    this.isRunning = false;
    if (!this.isCancelled) {
      await browser.runtime.sendMessage({
        type: 'TASK_CONTROL',
        payload: { taskId: this.taskId, sessionId: this.sessionId, action: 'complete' },
      }).catch(() => undefined);
    }
  }

  async pause(): Promise<void> {
    if (!this.isRunning || this.isPaused) return;
    this.isPaused = true;
    await this.control('pause');
  }

  async resume(): Promise<void> {
    if (!this.isRunning || !this.isPaused || this.isCancelled) return;
    this.isPaused = false;
    await this.control('resume');
  }

  async cancel(): Promise<void> {
    if (!this.taskId || this.isCancelled) return;
    this.isCancelled = true;
    this.streamClosed = true;
    this.isPaused = false;
    this.closeStreamPort();
    await this.control('cancel');
    this.isRunning = false;
  }

  async restore(): Promise<void> {
    this.generation += 1;
    this.streamClosed = true;
    this.closeStreamPort();
    if (this.taskId) await this.control('restore');
    this.isCancelled = true;
    this.isRunning = false;
    this.isPaused = false;
    for (const item of this.domItems) {
      if (item.node.parentNode) item.node.textContent = item.originalText;
    }
    this.removeBilingualMarkers();
    this.resetTaskState();
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
    const ids = [...this.itemFailures.values()]
      .filter((item) => item.status === status)
      .map((item) => item.id);
    if (ids.length === 0) return;
    // Same request id, fewer items. This is not an idempotent replay.
    const retryBatches = this.batches
      .map((batch) => ({ ...batch, items: batch.items.filter((item) => ids.includes(item.id)) }))
      .filter((batch) => batch.items.length > 0);
    this.isCancelled = false;
    this.isRunning = true;
    await Promise.allSettled(
      retryBatches.map((batch) => this.submitBatch(
        batch,
        options,
        onProgress,
        status === 'interrupted/unknown',
        status === 'failed',
      )),
    );
    this.isRunning = false;
    await browser.runtime.sendMessage({
      type: 'TASK_CONTROL',
      payload: { taskId: this.taskId, sessionId: this.sessionId, action: 'complete' },
    }).catch(() => undefined);
  }

  switchMode(mode: DisplayMode): void {
    this.displayMode = mode;
    for (const item of this.domItems) {
      if (item.node.parentNode) item.node.textContent = item.originalText;
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
    };
    try {
      const response = await browser.runtime.sendMessage({ type: 'TRANSLATE_BATCH', payload: request });
      if (!response?.success) {
        this.recordBatchFailure(batch, 'interrupted/unknown', response?.error ?? 'BACKGROUND_UNAVAILABLE');
      } else {
        this.applyBatchResult(response.data as TranslationBatchResult, options.displayMode);
      }
    } catch {
      const recovered = await this.recoverBatch(request);
      if (recovered) this.applyBatchResult(recovered, options.displayMode);
      else this.recordBatchFailure(batch, 'interrupted/unknown', 'BACKGROUND_INTERRUPTED');
    } finally {
      this.flushDom(this.displayMode);
      this.recountProgress();
      onProgress({ ...this.progress });
    }
  }

  private async recoverBatch(request: TranslationBatchRequest): Promise<TranslationBatchResult | null> {
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
        const resumed = await browser.runtime.sendMessage({ type: 'TRANSLATE_BATCH', payload: request });
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
    for (const item of result.items) {
      if (item.status === 'completed' && item.translated !== undefined) {
        if (!this.streamClosed && !this.translatedChunks.has(item.id)) {
          this.translatedChunks.set(item.id, item.translated);
          this.queueDomItem(item.id, result.batchId, result.requestId);
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
    if (!item || chunks.length === 0 || chunks.some((chunk) => !this.translatedChunks.has(chunk.id))) return false;
    const translated = chunks.map((chunk) => this.translatedChunks.get(chunk.id)!).join(' ');
    if (mode === 'replace') {
      item.node.textContent = `${item.leadingWhitespace}${translated}${item.trailingWhitespace}`;
      return true;
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

  private openStreamPort(): void {
    this.closeStreamPort();
    try {
      const port = browser.runtime.connect({ name: PAGE_PORT_NAME });
      this.streamPort = port;
      port.onMessage.addListener((message: unknown) => this.onStreamMessage(message));
      port.onDisconnect.addListener(() => {
        if (this.streamPort === port) this.streamPort = null;
      });
      port.postMessage({
        type: 'bind',
        taskId: this.taskId,
        sessionId: this.sessionId,
        generation: this.generation,
      });
    } catch {
      this.streamPort = null;
    }
  }

  private closeStreamPort(): void {
    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }
    this.streamPort?.disconnect();
    this.streamPort = null;
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
    this.translatedChunks.set(value.item.id, value.item.text);
    this.itemFailures.delete(value.item.id);
    this.queueDomItem(value.item.id, value.batchId, value.requestId);
    this.recountProgress();
    this.progressListener?.({ ...this.progress });
  }

  private queueDomItem(itemId: string, batchId: string, requestId: string): void {
    const network = this.batches.flatMap((batch) => batch.items).find((entry) => entry.id === itemId);
    if (!network) return;
    this.domRefresh.add(network.domItemId);
    if (!this.writeBatchByDom) this.writeBatchByDom = new Map();
    if (!this.writeBatchByDom.has(network.domItemId)) {
      this.writeBatchByDom.set(network.domItemId, { batchId, requestId });
    }
    if (this.flushTimer != null) return;
    this.flushTimer = setTimeout(() => this.flushDom(this.displayMode), STREAM_DOM_FLUSH_MS);
  }

  private writeBatchByDom: Map<string, { batchId: string; requestId: string }> | null = null;

  private flushDom(mode: DisplayMode): void {
    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }
    for (const domItemId of this.domRefresh) {
      const wrote = this.applyDomItemIfReady(domItemId, mode);
      const meta = this.writeBatchByDom?.get(domItemId);
      if (wrote && meta && !this.reportedWrites.has(meta.batchId)) {
        this.reportedWrites.add(meta.batchId);
        this.streamPort?.postMessage({
          type: 'page-write',
          taskId: this.taskId,
          sessionId: this.sessionId,
          generation: this.generation,
          batchId: meta.batchId,
          requestId: meta.requestId,
        });
      }
    }
    this.domRefresh.clear();
  }

  private recountProgress(): void {
    const scheduledIds = this.batches.flatMap((batch) => batch.items.map((item) => item.id));
    let done = 0;
    let errors = 0;
    let unknown = 0;
    let cancelled = 0;
    for (const id of scheduledIds) {
      if (this.translatedChunks.has(id)) done++;
      else {
        const failure = this.itemFailures.get(id);
        if (failure?.status === 'interrupted/unknown') unknown++;
        else if (failure?.status === 'cancelled') cancelled++;
        else if (failure) errors++;
      }
    }
    this.progress = {
      total: scheduledIds.length,
      pending: Math.max(0, scheduledIds.length - done - errors - unknown - cancelled),
      done,
      errors,
      unknown,
      cancelled,
    };
  }

  private async control(action: 'pause' | 'resume' | 'cancel' | 'restore'): Promise<void> {
    await browser.runtime.sendMessage({
      type: 'TASK_CONTROL',
      payload: { taskId: this.taskId, sessionId: this.sessionId, action },
    }).catch(() => undefined);
  }

  private removeBilingualMarkers(): void {
    for (const marker of this.bilingualMarkers) marker.remove();
    this.bilingualMarkers = [];
  }

  private resetTaskState(): void {
    this.closeStreamPort();
    this.translatedChunks.clear();
    this.itemFailures.clear();
    this.chunksByDomId.clear();
    this.batches = [];
    this.domRefresh.clear();
    this.reportedWrites.clear();
    this.writeBatchByDom = new Map();
    this.taskId = '';
    this.progress = { total: 0, pending: 0, done: 0, errors: 0, unknown: 0, cancelled: 0 };
  }
}
