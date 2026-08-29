# LinguaLens Private Relay Edition

A private Chrome/Edge MV3 build of [q-jade/lingualens](https://github.com/q-jade/lingualens), based on upstream commit `c18d1a5`. The upstream Git history and MIT license are preserved.

This edition has one translation backend: a user-configured private Relay exposing an OpenAI-compatible Chat Completions or Responses API. Legacy provider source files remain temporarily for upstream compatibility, but they are unreachable from settings, runtime provider creation, and the production manifest.

## MVP scope

- Chrome and Edge Manifest V3
- Selection, popup, sidepanel, and static page-snapshot translation
- Chat Completions and Responses protocols
- Stable item IDs with pure or fenced JSON response parsing
- 25-second default timeout, concurrency 2, 100,000-character and 100-fetch page budgets
- Conservative retries and explicit handling of `interrupted/unknown`
- Session-only translation cache and sidepanel history
- API key isolation in `storage.session` or protected `storage.local`
- Exact optional host permission requested by **Save and authorize host**

Dynamic DOM translation, multiple presets, persistent cache, complete Firefox support, provider source cleanup, and dependency upgrades are intentionally deferred.

## Build

```bash
npm install
npm run verify
```

The unpacked production extension is generated at `.output/chrome-mv3`.

For installation, Relay configuration, retry semantics, data cleanup, mock Relay scenarios, and upstream updates, see [PRIVATE_SETUP.md](PRIVATE_SETUP.md).

Chrome/Edge MVP manual validation progress is tracked in [docs/MANUAL_VALIDATION.md](docs/MANUAL_VALIDATION.md).

## Development

```bash
npm run dev
npm test
npm run build
npm run audit:build
npm run mock-relay
```

The build audit verifies MV3 permissions and scans generated text assets for legacy provider domains, remote scripts, telemetry markers, dynamic code execution, HTML injection APIs, and likely API keys.

## Security model

- Content scripts never read or observe extension storage.
- Background listeners register synchronously and await a single initialization barrier.
- Background initialization restricts `storage.local` and, when supported, `storage.session` to trusted extension contexts before reading data.
- Content scripts submit only structured text tasks; Base URL, credentials, and Relay configuration come from protected Background state.
- Model output is mapped by stable ID and written with `textContent`, never interpreted as HTML.
- A stable `X-Translation-Request-Id` is sent on each translation batch. It is never silently removed if a proxy rejects it.

See [docs/privacy.md](docs/privacy.md) for local data and network behavior.

## License

[MIT](LICENSE), preserving the upstream copyright notice.
