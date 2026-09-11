import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { copyFileSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const pkg = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8'));
const outDir = path.join(root, 'dist', 'firefox-unlisted');
const extensionDir = path.join(root, '.output', 'firefox-mv2');
const uploadName = `lingualens-private-${pkg.version}-firefox.zip`;
const sourceName = `lingualens-private-${pkg.version}-firefox-source.zip`;
const wxtUpload = path.join(root, '.output', `lingualens-${pkg.version}-firefox.zip`);

const uploadForbidden = [
  /api\.openai\.com/i,
  /\bsk-[A-Za-z0-9_-]{20,}\b/,
  /\b(?:sentry|posthog|segment\.io|google-analytics)\b/i,
];
const sourceForbidden = [
  /\bsk-[A-Za-z0-9_-]{20,}\b/,
  /\b(?:AMO_JWT|JWT_SECRET)\s*[:=]\s*['"][^'"]+['"]/,
];

function listFiles(directory) {
  const entries = readdirSync(directory, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const fullPath = path.join(directory, entry.name);
    if (entry.isDirectory()) files.push(...listFiles(fullPath));
    else files.push(fullPath);
  }
  return files;
}

function scanTextTree(directory, label, patterns) {
  const textFiles = listFiles(directory).filter((file) => /\.(?:js|html|json|css|md|ts|tsx|mjs)$/i.test(file));
  const output = textFiles.map((file) => readFileSync(file, 'utf8')).join('\n');
  for (const pattern of patterns) {
    assert.equal(pattern.test(output), false, `${label} contains forbidden pattern: ${pattern}`);
  }
}

rmSync(path.join(root, 'dist'), { recursive: true, force: true });
mkdirSync(outDir, { recursive: true });

if (process.env.SKIP_FIREFOX_BUILD !== '1') {
  execFileSync('npm', ['run', 'zip:firefox'], { cwd: root, stdio: 'inherit', shell: true });
} else {
  execFileSync('npm', ['run', 'build:firefox'], { cwd: root, stdio: 'inherit', shell: true });
}

const manifest = JSON.parse(readFileSync(path.join(extensionDir, 'manifest.json'), 'utf8'));
assert.equal(manifest.version, pkg.version);
assert.equal(manifest.browser_specific_settings?.gecko?.id, 'lingualens-private-relay@local');
assert.equal(manifest.browser_specific_settings?.gecko?.strict_min_version, '140.0');
assert.deepEqual(manifest.browser_specific_settings?.gecko?.data_collection_permissions, {
  required: ['websiteContent'],
});
assert.equal('update_url' in manifest, false);
assert.equal(manifest.permissions.includes('scripting'), false);
scanTextTree(extensionDir, 'Firefox build', uploadForbidden);
scanTextTree(path.join(root, 'src'), 'Source', sourceForbidden);

if (!process.env.SKIP_FIREFOX_BUILD) {
  copyFileSync(wxtUpload, path.join(outDir, uploadName));
} else {
  execFileSync('powershell.exe', [
    '-NoProfile',
    '-ExecutionPolicy', 'Bypass',
    '-File', path.join('scripts', 'zip-dir.ps1'),
    '-Src', extensionDir,
    '-Dst', path.join(outDir, uploadName),
  ], { cwd: root, stdio: 'inherit' });
}

execFileSync('powershell.exe', [
  '-NoProfile',
  '-ExecutionPolicy', 'Bypass',
  '-File', path.join('scripts', 'zip-source.ps1'),
  '-Root', root,
  '-Dst', path.join(outDir, sourceName),
], { cwd: root, stdio: 'inherit' });

writeFileSync(path.join(outDir, 'README.txt'), `Upload to Mozilla Developer Hub as Unlisted / On your own.
Extension ID: lingualens-private-relay@local
Version: ${pkg.version}
Files:
  ${uploadName}
  ${sourceName}
Do not upload API keys. Confirm with the owner before submitting.
See docs/FIREFOX_UNLISTED_SIGNING.md
`);

console.log(`Firefox unlisted packages written to ${outDir}`);
console.log(`  ${uploadName}`);
console.log(`  ${sourceName}`);
