import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const nodeMajor = Number(process.versions.node.split('.')[0]);
if (!Number.isInteger(nodeMajor) || nodeMajor < 20) {
  console.error(`Node.js 20+ is required. This process is v${process.versions.node}.`);
  process.exit(1);
}

const npmOpts = { cwd: root, stdio: 'inherit', shell: true };

console.log(`OS: ${process.platform} ${process.arch}`);
console.log(`Node.js: ${process.versions.node}`);
execFileSync('npm', ['-v'], npmOpts);
execFileSync('npm', ['ci'], npmOpts);
execFileSync('npm', ['test'], npmOpts);
execFileSync('npm', ['run', 'build:firefox'], npmOpts);

const pkg = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8'));
const manifest = JSON.parse(readFileSync(path.join(root, '.output', 'firefox-mv2', 'manifest.json'), 'utf8'));
assert.equal(manifest.version, pkg.version);
assert.equal(manifest.browser_specific_settings?.gecko?.id, 'lingualens-private-relay@local');
assert.deepEqual(manifest.browser_specific_settings?.gecko?.data_collection_permissions, {
  required: ['websiteContent'],
});
assert.equal('update_url' in manifest, false);

console.log('Firefox add-on output: .output/firefox-mv2');
console.log('AMO source build finished.');
