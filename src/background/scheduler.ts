import type {
  BatchItemResult,
  BatchStatus,
  ProviderConfig,
  TaskControlAction,
  TranslationBatchRequest,
  TranslationBatchResult,
} from '../shared/types';
import { RelayAdapter, RelayHttpError } from '../providers/relay';
import {
  canConsumeBudget,
  classifyRetry,
  priorBatchDecision,
  retryDelayMs,
  taskControlPolicy,
} from './scheduler-policy';
import {
  ensureTask,
  getTaskJournal,
  removeTabTaskJournals,
  setTaskStatus,
  transitionBatch,
  type TaskJournalEntry,
} from './task-journal';
import {
  recordBatchDiagnostic,
  sanitizeDiagnosticStatus,
} from './batch-diagnostics';
import type { RelayFetchTiming } from '../providers/relay';

interface PendingBatch {
  request: TranslationBatchRequest;
  tabId: number;
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

  private runtimeTask(taskId: string): RuntimeTask {
    let task = this.tasks.get(taskId);
    if (!task) {
      task = { paused: false, cancelled: false, queue: [], active: new Map() };
      this.tasks.set(taskId, task);
    }
    return task;
  }

  async submit(
    request: TranslationBatchRequest,
    tabId: number,
    relay: RelayAdapter,
    config: ProviderConfig,
  ): Promise<TranslationBatchResult> {
    this.validateRequest(request, config);
    this.maxConcurrency = Math.min(4, Math.max(1, config.maxConcurrency ?? 2));
    const journal = await ensureTask(request, tabId);
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
      const runtime = this.runtimeTask(request.taskId);
      runtime.tabId = tabId;
      runtime.queue.push({ request, tabId, relay, config, resolve, enqueuedAt: Date.now() });
      void this.dispatch();
    });
  }

  private validateRequest(request: TranslationBatchRequest, config: ProviderConfig): void {
    if (!request.taskId || request.taskId.length > 128) throw new Error('TASK_ID_INVALID');
    if (!request.sessionId || request.sessionId.length > 128) throw new Error('SESSION_ID_INVALID');
    if (!request.batchId || request.batchId.length > 128) throw new Error('BATCH_ID_INVALID');
    if (!/^[a-zA-Z0-9-]{8,128}$/.test(request.requestId)) throw new Error('REQUEST_ID_INVALID');
    if (!Array.isArray(request.items) || request.items.length === 0) throw new Error('BATCH_EMPTY');
    const ids = new Set<string>();
    let chars = 0;
    for (const item of request.items) {
      if (!item.id || item.id.length > 128 || ids.has(item.id)) throw new Error('ITEM_ID_INVALID');
      if (!item.text || item.text.length > (config.maxCharsPerRequest ?? 8_000)) throw new Error('ITEM_TEXT_INVALID');
      ids.add(item.id);
      chars += item.text.length;
    }
    if (chars > (config.maxCharsPerRequest ?? 8_000)) throw new Error('BATCH_CHAR_LIMIT');
  }

  private async dispatch(): Promise<void> {
    while (this.running < this.maxConcurrency) {
      const entry = [...this.tasks.values()].find(
        (task) => !task.paused && !task.cancelled && task.queue.length > 0,
      );
      if (!entry) return;
      const pending = entry.queue.shift()!;
      this.running++;
      void this.execute(pending, entry)
        .then(pending.resolve)
        .finally(() => {
          this.running--;
          void this.dispatch();
        });
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

      const current = await getTaskJournal(request.taskId, request.sessionId);
      if (!current) throw new Error('TASK_NOT_FOUND');
      if (!canConsumeBudget(
        current,
        { requests: 1, chars },
        { maxRequests: config.maxPageRequests ?? 100, maxChars: config.maxPageChars ?? 100_000 },
      )) {
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

      const nextRequests = current.requestsUsed + 1;
      const nextChars = current.charsUsed + chars;
      const journal = await transitionBatch(request.taskId, request.batchId, 'dispatched', {
        requestsUsed: nextRequests,
        charsUsed: nextChars,
        attempt: attempt + 1,
      });
      attempt++;

      const controller = new AbortController();
      runtime.active.set(request.batchId, controller);
      let timedOut = false;
      const timeout = setTimeout(() => {
        timedOut = true;
        controller.abort();
      }, config.timeoutMs ?? 25_000);
      const dispatchStart = Date.now();
      const timing: RelayFetchTiming = { headerMs: null, bodyMs: null, parseMs: null };

      try {
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
      requestId: request.requestId,
      attempt: details.attempt,
      itemCount: request.items.length,
      sourceChars: details.sourceChars,
      queuedMs: details.queuedMs,
      headerMs: details.timing?.headerMs ?? null,
      bodyMs: details.timing?.bodyMs ?? null,
      parseMs: details.timing?.parseMs ?? null,
      totalMs: details.totalMs,
      status: sanitizeDiagnosticStatus(details.status),
    });
  }

  async control(taskId: string, sessionId: string, action: TaskControlAction): Promise<boolean> {
    const runtime = this.runtimeTask(taskId);
    const policy = taskControlPolicy(action);
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
    const journal = await setTaskStatus(taskId, sessionId, action);
    return Boolean(journal);
  }

  async cancelTab(tabId: number): Promise<void> {
    for (const [taskId, runtime] of this.tasks) {
      if (runtime.tabId === tabId) {
        runtime.cancelled = true;
        for (const controller of runtime.active.values()) controller.abort();
        this.tasks.delete(taskId);
      }
    }
    await removeTabTaskJournals(tabId);
  }
}
