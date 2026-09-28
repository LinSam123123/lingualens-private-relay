export interface BatchDiagnostic {
  requestId: string;
  attempt: number;
  itemCount: number;
  sourceChars: number;
  queuedMs: number;
  /** Time from dispatch until fetch headers are available. Not model first-token time. */
  headerMs: number | null;
  bodyMs: number | null;
  parseMs: number | null;
  /** Dispatch to the first translation text delta. Not header time, item time, or page write time. */
  firstTextDeltaMs: number | null;
  /** Dispatch to the first complete JSONL item. Not page write time. */
  firstItemMs: number | null;
  /** Dispatch to the first textContent write for this batch. Not item-parse time. */
  firstPageWriteMs: number | null;
  totalMs: number;
  status: string;
}

export const BATCH_DIAGNOSTICS_BUILD = 'batch-timing-v1';
const MAX_ENTRIES = 40;
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
  entries.push({
    requestId,
    attempt: Number.isFinite(entry.attempt) ? Math.max(0, Math.floor(entry.attempt)) : 0,
    itemCount: Number.isFinite(entry.itemCount) ? Math.max(0, Math.floor(entry.itemCount)) : 0,
    sourceChars: Number.isFinite(entry.sourceChars) ? Math.max(0, Math.floor(entry.sourceChars)) : 0,
    queuedMs: Number.isFinite(entry.queuedMs) ? Math.max(0, Math.round(entry.queuedMs)) : 0,
    headerMs: entry.headerMs == null || !Number.isFinite(entry.headerMs) ? null : Math.max(0, Math.round(entry.headerMs)),
    bodyMs: entry.bodyMs == null || !Number.isFinite(entry.bodyMs) ? null : Math.max(0, Math.round(entry.bodyMs)),
    parseMs: entry.parseMs == null || !Number.isFinite(entry.parseMs) ? null : Math.max(0, Math.round(entry.parseMs)),
    firstTextDeltaMs: entry.firstTextDeltaMs == null || !Number.isFinite(entry.firstTextDeltaMs) ? null : Math.max(0, Math.round(entry.firstTextDeltaMs)),
    firstItemMs: entry.firstItemMs == null || !Number.isFinite(entry.firstItemMs) ? null : Math.max(0, Math.round(entry.firstItemMs)),
    firstPageWriteMs: entry.firstPageWriteMs == null || !Number.isFinite(entry.firstPageWriteMs) ? null : Math.max(0, Math.round(entry.firstPageWriteMs)),
    totalMs: Number.isFinite(entry.totalMs) ? Math.max(0, Math.round(entry.totalMs)) : 0,
    status: sanitizeDiagnosticStatus(entry.status),
  });
  if (entries.length > MAX_ENTRIES) entries.splice(0, entries.length - MAX_ENTRIES);
}

export function listBatchDiagnostics(): BatchDiagnostic[] {
  return entries.map((entry) => ({ ...entry }));
}

export function clearBatchDiagnostics(): void {
  entries.length = 0;
}

export function batchDiagnosticsSnapshot(): {
  enabled: boolean;
  build: string;
  cap: number;
  entries: BatchDiagnostic[];
} {
  return {
    enabled,
    build: BATCH_DIAGNOSTICS_BUILD,
    cap: MAX_ENTRIES,
    entries: listBatchDiagnostics(),
  };
}

export function resetBatchDiagnosticsForTests(): void {
  enabled = false;
  entries.length = 0;
}
