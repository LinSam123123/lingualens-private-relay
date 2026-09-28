import type { TranslateProgress } from './engine';

/** Item progress only. Abnormal batches are not added to unknown or the total. */
export function statusBarFlags(progress: TranslateProgress): {
  percent: number;
  showBatchAnomaly: boolean;
  anomalyCount: number;
  overTotal: boolean;
} {
  const settled = progress.done + progress.errors + progress.unknown + progress.cancelled;
  const allItemsReceived = progress.total > 0
    && progress.done === progress.total
    && progress.unknown === 0
    && progress.errors === 0
    && progress.cancelled === 0;
  return {
    percent: progress.total > 0 ? Math.round((settled / progress.total) * 100) : 0,
    showBatchAnomaly: allItemsReceived && progress.abnormalBatches > 0,
    anomalyCount: progress.abnormalBatches,
    overTotal: settled > progress.total,
  };
}
