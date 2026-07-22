import { test } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { fenceRoots } from '../adapters/system.js';

// fenceRoots is the pure core of the fence; test it directly (guard() wraps it
// with path.resolve + containment, exercised via the resolution semantics).
// Expected values go through path.resolve() so assertions hold on both POSIX
// and Windows (where '/x' resolves to '<drive>:\\x').

test('defaults to home directory when nothing configured', () => {
  assert.deepEqual(fenceRoots({}), [path.resolve(os.homedir())]);
});

test('legacy allowedRoot (single string) still works', () => {
  const r = fenceRoots({ allowedRoot: '/tmp/one' });
  assert.deepEqual(r, [path.resolve('/tmp/one')]);
});

test('allowedRoots as an array yields multiple roots', () => {
  const r = fenceRoots({ allowedRoots: ['/tmp/a', '/tmp/b'] });
  assert.deepEqual(r, [path.resolve('/tmp/a'), path.resolve('/tmp/b')]);
});

test('allowedRoots as a semicolon/comma string is split', () => {
  const r = fenceRoots({ allowedRoots: '/tmp/a; /tmp/b , /tmp/c' });
  assert.deepEqual(r, [path.resolve('/tmp/a'), path.resolve('/tmp/b'), path.resolve('/tmp/c')]);
});

test('allowedRoots overrides legacy allowedRoot when both set', () => {
  const r = fenceRoots({ allowedRoot: '/tmp/legacy', allowedRoots: '/tmp/new' });
  assert.deepEqual(r, [path.resolve('/tmp/new')]);
});

test('trailing separators are stripped so drive/dir roots contain correctly', () => {
  // Proxy for the Windows "C:\\" drive-root bug: a root given with a trailing
  // separator must resolve WITHOUT one, so containment of children holds.
  const roots = fenceRoots({ allowedRoots: '/data/' });
  const expected = path.resolve('/data');
  assert.deepEqual(roots, [expected]);
  assert.equal(expected.endsWith(path.sep), false);
  const child = path.resolve(expected, 'projects/x');
  assert.equal(child === expected || child.startsWith(expected + path.sep), true);
});

test('duplicate roots are de-duped', () => {
  const r = fenceRoots({ allowedRoots: '/tmp/a;/tmp/a' });
  assert.deepEqual(r, [path.resolve('/tmp/a')]);
});
