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

export type DisplayMode = 'replace' | 'bilingual';

export interface PageTranslateOptions {
  targetLang: string;
  sourceLang: string;
  displayMode: DisplayMode;
  maxCharsPerRequest: number;
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
    this.taskId = crypto.randomUUID();
    this.domItems = extractTranslationItems(document.body, options.maxPageChars);
    this.domById = new Map(this.domItems.map((item) => [item.id, item]));

    const networkItems = buildNetworkItems(this.domItems, options.maxCharsPerRequest);
    this.batches = buildBatches(networkItems, options.maxCharsPerRequest)
      .slice(0, options.maxPageRequests);
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
    this.isPaused = false;
    await this.control('cancel');
    this.isRunning = false;
  }

  async restore(): Promise<void> {
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
        this.translatedChunks.set(item.id, item.translated);
        this.itemFailures.delete(item.id);
      } else {
        this.itemFailures.set(item.id, item);
      }
      const network = this.batches.flatMap((batch) => batch.items).find((entry) => entry.id === item.id);
      if (network) this.applyDomItemIfReady(network.domItemId, mode);
    }
  }

  private recordBatchFailure(
    batch: BatchDefinition,
    status: 'failed' | 'interrupted/unknown' | 'cancelled',
    error: string,
  ): void {
    for (const item of batch.items) this.itemFailures.set(item.id, { id: item.id, status, error });
  }

  private applyDomItemIfReady(domItemId: string, mode: DisplayMode): void {
    const item = this.domById.get(domItemId);
    const chunks = this.chunksByDomId.get(domItemId) ?? [];
    if (!item || chunks.length === 0 || chunks.some((chunk) => !this.translatedChunks.has(chunk.id))) return;
    const translated = chunks.map((chunk) => this.translatedChunks.get(chunk.id)!).join(' ');
    if (mode === 'replace') {
      item.node.textContent = `${item.leadingWhitespace}${translated}${item.trailingWhitespace}`;
      return;
    }
    if (this.bilingualMarkers.some((marker) => marker.dataset.lingualensFor === domItemId)) return;
    const marker = document.createElement('span');
    marker.dataset.lingualensTranslation = 'true';
    marker.dataset.lingualensFor = domItemId;
    marker.style.cssText = 'color:#1a73e8;margin-left:0.35em;font-size:max(12px,1em)';
    marker.textContent = translated;
    item.node.parentNode?.insertBefore(marker, item.node.nextSibling);
    this.bilingualMarkers.push(marker);
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
    this.translatedChunks.clear();
    this.itemFailures.clear();
    this.chunksByDomId.clear();
    this.batches = [];
    this.taskId = '';
    this.progress = { total: 0, pending: 0, done: 0, errors: 0, unknown: 0, cancelled: 0 };
  }
}
