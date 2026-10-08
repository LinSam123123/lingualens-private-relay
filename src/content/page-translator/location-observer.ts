/** Observe committed URLs without patching the site's history methods or requesting tabs permission. */
export function observePageLocation(
  onChange: () => void,
  target: Window & { navigation?: EventTarget } = window,
): () => void {
  let previous = target.location.href;
  let stopped = false;
  const check = () => {
    if (stopped) return;
    const current = target.location.href;
    if (current === previous) return;
    previous = current;
    onChange();
  };
  target.addEventListener('popstate', check, true);
  target.addEventListener('hashchange', check, true);
  target.addEventListener('pageshow', check, true);
  target.navigation?.addEventListener('currententrychange', check);
  // Firefox/older Chromium fallback. Also covers history changes with no DOM mutations.
  const timer = target.setInterval(check, 250);
  return () => {
    stopped = true;
    target.clearInterval(timer);
    target.removeEventListener('popstate', check, true);
    target.removeEventListener('hashchange', check, true);
    target.removeEventListener('pageshow', check, true);
    target.navigation?.removeEventListener('currententrychange', check);
  };
}
