import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { auditManifest } from './build-audit-policy.mjs';

const browser = process.argv[2] ?? 'chrome';
assert.ok(['chrome', 'firefox'].includes(browser), 'Usage: node scripts/audit-build.mjs [chrome|firefox]');
const outputRoot = path.resolve(`.output/${browser === 'firefox' ? 'firefox-mv2' : 'chrome-mv3'}`);

async function filesUnder(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const fullPath = path.join(directory, entry.name);
    if (entry.isDirectory()) files.push(...await filesUnder(fullPath));
    else files.push(fullPath);
  }
  return files;
}

const manifest = JSON.parse(await readFile(path.join(outputRoot, 'manifest.json'), 'utf8'));
auditManifest(manifest, browser);

const textFiles = (await filesUnder(outputRoot)).filter((file) => /\.(?:js|html|json|css)$/i.test(file));
const output = (await Promise.all(textFiles.map((file) => readFile(file, 'utf8')))).join('\n');
const forbidden = [
  /api\.openai\.com/i,
  /api\.deepseek\.com/i,
  /api-free\.deepl\.com/i,
  /translation\.googleapis\.com/i,
  /localhost:11434/i,
  /localhost:1234/i,
  /ProviderPicker/,
  /\beval\s*\(/,
  /\bnew\s+Function\s*\(/,
  /<script[^>]+src=["']https?:/i,
  /\b(?:sentry|posthog|segment\.io|google-analytics|telemetry)\b/i,
  /\bsk-[A-Za-z0-9_-]{20,}\b/,
];
for (const pattern of forbidden) assert.equal(pattern.test(output), false, `Forbidden build content: ${pattern}`);

const sourceFiles = (await filesUnder(path.resolve('src'))).filter((file) => /\.(?:ts|tsx|js|jsx)$/i.test(file));
const source = (await Promise.all(sourceFiles.map((file) => readFile(file, 'utf8')))).join('\n');
assert.equal(/dangerouslySetInnerHTML/.test(source), false, 'Source must not render model output as HTML');

console.log(`${browser} build audit passed: ${textFiles.length} build assets and ${sourceFiles.length} source files checked.`);
