/**
 * Relay worktree — the isolation boundary (docs/DESIGN-mail-relay.md §Validation).
 *
 * Imported model output is NEVER touched to the active branch. It is applied
 * inside a disposable `git worktree` pinned to the packet's BASE_COMMIT, run
 * through format/lint/typecheck/test, then either accepted (diff returned for a
 * policy-gated apply) or discarded. The worktree is the only place untrusted
 * output becomes executable, and it is thrown away on reject.
 *
 * This module runs external commands (git, and the packet's validation
 * commands). It is invoked by the chat-relay adapter's `relay_validate`
 * (risk: act) and never applies to the live branch itself — that is
 * `relay_apply` (risk: dangerous, policy-gated).
 */
import { execFileSync, execFile } from 'node:child_process';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import type { ParsedResponse, RelayFile } from './relay-envelope.js';

export interface ValidationStep {
  name: string;
  ok: boolean;
  code: number | null;
  durationMs: number;
  tail: string;
}

export interface ValidationReport {
  ok: boolean;
  worktree: string;
  baseCommit: string;
  headAfterApply: string | null;
  changedFiles: string[];
  steps: ValidationStep[];
  diff: string;
  problems: string[];
}

export class WorktreeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'WorktreeError';
  }
}

function git(repo: string, args: string[]): string {
  return execFileSync('git', ['-C', repo, ...args], {
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  }).trim();
}

function safeToken(id: string): string {
  if (!/^[\w.-]+$/.test(id)) throw new WorktreeError(`unsafe task id for worktree path: ${id}`);
  return id;
}

/** Verify the repo currently contains the packet's base commit. */
export function baseCommitPresent(repoPath: string, baseCommit: string): boolean {
  try {
    git(repoPath, ['cat-file', '-e', `${baseCommit}^{commit}`]);
    return true;
  } catch {
    return false;
  }
}

/**
 * Create a disposable worktree at baseCommit, apply the parsed response,
 * run validation commands, and return a report. The worktree is left on disk
 * for inspection; call cleanup() after accept/reject.
 */
export async function validateInWorktree(opts: {
  repoPath: string;
  taskId: string;
  baseCommit: string;
  response: ParsedResponse;
  validationCommands: string[];
  signal?: AbortSignal;
  perStepTimeoutMs?: number;
}): Promise<ValidationReport> {
  const { repoPath, taskId, baseCommit, response } = opts;
  const problems: string[] = [];
  const steps: ValidationStep[] = [];

  if (!baseCommitPresent(repoPath, baseCommit))
    throw new WorktreeError(
      `base commit ${baseCommit.slice(0, 12)} is not present in ${repoPath} — fetch it or the packet is stale`
    );

  const wtRoot = path.join(os.tmpdir(), 'chinvat-relay');
  await fsp.mkdir(wtRoot, { recursive: true });
  const worktree = path.join(wtRoot, `wt-${safeToken(taskId)}`);

  // Remove a stale worktree of the same name first.
  if (fs.existsSync(worktree)) {
    try {
      git(repoPath, ['worktree', 'remove', '--force', worktree]);
    } catch {
      await fsp.rm(worktree, { recursive: true, force: true });
    }
  }

  const branch = `chinvat/relay-${safeToken(taskId)}`;
  try {
    git(repoPath, ['worktree', 'add', '--force', '-B', branch, worktree, baseCommit]);
  } catch (e) {
    throw new WorktreeError(`worktree add failed: ${e instanceof Error ? e.message : e}`);
  }

  const report: ValidationReport = {
    ok: false,
    worktree,
    baseCommit,
    headAfterApply: null,
    changedFiles: [],
    steps,
    diff: '',
    problems,
  };

  // Apply the response into the worktree.
  try {
    if (response.outputType === 'FILE_SET') {
      applyFileSet(worktree, response.files);
    } else if (response.outputType === 'UNIFIED_DIFF') {
      applyDiff(worktree, response.diff ?? '');
    } else {
      problems.push(`OUTPUT_TYPE ${response.outputType} is advisory (no code to apply) — nothing validated`);
      report.ok = problems.length === 0;
      return report;
    }
  } catch (e) {
    problems.push(`apply failed: ${e instanceof Error ? e.message : e}`);
    return report;
  }

  git(worktree, ['add', '-A']);
  report.changedFiles = git(worktree, ['diff', '--cached', '--name-only']).split('\n').filter(Boolean);
  report.diff = git(worktree, ['diff', '--cached']);
  // Commit so validation commands see a clean tree and we can diff later.
  git(worktree, ['-c', 'user.email=relay@chinvat.local', '-c', 'user.name=chinvat-relay', 'commit', '-m', `relay ${taskId}`, '--no-verify']);
  report.headAfterApply = git(worktree, ['rev-parse', 'HEAD']);

  // Run validation commands sequentially; stop on first failure.
  for (const cmd of opts.validationCommands) {
    if (opts.signal?.aborted) {
      problems.push('cancelled during validation');
      break;
    }
    const step = await runStep(worktree, cmd, opts.perStepTimeoutMs ?? 600_000, opts.signal);
    steps.push(step);
    if (!step.ok) {
      problems.push(`validation step failed: ${cmd}`);
      break;
    }
  }

  report.ok = problems.length === 0 && steps.every((s) => s.ok);
  return report;
}

function normalizeRel(p: string): string {
  const norm = p.replace(/\\/g, '/').replace(/^\.?\//, '');
  if (norm.includes('..') || path.isAbsolute(norm)) throw new WorktreeError(`unsafe path: ${p}`);
  return norm;
}

function applyFileSet(worktree: string, files: RelayFile[]): void {
  const root = fs.realpathSync(worktree);
  for (const f of files) {
    const rel = normalizeRel(f.path);
    const abs = path.resolve(root, rel);
    if (abs !== root && !abs.startsWith(root + path.sep))
      throw new WorktreeError(`file escapes worktree: ${f.path}`);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, f.content, 'utf8');
  }
}

function applyDiff(worktree: string, diff: string): void {
  if (!diff.trim()) throw new WorktreeError('empty diff');
  const patchFile = path.join(worktree, '.chinvat-relay.patch');
  fs.writeFileSync(patchFile, diff.endsWith('\n') ? diff : diff + '\n', 'utf8');
  try {
    // --check first so a bad patch fails before mutating anything.
    execFileSync('git', ['-C', worktree, 'apply', '--check', '--whitespace=nowarn', patchFile], {
      encoding: 'utf8',
    });
    execFileSync('git', ['-C', worktree, 'apply', '--whitespace=nowarn', patchFile], { encoding: 'utf8' });
  } catch (e) {
    throw new WorktreeError(`git apply rejected the diff: ${e instanceof Error ? e.message : e}`);
  } finally {
    fs.rmSync(patchFile, { force: true });
  }
}

function runStep(
  cwd: string,
  cmd: string,
  timeoutMs: number,
  signal?: AbortSignal
): Promise<ValidationStep> {
  const t0 = Date.now();
  return new Promise((resolve) => {
    const shell = process.platform === 'win32' ? 'cmd.exe' : '/bin/sh';
    const shellArgs = process.platform === 'win32' ? ['/c', cmd] : ['-c', cmd];
    const child = execFile(
      shell,
      shellArgs,
      { cwd, timeout: timeoutMs, maxBuffer: 16 * 1024 * 1024, windowsHide: true },
      (err, stdout, stderr) => {
        const tail = `${stdout}\n${stderr}`.slice(-4000);
        resolve({
          name: cmd,
          ok: !err,
          code: child.exitCode,
          durationMs: Date.now() - t0,
          tail,
        });
      }
    );
    signal?.addEventListener('abort', () => child.kill('SIGKILL'), { once: true });
  });
}

/**
 * Apply a validated worktree's commit onto the live branch. This is the only
 * function that mutates the caller's active branch; the chat-relay adapter
 * marks the operation `dangerous` so policy gates it.
 */
export function applyToLive(opts: {
  repoPath: string;
  taskId: string;
  baseCommit: string;
  strategy?: 'cherry-pick' | 'merge-ff';
}): { applied: boolean; head: string; detail: string } {
  const { repoPath, taskId } = opts;
  const branch = `chinvat/relay-${safeToken(taskId)}`;
  const liveHead = git(repoPath, ['rev-parse', 'HEAD']);
  if (liveHead !== opts.baseCommit)
    return {
      applied: false,
      head: liveHead,
      detail: `live HEAD ${liveHead.slice(0, 12)} has moved off packet base ${opts.baseCommit.slice(0, 12)} — rebase the relay branch or re-run the task`,
    };
  try {
    const relayHead = git(repoPath, ['rev-parse', branch]);
    git(repoPath, ['cherry-pick', '--no-commit', relayHead]);
    git(repoPath, ['-c', 'user.email=relay@chinvat.local', '-c', 'user.name=chinvat-relay', 'commit', '-m', `relay ${taskId} (validated)`]);
    return { applied: true, head: git(repoPath, ['rev-parse', 'HEAD']), detail: `applied ${branch}` };
  } catch (e) {
    try {
      git(repoPath, ['cherry-pick', '--abort']);
    } catch {
      /* nothing to abort */
    }
    return { applied: false, head: liveHead, detail: `apply failed, aborted cleanly: ${e instanceof Error ? e.message : e}` };
  }
}

/** Remove the disposable worktree and its branch. */
export function cleanup(repoPath: string, taskId: string): void {
  const branch = `chinvat/relay-${safeToken(taskId)}`;
  const worktree = path.join(os.tmpdir(), 'chinvat-relay', `wt-${safeToken(taskId)}`);
  try {
    if (fs.existsSync(worktree)) git(repoPath, ['worktree', 'remove', '--force', worktree]);
  } catch {
    fs.rmSync(worktree, { recursive: true, force: true });
  }
  try {
    git(repoPath, ['branch', '-D', branch]);
  } catch {
    /* branch may not exist */
  }
}
