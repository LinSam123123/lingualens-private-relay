# GitHub publication review

Date: 2026-10-08. Code baseline: `e7921ac`; review changes are in the working tree until explicitly committed. This review does not authorize a push, a signed release, or a history rewrite.

## Result

No suspected live credential was found by the configured heuristic rules in the publishable working files or the current branch's 139 commits (808 unique historical file blobs). The two flagged test fixtures are deliberately fake and allowed only by exact file path and line hash; changed fixture values must be reviewed again. The scan also checks the Git index separately, so a staged secret cannot hide behind a clean working copy.

The only binary asset in this branch history is the extension logo. It was visually inspected; there are no tracked account screenshots, ZIP/XPI packages or browser databases in this branch. Visual inspection and pattern matching cannot prove the absence of steganographic, obfuscated or unrecognized credentials. URL hosts were reviewed separately: upstream/provider/documentation links and loopback/example hosts remain; no personal Relay host was found in the current branch's history.

This is **not a clean security certification or a final public-release approval**. Resolve the following decisions before publishing.

## Open decisions

1. **Git metadata privacy.** History contains author email addresses and older documentation contains a local Windows username/path. Current documentation uses repository-relative paths, but previous commits still contain the originals. The owner must decide whether to publish that history as-is. No history was rewritten and the upstream MIT attribution was preserved. Changing Git's email now would affect only future commits. If anonymization is required, plan it separately without modifying upstream attribution or the daily checkout blindly.
2. **Dependency findings.** `npm audit --json` reports 27 vulnerable package entries: 1 low, 4 moderate, 19 high and 3 critical. Critical entries are `shell-quote`, `fx-runner`, and `web-ext-run`; the latter entries include transitive impact, so these are not 27 independent exploitable extension bugs. Findings involve the build/development graph, including WXT, Vite, icon tooling and CSS tooling. This review did not establish exploitability of every advisory or absence of runtime exposure. Dependencies and lockfile were intentionally not upgraded. Keep development servers on loopback and do not process untrusted build inputs. Schedule a separate dependency remediation and regression pass before advertising a security-reviewed release.
3. **Repository destination.** Only the upstream remote is configured. Choose the owner's GitHub repository URL and visibility before adding an `origin`. `package.json` still identifies the upstream repository; replace it with the actual fork URL once chosen. Do not invent a destination or push to upstream.
4. **Browser coverage.** The latest Chrome installed-extension navigation/idle evidence is in `DYNAMIC_TRANSLATION.md`. Older Edge/Firefox smoke observations are not acceptance of all current changes. Real Firefox/Edge regression coverage is still incomplete. This preparation ran automated checks, not a new browser acceptance session.

## Publication boundary

Publish the reviewed source branch, not the whole working directory or `.git` directory.

- Keep `LICENSE`, source, tests, lockfile, configuration, scripts and public documentation.
- Exclude `.env*`, credentials, logs, HARs, browser profiles/databases, test screenshots, `node_modules`, `dev`, `dist`, `.output`, `.wxt`, ZIP/XPI artifacts, and the unrelated local subprojects already named in `.gitignore`.
- Ignoring a path does not remove previously committed content. The history scan is a separate requirement.
- Local `refs/codex/*` checkpoints contain unrelated work not present in the current branch ancestry. They are outside the approved publication scope. Do not use `git push --mirror`, `--all`, or indiscriminately push tags. An explicit selected-branch push is required after review and authorization.
- Existing upstream tags describe upstream releases, not this edition. Do not publish a new signed `0.6.0` package or imply that the old signed build contains these changes.
- The Firefox packaging script archives source from `HEAD` but builds the checkout. Only use it from a reviewed, clean, committed tree; this task did not run packaging, replace existing packages, or upload anything.

## Repeatable checks

Use Node.js 24 and the committed lockfile:

```sh
npm ci
npm run audit:repository
npm run verify
npm run build:firefox
npm run audit:build:firefox
git diff --check
git status --short
```

`npm test` includes scanner regression tests: a historical deleted credential remains detectable; a staged credential is detected even if its working copy is clean; ignored files are not scanned; matched values are not returned. `audit:repository` scans `HEAD` ancestry by default and fails on findings, shallow history or incomplete reads. `--all-refs` is an optional local diagnostic that also includes private checkpoints; it is not an instruction to publish those refs. Ignored files, reflogs and unreachable objects are outside the normal scan. Do not force-add ignored artifacts.

GitHub CI now uses Node.js 24, read-only repository permissions, a full checkout without persisted Git credentials, the repository scan, the complete test suite, TypeScript, and both production builds/audits. The workflow text was reviewed and its test/build commands were run locally; the workflow itself has not run on GitHub. Dependency audit findings are disclosed here, not hidden by a claim that CI is a vulnerability-free guarantee.

## Local verification results

- `npm run test:repository-audit`: passed (3 tests, including history and staged-content checks).
- `npm run audit:repository`: passed with no unreviewed findings.
- `npm run verify`: passed (full extension tests, TypeScript, Chrome production build and audit).
- `npm run build:firefox` and `npm run audit:build:firefox`: passed.
- `git diff --check`: passed.
- Upstream commit `c18d1a5` remains an ancestor and `LICENSE` is unchanged from upstream.
- `npm audit --json`: **failed with the 27 findings above**, not resolved in this task.

These runs used the existing installed dependencies on Node.js v24.14.0. No new clean-machine installation, paid Relay call, browser acceptance run, source/signing archive generation or GitHub operation was performed. No lockfile or extension-runtime source was changed.

Before the actual push, inspect the exact staged file list and diff, rerun the repository scan after the final commit, and confirm the destination, visibility and metadata decision with the owner. Never paste a live key into an issue or commit message. Revoke any temporary credentials shared during earlier testing at the Relay operator; this review did not read or reuse them and cannot confirm revocation.
