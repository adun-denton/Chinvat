import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { validateInWorktree, applyToLive, cleanup, baseCommitPresent } from '../lib/relay-worktree.js';
import type { ParsedResponse } from '../lib/relay-envelope.js';

function tmpRepo(): { dir: string; head: string } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'chinvat-wt-'));
  const git = (...a: string[]) => execFileSync('git', ['-C', dir, ...a], { encoding: 'utf8' }).trim();
  git('init', '-q');
  git('config', 'user.email', 't@t.local');
  git('config', 'user.name', 'test');
  fs.writeFileSync(path.join(dir, 'value.txt'), 'one\n');
  git('add', '-A');
  git('commit', '-q', '-m', 'init');
  return { dir, head: git('rev-parse', 'HEAD') };
}

function fileSetResponse(taskId: string, baseCommit: string, files: { path: string; content: string }[]): ParsedResponse {
  return {
    taskId,
    baseCommit,
    packetSha: 'x',
    modelSurface: 'test',
    outputType: 'FILE_SET',
    assumptions: [],
    validationNotes: [],
    payload: '',
    files,
  };
}

test('FILE_SET validates in an isolated worktree and applies to live', async () => {
  const { dir, head } = tmpRepo();
  const taskId = 'CR-2026-0001';
  const resp = fileSetResponse(taskId, head, [{ path: 'value.txt', content: 'two\n' }]);

  const report = await validateInWorktree({
    repoPath: dir,
    taskId,
    baseCommit: head,
    response: resp,
    validationCommands: ['grep -q two value.txt'],
  });

  assert.equal(report.ok, true);
  assert.deepEqual(report.changedFiles, ['value.txt']);
  assert.equal(report.steps.length, 1);
  assert.equal(report.steps[0].ok, true);

  // live branch is still untouched until apply
  assert.equal(fs.readFileSync(path.join(dir, 'value.txt'), 'utf8'), 'one\n');

  const applied = applyToLive({ repoPath: dir, taskId, baseCommit: head });
  assert.equal(applied.applied, true);
  assert.equal(fs.readFileSync(path.join(dir, 'value.txt'), 'utf8'), 'two\n');

  cleanup(dir, taskId);
});

test('failing validation command marks the report not-ok', async () => {
  const { dir, head } = tmpRepo();
  const taskId = 'CR-2026-0002';
  const resp = fileSetResponse(taskId, head, [{ path: 'value.txt', content: 'two\n' }]);
  const report = await validateInWorktree({
    repoPath: dir,
    taskId,
    baseCommit: head,
    response: resp,
    validationCommands: ['grep -q NOPE value.txt'],
  });
  assert.equal(report.ok, false);
  assert.match(report.problems.join(' '), /validation step failed/);
  cleanup(dir, taskId);
});

test('apply is blocked when live HEAD has moved off the packet base', async () => {
  const { dir, head } = tmpRepo();
  const taskId = 'CR-2026-0003';
  const resp = fileSetResponse(taskId, head, [{ path: 'value.txt', content: 'two\n' }]);
  await validateInWorktree({ repoPath: dir, taskId, baseCommit: head, response: resp, validationCommands: [] });

  // move live HEAD forward
  const git = (...a: string[]) => execFileSync('git', ['-C', dir, ...a], { encoding: 'utf8' });
  fs.writeFileSync(path.join(dir, 'other.txt'), 'z\n');
  git('add', '-A');
  git('commit', '-q', '-m', 'move head');

  const applied = applyToLive({ repoPath: dir, taskId, baseCommit: head });
  assert.equal(applied.applied, false);
  assert.match(applied.detail, /moved off packet base/);
  cleanup(dir, taskId);
});

test('baseCommitPresent detects a stale base', () => {
  const { dir } = tmpRepo();
  assert.equal(baseCommitPresent(dir, 'deadbeefdeadbeefdeadbeefdeadbeefdeadbeef'), false);
});
