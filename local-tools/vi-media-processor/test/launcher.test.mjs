import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

test('Windows launcher invokes the checked-in CLI without npm link', { skip: process.platform !== 'win32' }, async () => {
  const toolRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const result = await run(path.join(toolRoot, 'vi-media.cmd'), ['--help']);
  assert.equal(result.code, 0, result.output);
  assert.match(result.output, /VI Dumb Media Processor/);
  assert.match(result.output, /--config|--preset/);
});

function run(command, args) {
  return new Promise((resolve, reject) => {
    // Invoke the batch file through cmd's CALL form so paths containing spaces are
    // preserved without Node's deprecated `shell: true` argument concatenation.
    const child = spawn(process.env.ComSpec ?? 'cmd.exe', ['/d', '/c', 'call', command, ...args], {
      windowsHide: true,
    });
    let output = '';
    child.stdout.on('data', (chunk) => { output += chunk; });
    child.stderr.on('data', (chunk) => { output += chunk; });
    child.on('error', reject);
    child.on('close', (code) => resolve({ code: code ?? 1, output }));
  });
}
