# GitHub publication review

Updated 2026-10-08. This is the separately prepared publication checkout, not the original private working directory. Nothing has been pushed to GitHub and no signed package was produced.

## Anonymized history

- The source change sequence is retained. Author and committer names/emails now use `Contributor <contributor@example.invalid>`.
- Co-author, sign-off, review and test attribution trailers are anonymized as well. Rewriting only the author header would leave those trailers exposed.
- Private home-directory paths were replaced in historical text blobs and commit messages. Current documentation uses repository-relative paths.
- The original upstream MIT license and its copyright notice are unchanged. That required attribution is intentionally not removed.
- Rewritten commits have different hashes. References to old hashes in historical documentation identify the original private/upstream history, not necessarily a locally resolvable revision.
- The publication checkout contains only `codex/public-release`, with no remote, original tags, private checkpoints or original-history backup refs. The original working directory remains the private recovery copy; do not publish it.
- Local Git identity in this checkout is anonymous for future commits. This does not change the machine's global Git identity. A GitHub push still exposes the publishing GitHub account; repository-content anonymization does not make the account anonymous.

The repository scanner checks worktree files, staged blobs, complete `HEAD` ancestry, and commit messages for credential patterns, personal email addresses and home-directory paths. It reports only locations and rule names, not matched values. Exact reviewed fake test lines are narrowly allowlisted by path and SHA-256. Example-domain and GitHub noreply email addresses are allowed. This is a heuristic check, not proof that all possible identifying information or secrets are absent.

## Dependency remediation

The original audit reported 27 vulnerable package entries: 1 low, 4 moderate, 19 high and 3 critical. The updated lockfile reports **zero vulnerabilities** with `npm audit --json` on 2026-10-08. No advisory suppression or `--force` dependency override was used.

| Area | Change |
| --- | --- |
| Extension toolchain | WXT 0.20.26 to 0.21.4; obsolete web-ext-run / fx-runner / shell-quote chain removed |
| Bundler | Vite resolved to 8.3.4 via supported peer range |
| Icons | Existing auto-icons workflow retained, module updated to 1.1.2 with current Sharp |
| CSS | PostCSS 8.5.29; Tailwind 3.4.19 to 4.3.3 with its official PostCSS adapter; obsolete braces / micromatch / fast-glob chain removed |
| Tests | Explicit esbuild 0.28.2 dependency, replacing reliance on a former transitive installation |
| Runtime requirement | Node.js 24+ for reproducible test/build commands |

Tailwind 3 had no patched compatible dependency chain for the outstanding advisories, so the CSS pipeline was migrated rather than hiding alerts. Shared CSS preserves earlier border, placeholder and pointer defaults. Renamed shrink, shadow and focus-outline utilities were updated. Existing layouts and translation logic were not redesigned. The obsolete empty Tailwind JS configuration was removed from both source and signing-source archive selection.

WXT now generates stricter TypeScript defaults. The project explicitly retains its previous `noUncheckedIndexedAccess: false` and `noImplicitOverride: false` baseline while keeping `strict: true`. Adopting additional strictness across the translation engine is separate work; the security update does not pretend to have completed that refactor.

Official migration references: [WXT releases](https://github.com/wxt-dev/wxt/releases), [Tailwind upgrade guide](https://tailwindcss.com/docs/upgrade-guide). Tailwind 4 requires Chrome/Edge 111+; the Firefox manifest already requires 140+.

## Verification and limits

- Full test suite, including history/staged-credential and privacy-scanner regression tests.
- TypeScript and Chrome/Firefox production builds and their manifest/content audits.
- Credential/privacy scan over the anonymized history and current files.
- `npm audit` without omitting build or development dependencies.
- Fresh `npm ci` from the committed lockfile, followed by verification.
- Headless Chrome rendered actual built settings (1440px and 390px), Popup (340px) and sidebar (390px) with mock browser APIs. No horizontal overflow or application exception was observed; screenshots were inspected. A Shadow DOM control check confirmed generated padding, border and theme variables.

The UI check is not installed-extension end-to-end acceptance: messaging, real translation, storage persistence and live Firefox navigation were not revalidated here. External requests were blocked; a locally injected security-product script was blocked by the harness. No real Key or paid Relay call was used. Existing daily Chrome/Firefox installations and the signed Firefox package were not modified.

## Publication procedure

```sh
npm ci
npm run audit:repository
npm run verify
npm run build:firefox
npm run audit:build:firefox
npm audit --audit-level=low
git diff --check
git status --short
```

Choose the destination GitHub repository and visibility, then update the package repository URL from upstream to that fork. Push only the reviewed branch after explicit authorization. Do not mirror the private checkout or upload a ZIP of its directory. Ignored development screenshots, profiles, logs, credentials, .output, dist, node_modules and private maintenance tools are not source deliverables. Existing development build version `0.6.0` is unchanged; producing a new signed Firefox update requires its own versioning and browser acceptance step.

The dependency audit is now enforced by CI. New advisories may cause it to fail later; investigate rather than suppress them. Enable GitHub private vulnerability reporting when the destination exists. Revoke previously shared temporary credentials at the issuer; this task cannot confirm their revocation.
