# LinguaLens Private Relay Edition

A personal Relay edition of [q-jade/lingualens](https://github.com/q-jade/lingualens), based on upstream commit `c18d1a5`, with Chrome/Edge MV3 and Firefox MV2 development builds. The change history is retained but author/committer identities, attribution trailers and private home paths have been anonymized for publication, so local commit hashes differ from the original history. The upstream MIT license and copyright notice are unchanged. This is an independent fork, not an official upstream release or a hosted translation service.

**Build and test:** use Node.js 24 and npm 10+ with the committed lockfile. **AMO reviewers:** follow [BUILD.md](BUILD.md) from the exact source revision supplied with the add-on, not the latest development branch.

This edition has one translation backend: a user-configured private Relay exposing an OpenAI-compatible Chat Completions or Responses API. Legacy provider source files remain temporarily for upstream compatibility, but they are unreachable from settings, runtime provider creation, and the production manifest.

## Features

- Chrome/Edge Manifest V3 and Firefox 140+ Manifest V2 builds
- Selection, popup, sidebar, and page translation with a floating page control
- Initial page snapshot, then near-viewport incremental translation and same-origin, same-tab navigation continuation; no permanent website rules
- Chat Completions and Responses protocols
- Stable item IDs with pure or fenced JSON response parsing
- Optional SSE streaming with complete JSONL items written progressively, not partial JSON
- Character/item batch limits, concurrency 1-10 (default 2), and optional batch timing
- 25-second default timeout and shared 100,000-character / 100-fetch document budgets
- Conservative retries and explicit handling of `interrupted/unknown`
- Session-only translation cache and sidepanel history
- API key isolation in `storage.session`, Chrome/Edge protected `storage.local`, or Firefox extension-origin IndexedDB
- Exact optional host permission requested by **Save and authorize host**
- Optional Priority request mode; support, actual routing, speed and billing depend on your Relay

Streaming and Priority are off by default. Unknown outcomes are never automatically replayed; manual retries can cause duplicate charges. Multiple presets, persistent translation caches and mobile-browser support are not implemented. Legacy provider cleanup remains separate work.

## Status and limitations

This is a development build, not a claim of complete browser or website compatibility. Recent Chrome YouTube dock, navigation and idle/incremental checks are recorded in [dynamic translation notes](docs/DYNAMIC_TRANSLATION.md). Edge and Firefox have older user-reported smoke checks; the latest shared navigation/streaming changes have **not** passed a full real Firefox/Edge acceptance matrix. Automated tests are not a substitute for those checks.

The package version remains `0.6.0`; identify a development build by its Git commit and build marker. A previously signed Firefox `0.6.0` package does not contain all current changes. No new signed release is supplied by this source update.

The security maintenance update uses WXT 0.21.4 and Tailwind 4.3.3; `npm audit` reported zero findings on 2026-10-08. This is not a guarantee against undisclosed vulnerabilities. See [publication review](docs/PUBLICATION_REVIEW.md) for scope, migration and remaining browser-validation limits. Styles require Chrome/Edge 111+ or Firefox 140+ (the manifest's Firefox minimum).

## Build

```bash
npm ci
npm run test:repository-audit
npm run audit:repository
npm run verify
npm run build:firefox
npm run audit:build:firefox
```

Chrome/Edge: enable developer mode in the extension manager and load `.output/chrome-mv3`. Firefox temporary development install: open `about:debugging#/runtime/this-firefox` and load `.output/firefox-mv2/manifest.json`. Temporary Firefox installs are not durable across browser exits. Refresh target pages after reloading an extension.

For installation, Relay configuration, retry semantics, data cleanup, mock Relay scenarios, and upstream updates, see [PRIVATE_SETUP.md](PRIVATE_SETUP.md).

Chrome/Edge MVP manual validation progress is tracked in [docs/MANUAL_VALIDATION.md](docs/MANUAL_VALIDATION.md). Firefox unlisted signing (self-distribution, no public listing) is described in [docs/FIREFOX_UNLISTED_SIGNING.md](docs/FIREFOX_UNLISTED_SIGNING.md).

## Development

```bash
npm run dev
npm test
npm run build
npm run audit:build
npm run mock-relay
```

The build audits verify browser-specific manifests and scan generated text assets for legacy provider domains, remote scripts, telemetry markers, dynamic code execution, HTML injection APIs, and likely API keys. The repository audit separately scans current publishable files, the Git index and the full ancestry of `HEAD`; it prints rule names and locations, never matched credential values. These are heuristic checks, not a security certification.

## Security model

- Content scripts never read or observe extension storage.
- Background listeners register synchronously and await a single initialization barrier.
- Background initialization restricts `storage.local` and, when supported, `storage.session` to trusted extension contexts before reading data. If `storage.local.setAccessLevel` is missing or fails, local key storage is refused; session storage remains the default.
- Content scripts submit only structured text tasks; Base URL, credentials, and Relay configuration come from protected Background state.
- Model output is mapped by stable ID and written with `textContent`, never interpreted as HTML.
- A stable `X-Translation-Request-Id` is sent on each translation batch. It is never silently removed if a proxy rejects it.

See [docs/privacy.md](docs/privacy.md) for local data and network behavior.

## Contributing and publication

Use a separate browser profile, fake keys and `npm run mock-relay` for regression tests. Do not include account screenshots, HAR files, real Relay credentials, browser profiles or signed packages in a pull request. Report credential leaks privately through GitHub's private vulnerability reporting if the repository owner has enabled it; never put a live key in an issue.

Before the first push, follow [publication review](docs/PUBLICATION_REVIEW.md). Push only the intended branch, not `--mirror` or all local refs. The `package.json` repository URL currently identifies upstream; update it to the owner's actual fork URL once that destination has been chosen.

For disclosure guidance and isolation limits, see [SECURITY.md](SECURITY.md).

## License

[MIT](LICENSE), preserving the upstream copyright notice.
