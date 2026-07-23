# Upstream Baseline Audit

- Upstream: `q-jade/lingualens`
- Commit: `c18d1a5c9769c7c60827a4d3ebf1963f6a555f87`
- Version: `0.5.1`
- Date checked: `2026-07-23`

## Verification

- `npm ci`: passed with Node `v24.14.0` using the Windows system CA store.
- `npx tsc --noEmit`: passed.
- `npm run build`: passed; Chrome MV3 output size was 2.36 MB.
- `npm audit`: reported 15 issues (1 low, 2 moderate, 9 high, 3 critical), all in the existing build/development dependency graph. Dependency upgrades are deferred from the MVP unless a runtime-impacting issue is confirmed.

## Baseline Manifest

The upstream Chrome build requests `storage`, `activeTab`, `sidePanel`, `contextMenus`, and `scripting`. It also pre-authorizes localhost, OpenAI, DeepSeek, DeepL, and Google Translation hosts. The private relay build will replace those network host permissions with user-granted optional permissions.

## Baseline Security Gaps

- API keys are stored inside the general settings object in `storage.local`.
- `GET_SETTINGS` returns provider records, including API keys, to content scripts.
- Content scripts listen directly for storage changes.
- The custom provider can construct arbitrary request URLs and headers.
- Page translation uses a fixed concurrency of four and cannot abort background fetches.
- Translation cache and side-panel history persist in `storage.local`.
