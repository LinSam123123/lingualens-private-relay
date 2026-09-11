# Firefox source build (AMO reviewers)

This file is the step-by-step recipe for an **exact copy** of the uploaded Firefox add-on. The uploaded zip is produced by WXT/Vite from the TypeScript in `src/`. That is why this source tree is required.

Do not treat `.output/` as source. Do not minify or bundle this tree by hand.

## Operating system

The build is supported on:

- Windows 10 or 11 (PowerShell or cmd)
- macOS 13+
- Current Linux distributions

No other OS-specific tools are required beyond Node.js and npm.

## Required programs

| Program | Version | Install |
| --- | --- | --- |
| Node.js | **20.x or 24.x** (this package was last built with Node.js v24.14.0) | https://nodejs.org/ — LTS installer, or `nvm install 24` |
| npm | **10+** (ships with Node.js 20/24) | Installed with Node.js. Check with `npm -v`. |

Verify:

```bash
node -v
npm -v
```

`node -v` must print `v20` or newer.

## One build script

From the repository root (the directory that contains this `BUILD.md`):

```bash
node scripts/amo-build.mjs
```

That script:

1. Checks the Node.js version.
2. Runs `npm ci` (exact `package-lock.json` versions).
3. Runs `npm test`.
4. Runs `npm run build:firefox`.
5. Checks that the Firefox manifest ID is `lingualens-private-relay@local`, `data_collection_permissions.required` is `websiteContent`, and there is no `update_url`.

Equivalent manual steps if you prefer not to use the script:

```bash
npm ci
npm test
npm run build:firefox
```

## Output that must match the uploaded add-on

Unpacked Firefox MV2 directory:

```text
.output/firefox-mv2
```

That directory’s `manifest.json` must contain:

- `"version"` equal to `package.json` (`0.6.0` for this submission)
- `browser_specific_settings.gecko.id` = `lingualens-private-relay@local`
- `data_collection_permissions.required` = `["websiteContent"]`
- no `update_url`

The Hub upload zip is this unpacked tree, zipped with **forward-slash** paths (POSIX). Windows `Compress-Archive` is not used; it writes `docs\file.md` names that AMO rejects.

## Notes for review

- Personal unlisted add-on. It sends selected or page text only to a Relay Base URL the user configures (HTTPS, or HTTP on localhost / 127.0.0.1).
- `websiteContent` is declared because webpage text leaves the browser. There is no telemetry and no project-operated server.
- Legacy provider source files under `src/providers/` remain on disk but are not reachable from settings or the production manifest.
- API keys must not appear in this source zip.
