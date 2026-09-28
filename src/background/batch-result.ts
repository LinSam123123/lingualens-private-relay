import type {
  BatchItemResult,
  TranslationBatchRequest,
  TranslationBatchResult,
} from '../shared/types';

/**
 * Keep a scheduler's abnormal batch status even when every item completed.
 * A cache-only batch has no scheduler result and may complete normally.
 */
export function combineBatchResult(
  request: Pick<TranslationBatchRequest, 'taskId' | 'batchId' | 'requestId'>,
  rows: Array<{ id: string; cachedText: string | null; scheduled?: BatchItemResult }>,
  scheduled: TranslationBatchResult | null,
): TranslationBatchResult {
  const items: BatchItemResult[] = rows.map((row) => {
    if (row.cachedText != null) {
      return { id: row.id, status: 'completed', translated: row.cachedText };
    }
    return row.scheduled ?? { id: row.id, status: 'failed', error: 'BATCH_RESULT_MISSING' };
  });
  let status: TranslationBatchResult['status'];
  if (!scheduled) {
    status = items.every((item) => item.status === 'completed') ? 'completed' : 'failed';
  } else if (scheduled.status === 'completed' && items.some((item) => item.status !== 'completed')) {
    status = items.some((item) => item.status === 'interrupted/unknown') ? 'interrupted/unknown' : 'failed';
  } else {
    status = scheduled.status;
  }
  return {
    taskId: request.taskId,
    batchId: request.batchId,
    requestId: request.requestId,
    status,
    items,
    attempts: scheduled?.attempts ?? 0,
    requestsUsed: scheduled?.requestsUsed ?? 0,
    charsUsed: scheduled?.charsUsed ?? 0,
  };
}
