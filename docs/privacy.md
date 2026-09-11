# LinguaLens Private Relay Edition: Privacy Notes

**Last updated:** July 23, 2026

This private build has no account system, telemetry, analytics, or project-operated translation server.

## Network data

Text translated from selections, the popup, sidepanel, or an explicitly started page snapshot is sent only to the Relay Base URL configured by the user. The API key is sent as a Bearer credential when configured. Translation batches also include a random `X-Translation-Request-Id` containing no page text or account data.

The extension does not contact legacy LinguaLens providers at runtime. Model refresh and connection tests contact the same configured Relay and are rate-limited to one active request of each type.

## Local data

| Data | Storage | Retention |
|---|---|---|
| Public Relay settings and UI preferences | `storage.local` | Until cleared or uninstalled |
| API key, default mode | `storage.session` | Current browser session only |
| API key, optional persistent mode | protected `storage.local` | Until cleared or uninstalled |
| Translation cache and sidepanel history | `storage.session` | Current browser session only |
| Task journal | `storage.session` | Same-session SW recovery, with stale-entry cleanup |

Content scripts cannot read or observe extension storage. Settings pages receive only public configuration and a masked Secret status. Firefox does not implement `storage.local.setAccessLevel`; this build therefore refuses protected local key storage there instead of writing the key into content-script-readable `storage.local`. Session keys remain available because Firefox `storage.session` is trusted-context-only by default.

Task journals contain IDs, status, attempts, character/request budgets, and timestamps. They do not contain webpage source text. `storage.session` recovery does not survive every browser exit, extension reload, update, disable, or page reload.

## Permissions

The extension declares broad optional HTTPS/loopback patterns only so the browser can present a user-triggered permission request. The settings page requests a host match pattern generated from the validated Relay URL when **Save and authorize host** is clicked, then removes the obsolete pattern after a successful change. Chrome patterns include a non-default port. Firefox match patterns cannot include a port, so the granted Firefox permission covers every port on that hostname; fetch still uses only the saved, validated Base URL. The extension does not grant all hosts to work around this.

Content-script access is used for selection and page-snapshot translation. `storage`, `activeTab`, `sidePanel`, `contextMenus`, and `scripting` support the corresponding extension features.

Firefox's `data_collection_permissions` declares `websiteContent` because translating a page or selection transmits visible website text to the user-configured Relay. Mozilla defines data transmission as any data handled outside the add-on or local browser. `"none"` would only be correct if the extension collected or transmitted no data; the absence of telemetry does not satisfy that definition. This private build is not an AMO listing, but the declaration is kept honest for Firefox 140+ permission UI.

## Deletion

Use the settings page to clear the API key and cache. Sidepanel history is session-only. Uninstalling the extension removes its browser-managed local data. Relay operators may retain requests under their own policy; consult the operator of the Relay you configure.
