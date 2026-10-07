# Side translation dock

Development update: 2026-10-07. Chrome and Firefox share this implementation.

The page now has a 44px translation button on its right edge before translation
starts. Click once to translate; subsequent clicks open or close the control
panel. Drag vertically to move the button for the current document. Dragging does
not start a translation. Escape closes the panel. The panel wraps controls on
narrow viewports and no longer adds padding to the website's document element.

The panel retains pause, continue, stop, supplement, restore, display mode and
manual retry controls. A badge indicates progress or unfinished errors. Fixed,
localized failure categories distinguish missing translations, invalid output,
rate limits, configuration problems, exhausted budget and unknown outcomes.
Raw provider error bodies are not displayed in this summary.

## Retry corrections

- Reopen result delivery when explicitly retrying failures after stopping.
- Set retrying items to pending and guard against overlapping manual retries.
- Do not send removed nodes or obsolete website revisions again. Their old
  unfinished items are counted as cancelled, not permanently retryable errors.
- Disable retries once the current document budget is exhausted. Existing
  budgets, stable request IDs and the explicit unknown confirmation are retained.
- Successful translations are retained. No automatic fallback or new automatic
  retries were added.

## Verification

- Full Node suite, TypeScript check, Chrome and Firefox production builds and
  both build audits passed.
- New engine regression cases cover retry after stop, pending feedback,
  duplicate clicks, stable IDs, removed/revised nodes and exhausted budgets.
- Actual shared React controls were rendered in a local browser preview with
  simulated progress. Desktop and 375 x 667 layouts, start/open, retry feedback,
  vertical drag without toggling, pause and restore-to-idle were checked.
- This UI preview is not an installed-extension transport test. The user's
  specific failing website has not been reproduced without its URL/error code.
  Real Firefox and mobile browser acceptance remain outstanding.

Reload the development extension and refresh the target page to replace its old
content script. Outputs remain `.output/chrome-mv3` and `.output/firefox-mv2`.
The signed Firefox package, extension identity, credential storage and dependency
versions are unchanged; no real API requests were made for this update.
