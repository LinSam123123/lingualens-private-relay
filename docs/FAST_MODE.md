# Fast mode (Priority)

Fast mode is opt-in and defaults to off for both Chrome and Firefox. Existing
settings without `fastMode` stay off. It does not change concurrency, streaming,
timeouts, retry policy, or the page fetch/character budget.

In Settings, select **Fast mode (Priority)** under Model and diagnostics, then
**Save and authorize host**. New translation requests use the saved value.
Already queued/dispatched requests keep their captured configuration; cancel
and start a new task for a clean comparison. Toggling the saved mode clears the
session translation cache so old hits do not masquerade as Priority requests.

Enabled requests include `"service_tier":"priority"` in the JSON body for both
Chat Completions and Responses, with or without streaming. Page translation,
selection, Popup, Sidepanel, and connection tests use the same adapter. `/models`
does not send a service tier. Connection tests are outside the page budget but
can still be charged by the relay, including Priority pricing.

The relay must accept and honor this field for the selected model/account.
This setting neither guarantees acceleration nor defines a 1.5x/2x billing
multiplier. A relay can ignore it or serve another tier. Model lists do not
establish support, and the extension does not guess support from model names.

Connection tests and opt-in batch timings show the requested tier separately
from the server-reported tier. Only recognized API metadata is recorded, not
model text. Missing metadata means **Not reported**, not Priority confirmed.
For SSE, metadata may appear on a chunk or in a Responses event's `response`.
The parser still stops on the existing terminal event; it never waits for extra
metadata after completion. Check the relay's usage log for actual routing and
billing. Even reported Priority is not a performance measurement.

Explicit HTTP 400/403/422 rejections mentioning `service_tier` or Priority
processing are mapped to `FAST_MODE_REJECTED`. No automatic removal of the field,
standard-mode fallback, stream fallback, or extra request follows that error.
Other HTTP, ambiguous network, timeout, and cancellation cases keep the existing
retry/unknown rules. Turn the mode off and save before a manual retry if needed;
that retry consumes its normal page budget. Allowed 429/502/503 retries retain
the captured Priority setting and stable request ID.

Automated verification uses fake keys and Mock responses. It proves request
wiring and failure behavior, not relay speed or pricing. Development builds do
not modify the daily signed Firefox extension or its credential DB.

Mock browser checks: run `npm run mock-relay`, save model `mock-model` and a fake
key with Base URL `http://127.0.0.1:17891/ok/v1`. A Priority connection test should
show requested and reported `priority`. Both protocols and SSE report this mock
metadata. `http://127.0.0.1:17891/priority-rejected/v1` returns HTTP 422 when the
flag is enabled and does not cause an automatic standard-mode request.

## Real relay smoke test (2026-10-04)

With the user's explicit authorization, an independent in-app browser test page
drove the actual shared `RelayAdapter` through a loopback Node test bridge. The
temporary key existed only in the test process memory, never in browser settings,
source files, build assets, or this report. The test server and kernel were closed
after testing. No daily browser profile or signed extension was changed.

Four requests used `gpt-5.6-luna`, one public sentence per request, one attempt
each, `service_tier: "priority"`, a random request ID, redirects disabled, and a
25-second timeout. There was no automatic retry or downgrade.

| Protocol | Transport | Translation | Server-reported tier | Elapsed ms |
| --- | --- | --- | --- | --- |
| Chat Completions | JSON | Completed | default | 2205 |
| Chat Completions | SSE | Completed | default | 2131 |
| Responses | JSON | Completed | default | 2154 |
| Responses | SSE | Completed | default | 2403 |

These replies **do not confirm Priority processing** for that model/relay/account
combination. This single-sentence smoke test is not a latency benchmark or a
billing audit. The relay usage log must be checked for actual routing and pricing.

Installed-extension Chrome/Firefox settings UI, host permission, Port, and page
DOM behavior have not been accepted for this change. The Chrome connector blocked
access to internal extension management pages. The independent page's HTTP/API
calls ran in the Node bridge, not an installed extension's Background. Capturing
a test-page screenshot also failed; results were read from its visible DOM.
