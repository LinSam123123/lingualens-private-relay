import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const rules = [
  ['api-key', /\bsk-[A-Za-z0-9_-]{20,}\b/g],
  ['github-token', /\b(?:gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{30,})\b/g],
  ['cloud-access-id', /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/g],
  ['private-key', /-----BEGIN (?:[A-Z]+ )*PRIVATE KEY-----/g],
  ['jwt', /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g],
  ['url-credentials', /https?:\/\/[^\s/"'<>:@]+:[^\s/"'<>@]+@/g],
  ['literal-credential', /\b(?:api[_-]?key|access[_-]?token|client[_-]?secret|authorization|password|amo_jwt_secret)\s*["']?\s*[:=]\s*["']([A-Za-z0-9_+/.=-]{24,})["']/gi],
];

export function inspectText(text, privacy = false) {
  const findings = [];
  for (const [rule, expression] of rules) {
    expression.lastIndex = 0;
    for (const match of text.matchAll(expression)) {
      findings.push({ rule, line: text.slice(0, match.index).split('\n').length });
    }
  }
  if (privacy) {
    for (const match of text.matchAll(/\b[A-Z0-9._%+-]+@([A-Z0-9.-]+\.[A-Z]{2,})\b/gi)) {
      if (/(?:^|\.)(?:example\.(?:invalid|com|test)|noreply\.github\.com)$/i.test(match[1])) continue;
      findings.push({ rule: 'personal-email', line: text.slice(0, match.index).split('\n').length });
    }
    for (const match of text.matchAll(/\b[A-Z]:[\\/]Users[\\/][^\s\\/]+|\/(?:home|Users)\/[^\s/]+/gi)) {
      findings.push({ rule: 'personal-home-path', line: text.slice(0, match.index).split('\n').length });
    }
  }
  return findings;
}

// Exact reviewed fixture lines only. A changed value must be reviewed again.
const fixtures = new Map([
  ['tests/credential-idb.test.mjs', '8938dbde46ae21bf318c42af4a5c3d8f678d4ebebb7ae27b8a05efdd690aad5b'],
  ['tests/security.test.mjs', '5fe3abf5f3b2d340eea679c381d786c6344c6bbf281dccafeb0f13a168b3dfe7'],
]);

export function auditRepository(root, allRefs = false, privacy = false) {
  const git = (args, options = {}) => execFileSync('git', args, {
    cwd: root, maxBuffer: 256 * 1024 * 1024, ...options,
  });
  const findings = [];
  if (git(['rev-parse', '--is-shallow-repository']).toString().trim() === 'true') {
    throw new Error('Full history is required');
  }
  const binaries = new Set();
  let reviewedFixtures = 0;
  const inspect = (buffer, location, file) => {
    if (buffer.includes(0)) binaries.add(location);
    const text = buffer.toString('utf8');
    for (const match of inspectText(text, privacy)) {
      const line = text.split('\n')[match.line - 1].trim();
      if (file && fixtures.get(file) === createHash('sha256').update(line).digest('hex')) {
        reviewedFixtures++;
        continue;
      }
      findings.push({ location, ...match });
    }
  };
  const files = git(['ls-files', '-z', '--cached', '--others', '--exclude-standard'])
    .toString('utf8').split('\0').filter(Boolean);
  for (const file of new Set(files)) {
    if (/(?:^|\/)(?:\.env(?:\..+)?|[^/]+\.(?:pem|key|p12|pfx|har|db|sqlite3?))$/i.test(file)) {
      findings.push({ location: `worktree:${file}`, rule: 'sensitive-filename', line: 0 });
    }
    inspect(readFileSync(path.join(root, file)), `worktree:${file}`, file);
  }

  // The index can differ from disk; staged secrets must not pass a clean worktree scan.
  const index = git(['ls-files', '--stage', '-z']).toString('utf8').split('\0').filter(Boolean);
  for (const entry of index) {
    const tab = entry.indexOf('\t');
    const [mode, oid, stage] = entry.slice(0, tab).split(' ');
    if (mode === '160000') throw new Error('Review submodule content separately');
    inspect(git(['cat-file', 'blob', oid]), `index:${stage}:${entry.slice(tab + 1)}`, entry.slice(tab + 1));
  }

  // Read every reachable object, not just the tips or currently existing files.
  const objects = git(['rev-list', '--objects', allRefs ? '--all' : 'HEAD']).toString('utf8').trim().split('\n');
  const ids = objects.map((line) => line.split(' ')[0]);
  const paths = new Map(objects.map((line) => [line.split(' ')[0], line.slice(line.indexOf(' ') + 1)]));
  const packed = git(['cat-file', '--batch'], { input: `${ids.join('\n')}\n` });
  let offset = 0;
  let blobs = 0;
  let commits = 0;
  while (offset < packed.length) {
    const end = packed.indexOf(10, offset);
    const [oid, type, rawSize] = packed.subarray(offset, end).toString().split(' ');
    const size = Number(rawSize);
    if (end < 0 || !Number.isSafeInteger(size)) throw new Error('Invalid Git object stream');
    const buffer = packed.subarray(end + 1, end + 1 + size);
    if (type === 'blob') {
      blobs++;
      inspect(buffer, `history:${oid.slice(0, 12)}:${paths.get(oid)}`, paths.get(oid));
    } else if (type === 'commit' || type === 'tag') {
      if (type === 'commit') commits++;
      inspect(buffer, `${type}:${oid.slice(0, 12)}`);
    }
    offset = end + 1 + size + 1;
  }
  return {
    historyScope: allRefs ? 'all local refs (including private checkpoints)' : 'HEAD and its ancestors',
    worktreeFiles: new Set(files).size, indexEntries: index.length, commits, blobs, reviewedFixtures,
    binaryObjects: binaries.size, findings,
    limitations: 'Heuristic scan, not proof of absence. Binary images/archives, obfuscated secrets, private URLs and Git author identities need separate review. Ignored files, reflogs and unreachable objects are not scanned or intended for publication.',
  };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const report = auditRepository(path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..'), process.argv.includes('--all-refs'), process.argv.includes('--privacy'));
    console.log(JSON.stringify(report, null, 2));
    process.exitCode = report.findings.length ? 1 : 0;
  } catch {
    console.error('Repository audit failed; no secret-bearing command output is printed. Check Git and file availability.');
    process.exitCode = 2;
  }
}
