import { extractTranslationItems, type DomTranslationItem } from './dom-walker.ts';
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
  /** Requests that ended abnormally after every one of their items was received. Not an item count. */
  abnormalBatches: number;
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
    const identity = this.currentIdentity();
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
    const identity = {
      taskId: request.taskId,
      sessionId: request.sessionId,
      generation: request.generation ?? this.generation,
    };
    try {
      const response = await browser.runtime.sendMessage({ type: 'TRANSLATE_BATCH', payload: request });
      if (!this.isCurrent(identity)) return;
      if (!response?.success) {
        this.recordBatchFailure(batch, 'interrupted/unknown', response?.error ?? 'BACKGROUND_UNAVAILABLE');
      } else {
        this.applyBatchResult(response.data as TranslationBatchResult, options.displayMode);
      }
    } catch {
      const recovered = await this.recoverBatch(request, identity);
      if (!this.isCurrent(identity)) return;
      if (recovered) this.applyBatchResult(recovered, options.displayMode);
      else this.recordBatchFailure(batch, 'interrupted/unknown', 'BACKGROUND_INTERRUPTED');
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
    this.batchOutcomes.set(result.batchId, result.status);
    for (const item of result.items) {
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
      this.pendingDomAck.delete(domItemId);
      if (!wrote || !meta) continue;
      const key = `${this.taskId}:${meta.requestId}:${meta.attempt}`;
      if (this.reportedWriteKeys.has(key)) continue;
      this.reportedWriteKeys.add(key);
      this.streamPort?.postMessage({
        type: 'page-write',
        taskId: this.taskId,
        sessionId: this.sessionId,
        generation: this.generation,
        batchId: meta.batchId,
        requestId: meta.requestId,
        attempt: meta.attempt,
      });
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
      abnormalBatches: this.abnormalBatchCount(),
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

  private async control(action: 'pause' | 'resume' | 'cancel' | 'restore'): Promise<void> {
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
