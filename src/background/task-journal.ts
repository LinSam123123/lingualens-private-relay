import type { BatchStatus, TaskControlAction, TranslationBatchRequest } from '../shared/types';

const STORAGE_KEY = 'relayTaskJournal';
const JOURNAL_TTL_MS = 6 * 60 * 60 * 1000;

export interface BatchJournalEntry {
  batchId: string;
  requestId: string;
  itemIds: string[];
  status: BatchStatus;
  attempt: number;
  chars: number;
  updatedAt: number;
}

export interface TaskJournalEntry {
  taskId: string;
  sessionId: string;
  tabId: number;
  status: TaskControlAction | 'running';
  requestsUsed: number;
  charsUsed: number;
  batches: Record<string, BatchJournalEntry>;
  updatedAt: number;
}

type Journal = Record<string, TaskJournalEntry>;
let journalQueue: Promise<void> = Promise.resolve();

async function readJournal(): Promise<Journal> {
  const result = await browser.storage.session.get(STORAGE_KEY);
  return result[STORAGE_KEY] && typeof result[STORAGE_KEY] === 'object'
    ? result[STORAGE_KEY] as Journal
    : {};
}

async function writeJournal(journal: Journal): Promise<void> {
  await browser.storage.session.set({ [STORAGE_KEY]: journal });
}

function mutateJournal<T>(mutation: (journal: Journal) => T | Promise<T>): Promise<T> {
  const operation = journalQueue.then(async () => {
    const journal = await readJournal();
    const result = await mutation(journal);
    await writeJournal(journal);
    return result;
  });
  journalQueue = operation.then(() => undefined, () => undefined);
  return operation;
}

export async function initializeTaskJournal(now = Date.now()): Promise<void> {
  await mutateJournal((journal) => {
    for (const [taskId, task] of Object.entries(journal)) {
      if (now - task.updatedAt > JOURNAL_TTL_MS) {
        delete journal[taskId];
        continue;
      }
      for (const batch of Object.values(task.batches)) {
        if (batch.status === 'dispatched') {
          batch.status = 'interrupted/unknown';
          batch.updatedAt = now;
        }
      }
    }
  });
}

export async function ensureTask(
  request: TranslationBatchRequest,
  tabId: number,
): Promise<TaskJournalEntry> {
  return mutateJournal((journal) => {
    const existing = journal[request.taskId];
    if (existing && existing.sessionId !== request.sessionId) throw new Error('TASK_SESSION_MISMATCH');
    if (existing && existing.tabId !== tabId) throw new Error('TASK_TAB_MISMATCH');
    const now = Date.now();
    const task = existing ?? {
      taskId: request.taskId,
      sessionId: request.sessionId,
      tabId,
      status: 'running' as const,
      requestsUsed: 0,
      charsUsed: 0,
      batches: {},
      updatedAt: now,
    };
    task.batches[request.batchId] ??= {
      batchId: request.batchId,
      requestId: request.requestId,
      itemIds: request.items.map((item) => item.id),
      status: 'queued',
      attempt: 0,
      chars: request.items.reduce((sum, item) => sum + item.text.length, 0),
      updatedAt: now,
    };
    task.updatedAt = now;
    journal[request.taskId] = task;
    return structuredClone(task);
  });
}

export async function transitionBatch(
  taskId: string,
  batchId: string,
  status: BatchStatus,
  changes: Partial<Pick<TaskJournalEntry, 'requestsUsed' | 'charsUsed'>> & { attempt?: number } = {},
): Promise<TaskJournalEntry> {
  return mutateJournal((journal) => {
    const task = journal[taskId];
    const batch = task?.batches[batchId];
    if (!task || !batch) throw new Error('TASK_NOT_FOUND');
    const now = Date.now();
    batch.status = status;
    if (changes.attempt !== undefined) batch.attempt = changes.attempt;
    if (changes.requestsUsed !== undefined) task.requestsUsed = changes.requestsUsed;
    if (changes.charsUsed !== undefined) task.charsUsed = changes.charsUsed;
    batch.updatedAt = now;
    task.updatedAt = now;
    return structuredClone(task);
  });
}

export async function setTaskStatus(
  taskId: string,
  sessionId: string,
  status: TaskControlAction | 'running',
): Promise<TaskJournalEntry | null> {
  return mutateJournal((journal) => {
    const task = journal[taskId];
    if (!task || task.sessionId !== sessionId) return null;
    task.status = status;
    task.updatedAt = Date.now();
    return structuredClone(task);
  });
}

export async function getTaskJournal(taskId: string, sessionId: string): Promise<TaskJournalEntry | null> {
  await journalQueue;
  const task = (await readJournal())[taskId];
  return task?.sessionId === sessionId ? structuredClone(task) : null;
}

export async function removeTaskJournal(taskId: string): Promise<void> {
  await mutateJournal((journal) => {
    delete journal[taskId];
  });
}

export async function removeTabTaskJournals(tabId: number): Promise<void> {
  await mutateJournal((journal) => {
    for (const [taskId, task] of Object.entries(journal)) {
      if (task.tabId === tabId) delete journal[taskId];
    }
  });
}
