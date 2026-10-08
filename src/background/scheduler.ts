import type {
  BatchItemResult,
  BatchStatus,
  ProviderConfig,
  TaskControlAction,
  TranslationBatchRequest,
  TranslationBatchResult,
} from '../shared/types';
import { RelayAdapter, RelayHttpError, type RelayFetchTiming } from '../providers/relay.ts';
import {
  classifyRetry,
  classifyStreamItems,
  priorBatchDecision,
  retryDelayMs,
  taskControlPolicy,
} from './scheduler-policy.ts';
import {
  consumeDispatchBudget,
  ensureTask,
  getTaskJournal,
  noteCompletedItems,
  removeTabTaskJournals,
  setTaskStatus,
  transitionBatch,
  type TaskJournalEntry,
} from './task-journal.ts';
import { publishStreamItem } from './page-port.ts';
import { setPageWriteListener } from '../shared/stream-delivery.ts';
import type { StreamTerminalKind } from '../shared/relay-stream';
import {
  confirmPageWrite,
  recordBatchDiagnostic,
  recordTaskTiming,
  sanitizeDiagnosticStatus,
} from './batch-diagnostics.ts';
import { validateBatchLimits } from '../content/page-translator/page-batching.ts';

interface PendingBatch {
  request: TranslationBatchRequest;
  tabId: number;
  frameId: number;
  relay: RelayAdapter;
  config: ProviderConfig;
  resolve: (result: TranslationBatchResult) => void;
  enqueuedAt: number;
}

interface RuntimeTask {
  tabId?: number;
  paused: boolean;
  cancelled: boolean;
  queue: PendingBatch[];
  active: Map<string, AbortController>;
  settling: Set<Promise<void>>;
}

function itemResults(
  request: TranslationBatchRequest,
  status: BatchItemResult['status'],
  error?: string,
): BatchItemResult[] {
  return request.items.map((item) => ({ id: item.id, status, ...(error ? { error } : {}) }));
}

function resultFrom(
  request: TranslationBatchRequest,
  status: TranslationBatchResult['status'],
  journal: TaskJournalEntry,
  attempts: number,
  items: BatchItemResult[],
): TranslationBatchResult {
  return {
    taskId: request.taskId,
    batchId: request.batchId,
    requestId: request.requestId,
    status,
    items,
    attempts,
    requestsUsed: journal.requestsUsed,
    charsUsed: journal.charsUsed,
  };
}

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export class TranslationScheduler {
  private tasks = new Map<string, RuntimeTask>();
  private running = 0;
  private maxConcurrency = 2;
  private checkpointIds = new Map<string, Set<string>>();
  private checkpointTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private writeSlots = new Map<string, { dispatchAt: number; taskId: string }>();
  private writesBound = false;
  private taskStarted = new Map<string, number>();
  private taskFirstWrite = new Map<string, number>();

  get activeSlotCount(): number {
    return this.running;
  }

  private runtimeTask(taskId: string): RuntimeTask {
    let task = this.tasks.get(taskId);
    if (!task) {
      task = { paused: false, cancelled: false, queue: [], active: new Map(), settling: new Set() };
      this.tasks.set(taskId, task);
    }
    return task;
  }

  async submit(
    request: TranslationBatchRequest,
    tabId: number,
    frameId: number,
    relay: RelayAdapter,
    config: ProviderConfig,
  ): Promise<TranslationBatchResult> {
    this.validateRequest(request, config);
    if (request.requiresExistingTask && !await getTaskJournal(request.taskId, request.sessionId)) {
      throw new Error('DOCUMENT_JOURNAL_LOST');
    }
    this.maxConcurrency = Math.min(10, Math.max(1, config.maxConcurrency ?? 2));
    if (!this.taskStarted.has(request.taskId)) this.taskStarted.set(request.taskId, Date.now());
    const journal = await ensureTask(request, tabId);
    if (journal.status === 'cancel' || journal.status === 'restore'
      || (request.generation ?? 0) < (journal.generationFloor ?? 0)) {
      const stopped = await transitionBatch(request.taskId, request.batchId, 'cancelled');
      return resultFrom(request, 'cancelled', stopped, stopped.batches[request.batchId].attempt,
        itemResults(request, 'cancelled', 'CANCELLED'));
    }
    const prior = journal.batches[request.batchId];
    if (prior.requestId !== request.requestId) throw new Error('REQUEST_ID_MISMATCH');
    const priorDecision = priorBatchDecision(prior.status, {
      manualRetryFailed: request.manualRetryFailed === true,
      manualRetryUnknown: request.manualRetryUnknown === true,
    });
    if (priorDecision) {
      const current = prior.status === 'completed'
        ? await transitionBatch(request.taskId, request.batchId, priorDecision.status)
        : journal;
      return resultFrom(
        request,
        priorDecision.status,
        current,
        prior.attempt,
        itemResults(request, priorDecision.status, priorDecision.code),
      );
    }

    return new Promise((resolve) => {
      const freshRuntime = !this.tasks.has(request.taskId);
      const runtime = this.runtimeTask(request.taskId);
      if (freshRuntime && (journal.status === 'pause' || journal.status === 'suspend')) runtime.paused = true;
      runtime.tabId = tabId;
      runtime.queue.push({
        request,
        tabId,
        frameId,
        relay,
        config,
        resolve,
        enqueuedAt: Date.now(),
      });
      void this.dispatch();
    });
  }

  private validateRequest(request: TranslationBatchRequest, config: ProviderConfig): void {
    if (!request.taskId || request.taskId.length > 128) throw new Error('TASK_ID_INVALID');
    if (!request.sessionId || request.sessionId.length > 128) throw new Error('SESSION_ID_INVALID');
    if (!request.batchId || request.batchId.length > 128) throw new Error('BATCH_ID_INVALID');
    if (!/^[a-zA-Z0-9-]{8,128}$/.test(request.requestId)) throw new Error('REQUEST_ID_INVALID');
    validateBatchLimits(
      request.items,
      config.maxCharsPerRequest ?? 8_000,
      config.maxItemsPerRequest ?? 0,
    );
  }

  private async dispatch(): Promise<void> {
    while (this.running < this.maxConcurrency) {
      const entry = [...this.tasks.values()].find(
        (task) => !task.paused && !task.cancelled && task.queue.length > 0,
      );
      if (!entry) return;
      const pending = entry.queue.shift()!;
      this.running++;
      const operation = this.execute(pending, entry)
        .then(pending.resolve)
        .catch(async () => {
          const journal = await getTaskJournal(pending.request.taskId, pending.request.sessionId).catch(() => null);
          const status = entry.cancelled ? 'cancelled' : 'interrupted/unknown';
          pending.resolve({
            taskId: pending.request.taskId, batchId: pending.request.batchId,
            requestId: pending.request.requestId, status,
            attempts: journal?.batches[pending.request.batchId]?.attempt ?? 0,
            requestsUsed: journal?.requestsUsed ?? 0, charsUsed: journal?.charsUsed ?? 0,
            items: itemResults(pending.request, status, entry.cancelled ? 'CANCELLED' : 'BACKGROUND_INTERRUPTED'),
          });
        })
        .finally(() => {
          entry.settling.delete(operation);
          this.running--;
          void this.dispatch();
        });
      entry.settling.add(operation);
    }
  }

  private async execute(pending: PendingBatch, runtime: RuntimeTask): Promise<TranslationBatchResult> {
    const { request, config, relay } = pending;
    const chars = request.items.reduce((sum, item) => sum + item.text.length, 0);
    const initial = await getTaskJournal(request.taskId, request.sessionId);
    let attempt = initial?.batches[request.batchId]?.attempt ?? 0;
    let automaticRetries = 0;
    let queuedMs = Math.max(0, Date.now() - pending.enqueuedAt);

    while (true) {
      if (runtime.cancelled) {
        const journal = await transitionBatch(request.taskId, request.batchId, 'cancelled');
        this.recordAttempt(request, {
          attempt,
          sourceChars: chars,
          queuedMs,
          status: 'cancelled:CANCELLED',
          totalMs: 0,
        });
        return resultFrom(request, 'cancelled', journal, attempt, itemResults(request, 'cancelled', 'CANCELLED'));
      }

      const budget = await consumeDispatchBudget(
        request.taskId,
        request.sessionId,
        request.batchId,
        { requests: 1, chars },
        { maxRequests: config.maxPageRequests ?? 100, maxChars: config.maxPageChars ?? 100_000 },
        attempt + 1,
        request.generation,
      );
      if (!budget.ok) {
        if (budget.code === 'TASK_NOT_FOUND') throw new Error('TASK_NOT_FOUND');
        if (budget.code === 'STALE_TASK_GENERATION') {
          const journal = await transitionBatch(request.taskId, request.batchId, 'cancelled');
          return resultFrom(request, 'cancelled', journal, attempt, itemResults(request, 'cancelled', budget.code));
        }
        const journal = await transitionBatch(request.taskId, request.batchId, 'failed');
        this.recordAttempt(request, {
          attempt,
          sourceChars: chars,
          queuedMs,
          status: 'failed:PAGE_BUDGET_EXCEEDED',
          totalMs: 0,
        });
        return resultFrom(request, 'failed', journal, attempt, itemResults(request, 'failed', 'PAGE_BUDGET_EXCEEDED'));
      }
      attempt = budget.journal.batches[request.batchId]?.attempt ?? attempt + 1;
      if (runtime.cancelled) {
        const stopped = await transitionBatch(request.taskId, request.batchId, 'cancelled');
        return resultFrom(request, 'cancelled', stopped, attempt,
          itemResults(request, 'cancelled', 'CANCELLED'));
      }

      const controller = new AbortController();
      runtime.active.set(request.batchId, controller);
      let timedOut = false;
      const timeout = setTimeout(() => {
        timedOut = true;
        controller.abort();
      }, config.timeoutMs ?? 25_000);
      const dispatchStart = Date.now();
      this.bindPageWrites();
      this.writeSlots.set(`${request.requestId}:${attempt}`, { dispatchAt: dispatchStart, taskId: request.taskId });
      const timing: RelayFetchTiming = {
        headerMs: null,
        bodyMs: null,
        parseMs: null,
        firstTextDeltaMs: null,
        firstItemMs: null,
      };

      try {
        if (config.streamTranslations === true) {
          const streamed = await this.readStream(pending, runtime, controller, timing, dispatchStart, attempt);
          if (streamed.rethrow && streamed.accepted.size === 0) throw streamed.rethrow;
          const outcome = classifyStreamItems({
            expectedIds: request.items.map((item) => item.id),
            acceptedIds: [...streamed.accepted.keys()],
            rejected: streamed.rejected,
            terminal: streamed.terminal,
            cancelled: runtime.cancelled,
            timedOut,
          });
          const items: BatchItemResult[] = outcome.items.map((item) => (
            item.status === 'completed'
              ? { id: item.id, status: 'completed', translated: streamed.accepted.get(item.id) }
              : { id: item.id, status: item.status, ...(item.error ? { error: item.error } : {}) }
          ));
          await this.flushCheckpoint(request.taskId, request.batchId);
          this.recordAttempt(request, {
            attempt,
            sourceChars: chars,
            queuedMs,
            timing,
            status: outcome.status === 'completed' ? 'completed' : `${outcome.status}:${outcome.code}`,
            totalMs: Date.now() - dispatchStart,
          });
          const done = await transitionBatch(request.taskId, request.batchId, outcome.status);
          return resultFrom(request, outcome.status, done, attempt, items);
        }
        const translated = await relay.translateItems(request.items, request, {
          signal: controller.signal,
          requestId: request.requestId,
          timing,
        });
        const items: BatchItemResult[] = request.items.map((item) => {
          const output = translated.get(item.id);
          return output
            ? { id: item.id, status: 'completed', translated: output }
            : { id: item.id, status: 'failed', error: 'RESPONSE_MISSING_ITEM' };
        });
        const status: BatchStatus = items.every((item) => item.status === 'completed') ? 'completed' : 'failed';
        this.recordAttempt(request, {
          attempt,
          sourceChars: chars,
          queuedMs,
          timing,
          status: status === 'completed' ? 'completed' : 'failed:RESPONSE_MISSING_ITEM',
          totalMs: Date.now() - dispatchStart,
        });
        const done = await transitionBatch(request.taskId, request.batchId, status);
        return resultFrom(request, status, done, attempt, items);
      } catch (error) {
        const decision = classifyRetry(error, {
          attempt: automaticRetries,
          retryGatewayErrors: config.retryGatewayErrors === true,
          cancelled: runtime.cancelled,
          timedOut,
        });
        this.recordAttempt(request, {
          attempt,
          sourceChars: chars,
          queuedMs,
          timing,
          status: `${decision.terminalStatus}:${decision.code}`,
          totalMs: Date.now() - dispatchStart,
        });
        if (decision.retry) {
          automaticRetries++;
          queuedMs = 0;
          const retryAfter = error instanceof RelayHttpError ? error.retryAfter : null;
          await wait(retryDelayMs(automaticRetries - 1, retryAfter) + Math.floor(Math.random() * 250));
          continue;
        }
        const done = await transitionBatch(request.taskId, request.batchId, decision.terminalStatus, {
          attempt,
        });
        return resultFrom(
          request,
          decision.terminalStatus,
          done,
          attempt,
          itemResults(request, decision.terminalStatus, decision.code),
        );
      } finally {
        clearTimeout(timeout);
        runtime.active.delete(request.batchId);
      }
    }
  }

  private bindPageWrites(): void {
    if (this.writesBound) return;
    this.writesBound = true;
    setPageWriteListener((write, receivedAt) => {
      if (!Number.isInteger(write.attempt) || write.attempt < 0) return;
      const slot = this.writeSlots.get(`${write.requestId}:${write.attempt}`);
      if (!slot || slot.taskId !== write.taskId) return;
      confirmPageWrite({
        taskId: write.taskId,
        requestId: write.requestId,
        attempt: write.attempt,
      }, Math.max(0, receivedAt - slot.dispatchAt));
      if (!this.taskFirstWrite.has(write.taskId)) {
        const started = this.taskStarted.get(write.taskId);
        if (started != null) this.taskFirstWrite.set(write.taskId, Math.max(0, receivedAt - started));
      }
    });
  }

  private queueCheckpoint(taskId: string, batchId: string, id: string): void {
    const key = `${taskId}:${batchId}`;
    const ids = this.checkpointIds.get(key) ?? new Set<string>();
    ids.add(id);
    this.checkpointIds.set(key, ids);
    if (ids.size >= 8) {
      void this.flushCheckpoint(taskId, batchId);
      return;
    }
    if (this.checkpointTimers.has(key)) return;
    this.checkpointTimers.set(key, setTimeout(() => {
      this.checkpointTimers.delete(key);
      void this.flushCheckpoint(taskId, batchId);
    }, 400));
  }

  private async flushCheckpoint(taskId: string, batchId: string): Promise<void> {
    const key = `${taskId}:${batchId}`;
    const timer = this.checkpointTimers.get(key);
    if (timer) clearTimeout(timer);
    this.checkpointTimers.delete(key);
    const ids = this.checkpointIds.get(key);
    this.checkpointIds.delete(key);
    if (!ids || ids.size === 0) return;
    await noteCompletedItems(taskId, batchId, [...ids]);
  }

  private async readStream(
    pending: PendingBatch,
    runtime: RuntimeTask,
    controller: AbortController,
    timing: RelayFetchTiming,
    dispatchStart: number,
    attempt: number,
  ): Promise<{
    accepted: Map<string, string>;
    rejected: Array<{ id: string; reason: string }>;
    terminal: StreamTerminalKind | null;
    rethrow: unknown | null;
  }> {
    const accepted = new Map<string, string>();
    const rejected: Array<{ id: string; reason: string }> = [];
    let terminal: StreamTerminalKind | null = null;
    const { request, relay, tabId, frameId } = pending;
    try {
      for await (const event of relay.streamItems(request.items, request, {
        signal: controller.signal,
        requestId: request.requestId,
        timing,
      })) {
        if (runtime.cancelled || controller.signal.aborted) break;
        if (event.type === 'text-delta') {
          if (timing.firstTextDeltaMs == null) timing.firstTextDeltaMs = Date.now() - dispatchStart;
          continue;
        }
        if (event.type === 'item') {
          if (accepted.has(event.item.id)) continue;
          if (timing.firstItemMs == null) timing.firstItemMs = Date.now() - dispatchStart;
          accepted.set(event.item.id, event.item.text);
          publishStreamItem({
            type: 'stream-item',
            tabId,
            frameId,
            taskId: request.taskId,
            sessionId: request.sessionId,
            generation: request.generation ?? 0,
            batchId: request.batchId,
            requestId: request.requestId,
            attempt,
            item: { id: event.item.id, text: event.item.text },
          });
          this.queueCheckpoint(request.taskId, request.batchId, event.item.id);
          continue;
        }
        if (event.type === 'rejected') rejected.push({ id: event.item.id, reason: event.item.reason });
        if (event.type === 'terminal') terminal = event.kind;
      }
      return { accepted, rejected, terminal, rethrow: null };
    } catch (error) {
      return { accepted, rejected, terminal, rethrow: error };
    }
  }

  private recordAttempt(
    request: TranslationBatchRequest,
    details: {
      attempt: number;
      sourceChars: number;
      queuedMs: number;
      timing?: RelayFetchTiming;
      status: string;
      totalMs: number;
    },
  ): void {
    recordBatchDiagnostic({
      taskId: request.taskId,
      requestId: request.requestId,
      attempt: details.attempt,
      itemCount: request.items.length,
      sourceChars: details.sourceChars,
      queuedMs: details.queuedMs,
      headerMs: details.timing?.headerMs ?? null,
      bodyMs: details.timing?.bodyMs ?? null,
      parseMs: details.timing?.parseMs ?? null,
      firstTextDeltaMs: details.timing?.firstTextDeltaMs ?? null,
      firstItemMs: details.timing?.firstItemMs ?? null,
      firstPageWriteMs: null,
      totalMs: details.totalMs,
      status: sanitizeDiagnosticStatus(details.status),
      requestedServiceTier: details.timing?.requestedServiceTier ?? null,
      reportedServiceTier: details.timing?.reportedServiceTier ?? null,
    });
  }

  async control(taskId: string, sessionId: string, action: TaskControlAction): Promise<boolean> {
    const runtime = this.runtimeTask(taskId);
    const policy = taskControlPolicy(action);
    if (action === 'resume') runtime.cancelled = false;
    if (policy.pause !== null) runtime.paused = policy.pause;
    if (policy.dispatch) await this.dispatch();
    if (policy.abortActive) {
      runtime.cancelled = true;
      for (const controller of runtime.active.values()) controller.abort();
    }
    if (policy.cancelQueued) {
      for (const pending of runtime.queue.splice(0)) {
        const journal = await transitionBatch(taskId, pending.request.batchId, 'cancelled');
        pending.resolve(resultFrom(
          pending.request,
          'cancelled',
          journal,
          journal.batches[pending.request.batchId].attempt,
          itemResults(pending.request, 'cancelled', 'CANCELLED'),
        ));
      }
    }
    // A resume must not race the previous route's aborted requests settling.
    if (action === 'suspend') await Promise.allSettled([...runtime.settling]);
    const journal = await setTaskStatus(taskId, sessionId, action);
    if (action === 'complete') {
      const started = this.taskStarted.get(taskId);
      recordTaskTiming({
        taskId,
        firstPageWriteMs: this.taskFirstWrite.get(taskId) ?? null,
        endedMs: started ? Date.now() - started : null,
        fetchCount: journal?.requestsUsed ?? 0,
      });
    }
    return Boolean(journal);
  }

  async cancelTab(tabId: number, preserveJournals = false): Promise<void> {
    for (const [taskId, runtime] of this.tasks) {
      if (runtime.tabId === tabId) {
        runtime.cancelled = true;
        // Resolve queued callers before releasing the runtime; do not strand page promises.
        for (const queued of runtime.queue.splice(0)) {
          const journal = await transitionBatch(taskId, queued.request.batchId, 'cancelled');
          queued.resolve(resultFrom(queued.request, 'cancelled', journal,
            journal.batches[queued.request.batchId].attempt,
            itemResults(queued.request, 'cancelled', 'CANCELLED')));
        }
        for (const controller of runtime.active.values()) controller.abort();
        await Promise.allSettled([...runtime.settling]);
        this.tasks.delete(taskId);
      }
    }
    if (!preserveJournals) await removeTabTaskJournals(tabId);
  }
}
