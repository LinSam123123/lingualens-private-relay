# Cache, channel and untranslated controls

Investigation: 2026-10-07.

## Browser evidence

Read the user's existing Chrome tab without clearing cache or starting another
translation. Its translation panel showed 62/68 completed and six unknown items,
with a disconnected-channel warning. The unmodified Overview label was confirmed
to be a `BUTTON` with `role="tab"`. The extractor previously skipped every BUTTON.
This explains untranslated navigation labels independently of cache behavior.

Page console output did not establish the background failure's cause. No claim is
made that this user's interruption was a cache quota error. No Key, browser
storage, or account configuration was read, and no new paid API request was made.

## Corrections

- Extract visible button text nodes; retain the actual button, its attributes and
  event handlers. Inputs, editable fields, hidden areas and extension UI remain
  excluded.
- Bound the optional session translation cache by a conservative 1 MiB serialized
  estimate as well as 1,000 entries. Trim old snapshots before initializing task
  journals. If a cache write hits quota, remove only its optional snapshot and
  retain the memory cache; credentials and task journals are not deleted.
- Share concurrent cache loads and serialize snapshot writes/clears. A generation
  captured before translation prevents late results from repopulating cleared
  cache, including after settings invalidation.
- Treat a Port postMessage failure as a delivery failure. It cannot override
  successful translations, trigger recovery resends, or throw out of DOM flush.
- Give fixed localized hints for timeout, unavailable background, navigation
  mismatch and storage quota. Arbitrary provider error bodies are not displayed.

Unknown requests still require explicit manual retry. No automatic reconnect,
resend, downgrade, budget reset, dependency upgrade, credential migration or
signed Firefox update was added.

## Validation

Node regression tests cover load/clear/write races, late translation results,
cache size and quota behavior, Port disconnect races, and translating/restoring
button labels without including input/editable text. The full suite, TypeScript,
Chrome/Firefox production builds and both artifact audits passed.

The installed Chrome extension has not been reloaded or re-tested on the user's
account page. Reload the development extension and then refresh the page to use
the new content script. Firefox installed-browser acceptance remains outstanding.
