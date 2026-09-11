param(
  [Parameter(Mandatory = $true)][string]$Root,
  [Parameter(Mandatory = $true)][string]$Dst
)

$Stage = Join-Path $Root 'dist\firefox-unlisted\source-staging'
if (Test-Path $Stage) {
  Remove-Item $Stage -Recurse -Force
}
New-Item -ItemType Directory -Path $Stage | Out-Null

$Entries = @(
  'src',
  'tests',
  'scripts',
  'public',
  'docs',
  'package.json',
  'package-lock.json',
  'wxt.config.ts',
  'tsconfig.json',
  'postcss.config.js',
  'tailwind.config.js',
  'README.md',
  'PRIVATE_SETUP.md',
  'LICENSE'
)

foreach ($Entry in $Entries) {
  $From = Join-Path $Root $Entry
  if (Test-Path $From) {
    Copy-Item -Path $From -Destination (Join-Path $Stage $Entry) -Recurse -Force
  }
}

$Notes = @"
LinguaLens Private Relay

Reproducible Firefox MV2 build (Windows PowerShell):

1. Install Node.js 24 (or current LTS).
2. npm ci
3. npm test
4. npm run build:firefox

Unpacked output: .output/firefox-mv2
Upload package: npm run pack:firefox-unlisted

This source is TypeScript + WXT/Vite. Reviewers need this tree because the uploaded zip is bundled.
Do not include API keys, Relay credentials, or AMO JWT secrets.
"@
Set-Content -Path (Join-Path $Stage 'REVIEWER_BUILD.txt') -Value $Notes -Encoding UTF8

if (Test-Path $Dst) {
  Remove-Item $Dst -Force
}
Compress-Archive -Path (Join-Path $Stage '*') -DestinationPath $Dst -Force
Remove-Item $Stage -Recurse -Force
