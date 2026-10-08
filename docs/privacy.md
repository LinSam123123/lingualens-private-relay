# LinguaLens Private Relay Edition: Privacy Notes

**Last updated:** October 8, 2026

This private build has no account system, telemetry, analytics, or project-operated translation server.

## Network data

Text translated from selections, the popup, sidepanel, or an explicitly started page snapshot is sent only to the Relay Base URL configured by the user. The API key is sent as a Bearer credential when configured. Translation batches also include a random `X-Translation-Request-Id` containing no page text or account data.

After starting page translation, eligible new or changed near-viewport text can also be transmitted automatically. Translation can continue after same-origin navigation in the same tab. Stop automatic translation or restore the page to disable that tab's continuation; crossing origins clears continuation. This is not a permanent website rule. Use care on private account pages: visible text may contain personal information even though the extension does not collect telemetry.

Streaming changes result delivery, not the destination or privacy boundary. Optional Priority mode adds a service-tier field and can change billing under the Relay operator's rules. It is not a guarantee of faster execution.

The extension does not contact legacy LinguaLens providers at runtime. Model refresh and connection tests contact the same configured Relay and are rate-limited to one active request of each type.

## Local data

| Data | Storage | Retention |
|---|---|---|
| Public Relay settings and UI preferences | `storage.local` | Until cleared or uninstalled |
| API key, default mode | `storage.session` | Current browser session only |
| API key, optional persistent mode (Chrome/Edge) | protected `storage.local` | Until cleared or uninstalled |
| API key, optional persistent mode (Firefox) | extension-origin IndexedDB (`moz-extension://`) | Until cleared, uninstalled, or a temporary add-on is unloaded |
| Translation cache and sidepanel history | `storage.session` | Current browser session only |
| Task journal | `storage.session` | Same-session SW recovery, with stale-entry cleanup |
| Tab continuation (origin, language, display mode and identifiers; no source text) | `storage.session` | Until stopped, tab closed, origin changed or session state cleared |

Content scripts in this project do not read or observe extension storage. Chrome storage access restrictions protect credentials in local/session storage. Firefox refuses unprotected `storage.local` for keys and instead uses session storage or background-managed IndexedDB owned by the extension origin; content-script IndexedDB belongs to the page origin. Settings pages receive only public configuration and a masked Secret status; `GET_SECRET_STATUS` is options-only and never returns the raw key. This isolation is not a password manager and does not resist local malware, a copied profile, or a compromised extension. Temporary Firefox installs must not be relied on for persistent credentials after removal or browser exit.

Task journals contain IDs, status, attempts, character/request budgets, and timestamps. They do not contain webpage source text. `storage.session` recovery does not survive every browser exit, extension reload, update, disable, or page reload.

## Permissions

The extension declares broad optional HTTPS/loopback patterns only so the browser can present a user-triggered permission request. The settings page requests a host match pattern generated from the validated Relay URL when **Save and authorize host** is clicked, then removes the obsolete pattern after a successful change. Chrome patterns include a non-default port. Firefox match patterns cannot include a port, so the granted Firefox permission covers every port on that hostname; fetch still uses only the saved, validated Base URL. The extension does not grant all hosts to work around this.

Declarative content scripts run on matching web pages for the floating control, selection and page translation, including incremental observation after activation. This page access is separate from the optional Relay host permission. Chrome uses `storage`, `activeTab`, `sidePanel`, `contextMenus`, and `scripting`. Firefox uses `storage`, `activeTab`, and `contextMenus`, with its native sidebar declaration. Page text is not transmitted for translation until translation is started manually or continued by the same-tab rule.

Firefox's `data_collection_permissions` declares `websiteContent` because translating a page or selection transmits visible website text to the user-configured Relay. Mozilla defines data transmission as any data handled outside the add-on or local browser. `"none"` would only be correct if the extension collected or transmitted no data; the absence of telemetry does not satisfy that definition. This private build is not an AMO listing, but the declaration is kept honest for Firefox 140+ permission UI.

## Deletion

Use the settings page to clear the API key and cache. Sidepanel history is session-only. Uninstalling the extension removes its browser-managed local data. Relay operators may retain requests under their own policy; consult the operator of the Relay you configure.
