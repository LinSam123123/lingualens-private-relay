import type { ReportedServiceTier } from '../shared/types';
import { sanitizeServiceTier } from '../shared/relay-protocol.ts';

export interface BatchDiagnostic {
  taskId: string;
  requestId: string;
  attempt: number;
  itemCount: number;
  sourceChars: number;
  queuedMs: number | null;
  /** Time from dispatch until fetch headers are available. Not model first-token time. */
  headerMs: number | null;
  bodyMs: number | null;
  parseMs: number | null;
  /** Dispatch to the first translation text delta. Not header time, item time, or page write time. */
  firstTextDeltaMs: number | null;
  /** Dispatch to the first complete JSONL item. Not page write time. */
  firstItemMs: number | null;
  /**
   * Delay until Background receives the page-write acknowledgement.
   * This is not the content script's textContent clock.
   * Null when that acknowledgement was not observed for this attempt.
   */
  firstPageWriteMs: number | null;
  totalMs: number | null;
  status: string;
  requestedServiceTier?: 'priority' | null;
  reportedServiceTier?: ReportedServiceTier | null;
}

export const BATCH_DIAGNOSTICS_BUILD = 'spa-dock-v2';
const MAX_ENTRIES = 40;

export interface TaskTiming {
  taskId: string;
  /** Task start to the first textContent write. Not the first JSONL item. */
  firstPageWriteMs: number | null;
  /** Task start to the complete control. Not a single batch total. */
  endedMs: number | null;
  fetchCount: number;
}

const taskTimings: TaskTiming[] = [];
const pendingWriteAcks = new Map<string, number>();

function diagnosticKey(taskId: string, requestId: string, attempt: number): string {
  return `${taskId}\n${requestId}\n${attempt}`;
}

export function confirmPageWrite(
  identity: { taskId: string; requestId: string; attempt: number },
  elapsedMs: number | null,
): void {
  if (!enabled) return;
  if (elapsedMs == null || !Number.isFinite(elapsedMs)) return;
  const ms = Math.max(0, Math.round(elapsedMs));
  const entry = [...entries].reverse().find((item) => item.taskId === identity.taskId
    && item.requestId === identity.requestId
    && item.attempt === identity.attempt);
  if (entry) {
    if (entry.firstPageWriteMs == null) entry.firstPageWriteMs = ms;
    return;
  }
  const key = diagnosticKey(identity.taskId, identity.requestId, identity.attempt);
  if (!pendingWriteAcks.has(key)) pendingWriteAcks.set(key, ms);
}

export function cacheOnlyDiagnostic(input: {
  taskId: string;
  requestId: string;
  itemCount: number;
  sourceChars: number;
}): BatchDiagnostic {
  return {
    taskId: input.taskId,
    requestId: input.requestId,
    attempt: 0,
    itemCount: input.itemCount,
    sourceChars: input.sourceChars,
    queuedMs: null,
    headerMs: null,
    bodyMs: null,
    parseMs: null,
    firstTextDeltaMs: null,
    firstItemMs: null,
    firstPageWriteMs: null,
    totalMs: null,
    status: 'completed',
  };
}
const REQUEST_ID_PATTERN = /^[a-zA-Z0-9-]{8,128}$/;
const STATUS_PATTERN = /^(completed|failed|cancelled|interrupted\/unknown)(:[A-Z0-9_]{1,48})?$/;

let enabled = false;
const entries: BatchDiagnostic[] = [];

export function setBatchDiagnosticsEnabled(value: boolean): void {
  enabled = value === true;
}

export function isBatchDiagnosticsEnabled(): boolean {
  return enabled;
}

export function sanitizeDiagnosticStatus(raw: string): string {
  const value = raw.trim().slice(0, 64);
  if (STATUS_PATTERN.test(value)) return value;
  return 'failed';
}

export function recordBatchDiagnostic(entry: BatchDiagnostic): void {
  if (!enabled) return;
  const requestId = REQUEST_ID_PATTERN.test(entry.requestId) ? entry.requestId : 'invalid-id';
  const taskId = /^[a-zA-Z0-9-]{8,128}$/.test(entry.taskId) ? entry.taskId : 'invalid-task';
  const attempt = Number.isFinite(entry.attempt) ? Math.max(0, Math.floor(entry.attempt)) : 0;
  const pendingAck = pendingWriteAcks.get(diagnosticKey(taskId, requestId, attempt));
  entries.push({
    taskId,
    requestId,
    attempt,
    itemCount: Number.isFinite(entry.itemCount) ? Math.max(0, Math.floor(entry.itemCount)) : 0,
    sourceChars: Number.isFinite(entry.sourceChars) ? Math.max(0, Math.floor(entry.sourceChars)) : 0,
    queuedMs: entry.queuedMs == null || !Number.isFinite(entry.queuedMs) ? null : Math.max(0, Math.round(entry.queuedMs)),
    headerMs: entry.headerMs == null || !Number.isFinite(entry.headerMs) ? null : Math.max(0, Math.round(entry.headerMs)),
    bodyMs: entry.bodyMs == null || !Number.isFinite(entry.bodyMs) ? null : Math.max(0, Math.round(entry.bodyMs)),
    parseMs: entry.parseMs == null || !Number.isFinite(entry.parseMs) ? null : Math.max(0, Math.round(entry.parseMs)),
    firstTextDeltaMs: entry.firstTextDeltaMs == null || !Number.isFinite(entry.firstTextDeltaMs) ? null : Math.max(0, Math.round(entry.firstTextDeltaMs)),
    firstItemMs: entry.firstItemMs == null || !Number.isFinite(entry.firstItemMs) ? null : Math.max(0, Math.round(entry.firstItemMs)),
    firstPageWriteMs: entry.firstPageWriteMs == null || !Number.isFinite(entry.firstPageWriteMs)
      ? (pendingAck ?? null)
      : Math.max(0, Math.round(entry.firstPageWriteMs)),
    totalMs: entry.totalMs == null || !Number.isFinite(entry.totalMs) ? null : Math.max(0, Math.round(entry.totalMs)),
    status: sanitizeDiagnosticStatus(entry.status),
    requestedServiceTier: entry.requestedServiceTier === 'priority' ? 'priority' : null,
    reportedServiceTier: sanitizeServiceTier(entry.reportedServiceTier),
  });
  if (entries.length > MAX_ENTRIES) entries.splice(0, entries.length - MAX_ENTRIES);
}

export function listBatchDiagnostics(): BatchDiagnostic[] {
  return entries.map((entry) => ({ ...entry }));
}

export function clearBatchDiagnostics(): void {
  entries.length = 0;
  taskTimings.length = 0;
  pendingWriteAcks.clear();
}

export function recordTaskTiming(entry: TaskTiming): void {
  if (!enabled) return;
  if (!/^[a-zA-Z0-9-]{8,128}$/.test(entry.taskId)) return;
  taskTimings.push({
    taskId: entry.taskId,
    firstPageWriteMs: entry.firstPageWriteMs == null || !Number.isFinite(entry.firstPageWriteMs)
      ? null
      : Math.max(0, Math.round(entry.firstPageWriteMs)),
    endedMs: entry.endedMs == null || !Number.isFinite(entry.endedMs) ? null : Math.max(0, Math.round(entry.endedMs)),
    fetchCount: Number.isFinite(entry.fetchCount) ? Math.max(0, Math.floor(entry.fetchCount)) : 0,
  });
  if (taskTimings.length > MAX_ENTRIES) taskTimings.splice(0, taskTimings.length - MAX_ENTRIES);
}

export function listTaskTimings(): TaskTiming[] {
  return taskTimings.map((entry) => ({ ...entry }));
}

export function batchDiagnosticsSnapshot(): {
  enabled: boolean;
  build: string;
  cap: number;
  entries: BatchDiagnostic[];
  tasks: TaskTiming[];
} {
  return {
    enabled,
    build: BATCH_DIAGNOSTICS_BUILD,
    cap: MAX_ENTRIES,
    entries: listBatchDiagnostics(),
    tasks: listTaskTimings(),
  };
}

export function resetBatchDiagnosticsForTests(): void {
  enabled = false;
  entries.length = 0;
  taskTimings.length = 0;
  pendingWriteAcks.clear();
}
