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

const sourcePaths = [
  'BUILD.md',
  'README.md',
  'PRIVATE_SETUP.md',
  'LICENSE',
  'package.json',
  'package-lock.json',
  'wxt.config.ts',
  'tsconfig.json',
  'postcss.config.js',
  'src',
  'tests',
  'scripts',
  'public',
  'docs',
];

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

function assertPosixZipPaths(zipPath, label) {
  const listing = execFileSync('tar', ['-tf', zipPath], { encoding: 'utf8' });
  assert.equal(listing.includes('\\'), false, `${label} must use forward-slash zip paths for AMO`);
  return listing;
}

rmSync(path.join(root, 'dist'), { recursive: true, force: true });
mkdirSync(outDir, { recursive: true });

execFileSync('npm', ['run', 'zip:firefox'], { cwd: root, stdio: 'inherit', shell: process.platform === 'win32' });

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

copyFileSync(wxtUpload, path.join(outDir, uploadName));
assertPosixZipPaths(path.join(outDir, uploadName), 'Upload zip');

const sourceZip = path.join(outDir, sourceName);
execFileSync('git', ['archive', '--format=zip', '-o', sourceZip, 'HEAD', ...sourcePaths], {
  cwd: root,
  stdio: 'inherit',
});
const sourceListing = assertPosixZipPaths(sourceZip, 'Source zip');
assert.match(sourceListing, /^BUILD.md$/m);
assert.match(sourceListing, /scripts\/amo-build.mjs/);
assert.match(sourceListing, /src\/background\/credential-idb.ts/);

writeFileSync(path.join(outDir, 'README.txt'), `Upload to Mozilla Developer Hub as Unlisted / On your own.
Extension ID: lingualens-private-relay@local
Version: ${pkg.version}
Files:
  ${uploadName}   Hub "upload your add-on"
  ${sourceName}  Hub "source code" (POSIX zip paths; includes BUILD.md)
Reviewer command: node scripts/amo-build.mjs
Do not upload API keys. Confirm with the owner before submitting.
`);

console.log(`Firefox unlisted packages written to ${outDir}`);
console.log(`  ${uploadName}`);
console.log(`  ${sourceName}`);
