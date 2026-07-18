import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import systemAdapter, { repairedEnv } from '../adapters/system.js';
import type { AdapterContext } from '../types.js';

function ctx(): AdapterContext {
  return {
    config: {},
    dataDir: os.tmpdir(),
    saveArtifact: async () => 'artifact',
    log: () => undefined,
  };
}

test(
  'repairedEnv restores executable extensions and ComSpec from a stripped launcher env (win32)',
  { skip: process.platform !== 'win32' },
  () => {
    // Reproduces the TASK-CHINVAT-005 incident environment: PathEXT=.CPL, no ComSpec.
    const env = repairedEnv({ PathEXT: '.CPL', SYSTEMROOT: 'C:\\WINDOWS', PATH: 'C:\\WINDOWS\\system32' });
    assert.match(String(env.PATHEXT), /(^|;)\.EXE(;|$)/i, 'PATHEXT must include .EXE');
    assert.equal('PathEXT' in env, false, 'broken mixed-case key must be removed');
    assert.match(String(env.ComSpec), /cmd\.exe$/i);
    // A healthy env passes through untouched.
    const good = repairedEnv({ PATHEXT: '.COM;.EXE;.BAT;.CMD', ComSpec: 'C:\\WINDOWS\\System32\\cmd.exe' });
    assert.equal(good.PATHEXT, '.COM;.EXE;.BAT;.CMD');
  }
);

test('repairedEnv is a non-mutating copy on posix', { skip: process.platform === 'win32' }, () => {
  const base = { PATH: '/usr/bin' };
  const env = repairedEnv(base);
  assert.deepEqual(env, base);
  assert.notEqual(env, base);
});

test('run_command executes an external binary: captured stdout AND verified filesystem side effect', async () => {
  // TASK-CHINVAT-005 regression: exit code 0 alone is untrustworthy; require
  // read-back evidence that the child actually ran.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'chinvat-spawn-'));
  const evidence = path.join(dir, 'evidence.txt').replace(/\\/g, '/');
  const command = `node -e "require('fs').writeFileSync('${evidence}','spawn-evidence');console.log('spawn-stdout')"`;
  try {
    const res = await systemAdapter.invoke('run_command', { command, timeout_sec: 60 }, ctx());
    const out = res.output as { stdout: string; stderr: string; exit_code: number };
    assert.equal(out.exit_code, 0, `stderr: ${out.stderr}`);
    assert.match(out.stdout, /spawn-stdout/, 'child stdout must be captured, not discarded');
    assert.equal(
      fs.readFileSync(evidence.replace(/\//g, path.sep), 'utf8'),
      'spawn-evidence',
      'child must leave verifiable filesystem evidence'
    );
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('health fails closed when the spawn probe returns no evidence', async () => {
  // Structural check: health() must report ok only alongside spawn verification.
  const status = await systemAdapter.health(ctx());
  assert.equal(status.ok, true);
  assert.match(status.detail ?? '', /spawn verified/);
});
