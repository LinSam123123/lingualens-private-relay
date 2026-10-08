import { useTranslation } from 'react-i18next';
import { useEffect, useRef, useState } from 'react';
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
  onStart: () => void;
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
  onStart,
}: Props) {
  const { t } = useTranslation();
  const [top, setTop] = useState(() => Math.max(8, window.innerHeight * 0.6));
  const drag = useRef<{ start: number; top: number; moved: boolean } | null>(null);
  const suppressClick = useRef(false);
  const dock = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const resize = () => setTop((value) => Math.max(8, Math.min(value, window.innerHeight - 64)));
    window.addEventListener('resize', resize);
    return () => window.removeEventListener('resize', resize);
  }, []);
  useEffect(() => {
    if (collapsed || !progress) return;
    const close = (event: KeyboardEvent) => {
      if (event.key === 'Escape') { onToggleCollapse(); dock.current?.querySelector('button')?.focus(); }
    };
    window.addEventListener('keydown', close);
    return () => window.removeEventListener('keydown', close);
  }, [collapsed, progress, onToggleCollapse]);

  const flags = statusBarFlags(progress ?? { total: 0, pending: 0, done: 0, errors: 0, unknown: 0, cancelled: 0, abnormalBatches: 0 });
  const terminal = progress ? progress.done + progress.errors + progress.unknown + progress.cancelled : 0;
  const percent = flags.percent;
  const preparing = running && progress?.total === 0;
  const finished = !running && terminal > 0;
  const label = t(progress ? 'statusBar.expand' : 'popup.translatePage');
  return (
    <div ref={dock} className="st-page-dock" style={{ top }} data-lingualens-ui="true">
      <button
        type="button"
        onPointerDown={(event) => {
          if (event.button !== 0) return;
          suppressClick.current = false;
          drag.current = { start: event.clientY, top, moved: false };
          event.currentTarget.setPointerCapture(event.pointerId);
        }}
        onPointerMove={(event) => {
          const current = drag.current;
          if (!current) return;
          const delta = event.clientY - current.start;
          if (Math.abs(delta) > 6) current.moved = true;
          if (current.moved) setTop(Math.max(8, Math.min(current.top + delta, window.innerHeight - 64)));
        }}
        onPointerUp={() => { suppressClick.current = drag.current?.moved ?? false; drag.current = null; }}
        onPointerCancel={() => { suppressClick.current = true; drag.current = null; }}
        onClick={(event) => {
          if (suppressClick.current && event.detail > 0) { suppressClick.current = false; return; }
          if (progress) onToggleCollapse();
          else onStart();
        }}
        className="st-status-collapsed"
        title={label}
        aria-label={label}
        aria-expanded={Boolean(progress && !collapsed)}
        aria-controls={progress ? 'st-page-controls' : undefined}
      >
        <span className="st-status-collapsed-mark"><AppLogo className="st-status-collapsed-icon" /></span>
        {progress && <span className={`st-status-collapsed-badge${progress.errors || progress.unknown ? ' st-dock-error' : ''}`}>
          {progress.errors || progress.unknown ? '!' : paused ? 'Ⅱ' : running ? (preparing ? '...' : `${percent}%`) : `${percent}%`}
        </span>}
      </button>
    {progress && !collapsed && <div id="st-page-controls" className="st-status-bar" role="region" aria-label={t('statusBar.expand')}
      style={top > window.innerHeight / 2
        ? { bottom: 0, maxHeight: `${top + 36}px` }
        : { top: 0, maxHeight: `calc(100dvh - ${top + 8}px)` }}>
      <div className="st-status-left">
        <AppLogo className="st-status-icon" />
        <span className="st-status-text" title={t('statusBar.progressHint')}>
          {progress.budgetExhausted ? t('statusBar.budgetExhausted') : progress.navigationWaiting ? t('statusBar.navigationWaiting') : progress.channelDisconnected ? t('statusBar.channelDisconnected') : paused ? t('statusBar.paused') : listening && !running ? t('statusBar.listening', { done: progress.done, total: progress.total }) : preparing
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
      {(progress.failures?.length ?? 0) > 0 && <div className="st-failure-summary" role="status">
        {progress.failures?.map(({ kind, count }) => <p key={kind}>{t(`statusBar.failure.${kind}`, { count })}</p>)}
      </div>}

      <div className="st-status-actions">
        {(running || listening) && !paused && <button onClick={onPause} className="st-status-btn">{t('statusBar.pause')}</button>}
        {(running || listening) && paused && <button onClick={onResume} className="st-status-btn">{t('statusBar.resume')}</button>}
        {(running || listening) && <button onClick={onCancel} className="st-status-btn st-status-btn-warn">{t(listening ? 'statusBar.stopAuto' : 'statusBar.cancel')}</button>}
        {listening && !running && !paused && !progress.budgetExhausted && <button onClick={onSupplement} className="st-status-btn">{t('statusBar.supplement')}</button>}
        {finished && progress.errors > 0 && <button disabled={progress.budgetExhausted} onClick={onRetryFailed} className="st-status-btn">{t('statusBar.retryFailed')}</button>}
        {finished && progress.unknown > 0 && <button disabled={progress.budgetExhausted} onClick={onRetryUnknown} className="st-status-btn st-status-btn-unknown">{t('statusBar.retryUnknown')}</button>}
        {finished && progress.done > 0 && <button onClick={onToggleMode} className="st-status-btn" title={t('statusBar.switchMode')}>{displayMode === 'bilingual' ? t('statusBar.replace') : t('statusBar.bilingual')}</button>}
        {(running || finished || listening) && <button onClick={onRestore} className="st-status-btn">{t('statusBar.restore')}</button>}
        <button onClick={onToggleCollapse} className="st-status-btn-icon" title={t('statusBar.minimize')} aria-label={t('statusBar.minimize')}>-</button>
      </div>
    </div>}
    </div>
  );
}
