import { useTranslation } from 'react-i18next';
import { type DisplayMode, type TranslateProgress } from './engine';
import { statusBarFlags } from './status-bar-state';
import { AppLogo } from '../../shared/AppLogo';

interface Props {
  progress: TranslateProgress | null;
  running: boolean;
  listening?: boolean;
  paused: boolean;
  displayMode: DisplayMode;
  collapsed: boolean;
  onPause: () => void;
  onResume: () => void;
  onCancel: () => void;
  onRestore: () => void;
  onRetryFailed: () => void;
  onRetryUnknown: () => void;
  onToggleMode: () => void;
  onToggleCollapse: () => void;
  onSupplement?: () => void;
}

export function StatusBar({
  progress,
  running,
  listening = false,
  paused,
  displayMode,
  collapsed,
  onPause,
  onResume,
  onCancel,
  onRestore,
  onRetryFailed,
  onRetryUnknown,
  onToggleMode,
  onToggleCollapse,
  onSupplement,
}: Props) {
  const { t } = useTranslation();
  if (!progress) return null;

  const flags = statusBarFlags(progress);
  const terminal = progress.done + progress.errors + progress.unknown + progress.cancelled;
  const percent = flags.percent;
  const preparing = running && progress.total === 0;
  const finished = !running && terminal > 0;

  if (collapsed) {
    return (
      <button onClick={onToggleCollapse} className="st-status-collapsed" title={t('statusBar.expand')}>
        <span className="st-status-collapsed-mark"><AppLogo className="st-status-collapsed-icon" /></span>
        {running && <span className="st-status-collapsed-badge">{preparing ? '...' : `${percent}%`}</span>}
      </button>
    );
  }

  return (
    <div className="st-status-bar">
      <div className="st-status-left">
        <AppLogo className="st-status-icon" />
        <span className="st-status-text" title={t('statusBar.progressHint')}>
          {progress.budgetExhausted ? t('statusBar.budgetExhausted') : progress.channelDisconnected ? t('statusBar.channelDisconnected') : paused ? t('statusBar.paused') : listening && !running ? t('statusBar.listening', { done: progress.done, total: progress.total }) : preparing
            ? t('statusBar.preparing')
            : t(running ? 'statusBar.translatingProgress' : 'statusBar.translatedProgress', {
              done: progress.done,
              total: progress.total,
              percent,
            })}
          {(paused || progress.budgetExhausted || progress.channelDisconnected) && <span> {progress.done}/{progress.total}</span>}
          {progress.errors > 0 && <span className="st-status-err"> {t('statusBar.errors', { count: progress.errors })}</span>}
          {progress.unknown > 0 && <span className="st-status-unknown"> {t('statusBar.unknown', { count: progress.unknown })}</span>}
          {flags.showBatchAnomaly && <span className="st-status-unknown"> {t('statusBar.batchAnomaly', { count: flags.anomalyCount })}</span>}
          {progress.cancelled > 0 && <span className="st-status-muted"> {t('statusBar.cancelledCount', { count: progress.cancelled })}</span>}
        </span>
      </div>

      {running && !preparing && <div className="st-status-progress"><div className="st-status-progress-fill" style={{ width: `${percent}%` }} /></div>}

      <div className="st-status-actions">
        {(running || listening) && !paused && <button onClick={onPause} className="st-status-btn">{t('statusBar.pause')}</button>}
        {(running || listening) && paused && <button onClick={onResume} className="st-status-btn">{t('statusBar.resume')}</button>}
        {(running || listening) && <button onClick={onCancel} className="st-status-btn st-status-btn-warn">{t(listening ? 'statusBar.stopAuto' : 'statusBar.cancel')}</button>}
        {listening && !running && !paused && !progress.budgetExhausted && <button onClick={onSupplement} className="st-status-btn">{t('statusBar.supplement')}</button>}
        {finished && progress.errors > 0 && <button onClick={onRetryFailed} className="st-status-btn">{t('statusBar.retryFailed')}</button>}
        {finished && progress.unknown > 0 && <button onClick={onRetryUnknown} className="st-status-btn st-status-btn-unknown">{t('statusBar.retryUnknown')}</button>}
        {finished && progress.done > 0 && <button onClick={onToggleMode} className="st-status-btn" title={t('statusBar.switchMode')}>{displayMode === 'bilingual' ? t('statusBar.replace') : t('statusBar.bilingual')}</button>}
        {(running || finished || listening) && <button onClick={onRestore} className="st-status-btn">{t('statusBar.restore')}</button>}
        <button onClick={onToggleCollapse} className="st-status-btn-icon" title={t('statusBar.minimize')} aria-label={t('statusBar.minimize')}>-</button>
      </div>
    </div>
  );
}
