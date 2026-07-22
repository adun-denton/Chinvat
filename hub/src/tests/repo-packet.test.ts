import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { compilePacket, assessClassification, PacketError } from '../lib/repo-packet.js';

function tmpRepo(files: Record<string, string>): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'chinvat-pkt-'));
  const git = (...a: string[]) => execFileSync('git', ['-C', dir, ...a], { encoding: 'utf8' });
  git('init', '-q');
  git('config', 'user.email', 't@t.local');
  git('config', 'user.name', 'test');
  for (const [rel, content] of Object.entries(files)) {
    const abs = path.join(dir, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, content);
  }
  git('add', '-A');
  git('commit', '-q', '-m', 'init');
  return dir;
}

test('compiles a self-contained packet for the generic lane', () => {
  const repo = tmpRepo({ 'src/index.ts': 'export const x = 1;\n', 'README.md': '# hi\n' });
  const r = compilePacket({
    task: 'add a y export',
    repoPath: repo,
    deliverable: 'FILE_SET',
    lane: 'generic',
    includeFiles: ['src/index.ts'],
    validationCommands: ['node --version'],
  });
  assert.match(r.packet, /TASK\nadd a y export/);
  assert.match(r.packet, /RELEVANT STRUCTURE/);
  assert.match(r.packet, /CHINVAT_DATA src\/index\.ts/); // fenced as data
  assert.match(r.packet, /\$ node --version/);
  assert.equal(r.includedPaths.length, 1);
  assert.equal(r.classification, 'INTERNAL');
  assert.equal(r.packetSha.length, 64);
});

test('chatgpt lane omits inlined structure (connector reads live)', () => {
  const repo = tmpRepo({ 'a.ts': 'export const a=1;\n' });
  const r = compilePacket({ task: 't', repoPath: repo, deliverable: 'PLAN', lane: 'chatgpt' });
  assert.match(r.packet, /omitted — read/);
});

test('secret firewall hard-fails on a tracked .env file', () => {
  const repo = tmpRepo({ '.env': 'API_KEY=supersecretvalue12345\n', 'app.ts': 'x\n' });
  assert.throws(
    () => compilePacket({ task: 't', repoPath: repo, deliverable: 'PLAN', lane: 'generic' }),
    (e: unknown) => e instanceof PacketError && /SECRET filename/.test((e as Error).message)
  );
});

test('inline credential in an included file is redacted, not leaked', () => {
  const repo = tmpRepo({
    'config.ts': 'export const token = "ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";\nexport const ok = 1;\n',
  });
  const r = compilePacket({
    task: 't',
    repoPath: repo,
    deliverable: 'FILE_SET',
    lane: 'generic',
    includeFiles: ['config.ts'],
  });
  assert.doesNotMatch(r.packet, /ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ/);
  assert.match(r.packet, /REDACTED/);
  assert.equal(r.classification, 'CONFIDENTIAL'); // escalated
});

test('classification ceiling refuses when content exceeds asserted max', () => {
  const repo = tmpRepo({
    'c.ts': 'const k = "AKIAIOSFODNN7EXAMPLE";\n',
  });
  assert.throws(
    () =>
      compilePacket({
        task: 't',
        repoPath: repo,
        deliverable: 'FILE_SET',
        lane: 'generic',
        includeFiles: ['c.ts'],
        maxClassification: 'INTERNAL', // but redaction escalates to CONFIDENTIAL
      }),
    (e: unknown) => e instanceof PacketError && /exceeds asserted ceiling/.test((e as Error).message)
  );
});

test('same inputs produce a stable packet sha (determinism)', () => {
  const repo = tmpRepo({ 'src/a.ts': 'export const a = 1;\n' });
  const base = { task: 't', repoPath: repo, deliverable: 'FILE_SET' as const, lane: 'generic' as const, includeFiles: ['src/a.ts'] };
  const a = compilePacket(base);
  const b = compilePacket(base);
  assert.equal(a.packetSha, b.packetSha);
});

test('assessClassification flags a repo with secret files as SECRET', () => {
  const repo = tmpRepo({ '.env': 'X=1\n', 'a.ts': 'x\n' });
  const a = assessClassification(repo);
  assert.equal(a.classification, 'SECRET');
  assert.deepEqual(a.secretFiles, ['.env']);
});

test('non-git path is rejected', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'chinvat-nogit-'));
  assert.throws(
    () => compilePacket({ task: 't', repoPath: dir, deliverable: 'PLAN', lane: 'generic' }),
    (e: unknown) => e instanceof PacketError && /not a git repository/.test((e as Error).message)
  );
});
