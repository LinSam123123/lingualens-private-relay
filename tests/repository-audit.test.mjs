import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { inspectText, auditRepository } from '../scripts/audit-repository.mjs';

test('flags credentials without returning matched values', () => {
  const secret = 'sk-' + 'a1'.repeat(24);
  const findings = inspectText('heading\n' + secret);
  assert.deepEqual(findings, [{ rule: 'api-key', line: 2 }]);
  assert.equal(JSON.stringify(findings).includes(secret), false);
  assert.equal(inspectText(secret).length, 1);
});

test('recognizes other token forms and ignores short mock credentials', () => {
  for (const value of [
    'ghp_' + 'a'.repeat(36),
    'AKIA' + 'A'.repeat(16),
    '-----BEGIN ' + 'PRIVATE KEY-----',
    'https://' + 'user:password@example.invalid',
    'apiKey: "' + 'b2'.repeat(24) + '"',
  ]) assert.ok(inspectText(value).length > 0);
  assert.deepEqual(inspectText('apiKey: "mock-key"'), []);
});

test('privacy audit rejects personal email and home paths but permits anonymous identities', () => {
  assert.deepEqual(inspectText('Contributor <contributor@example.invalid>', true), []);
  assert.equal(inspectText('person' + '@private-mail.test', true)[0].rule, 'personal-email');
  assert.equal(inspectText('C:' + '\\Users\\Someone\\project', true)[0].rule, 'personal-home-path');
  assert.equal(inspectText(['', 'home', 'someone', 'project'].join('/'), true)[0].rule, 'personal-home-path');
});

test('scans deleted historical secrets without exposing them or scanning ignored files', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'lingualens-audit-'));
  const git = (...args) => execFileSync('git', args, { cwd: root, stdio: 'pipe' });
  try {
    git('init');
    git('config', 'user.name', 'Audit Test');
    git('config', 'user.email', 'audit@example.invalid');
    git('config', 'commit.gpgsign', 'false');
    const secret = 'sk-' + 'b3'.repeat(24);
    writeFileSync(path.join(root, 'removed.txt'), secret);
    writeFileSync(path.join(root, '.gitignore'), 'ignored.txt\n');
    git('add', '.');
    git('commit', '-m', 'fixture');
    git('rm', 'removed.txt');
    git('commit', '-m', 'remove fixture');
    writeFileSync(path.join(root, 'ignored.txt'), secret);
    const report = auditRepository(root);
    assert.equal(report.commits, 2);
    assert.equal(report.findings.length, 1);
    assert.match(report.findings[0].location, /^history:.*:removed.txt$/);
    assert.equal(JSON.stringify(report).includes(secret), false);
    writeFileSync(path.join(root, 'staged.txt'), secret);
    git('add', 'staged.txt');
    writeFileSync(path.join(root, 'staged.txt'), 'clean working copy');
    const stagedReport = auditRepository(root);
    assert.ok(stagedReport.findings.some((entry) => entry.location === 'index:0:staged.txt'));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
