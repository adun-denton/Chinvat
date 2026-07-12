import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { resolveClaudeDesktop, looksLikeClaudeAppDir } from '../connect.js';

const home = 'C:\\Users\\Ehsan';
const localAppData = 'C:\\Users\\Ehsan\\AppData\\Local';
const appData = 'C:\\Users\\Ehsan\\AppData\\Roaming';

test('claude desktop: MSIX (Store) build resolves the virtualized LocalCache path', () => {
  const r = resolveClaudeDesktop({
    platform: 'win32',
    home,
    localAppData,
    appData,
    listPackages: () => ['SomethingElse_abc', 'Claude_pzs8sxrjxfjjc', 'Microsoft.Whatever'],
  });
  assert.equal(r.flavor, 'msix');
  assert.ok(r.dir.includes('Claude_pzs8sxrjxfjjc'), r.dir);
  assert.ok(r.dir.endsWith(path.join('LocalCache', 'Roaming', 'Claude')), r.dir);
});

test('claude desktop: classic install falls back to %APPDATA%\\Claude', () => {
  const r = resolveClaudeDesktop({ platform: 'win32', home, localAppData, appData, listPackages: () => [] });
  assert.equal(r.flavor, 'classic');
  assert.ok(r.dir.startsWith(appData), r.dir);
  assert.ok(r.dir.endsWith(path.join('Claude')), r.dir);
  assert.ok(!r.dir.includes('Packages'), r.dir);
});

test('claude desktop: prefers a Claude_ package over a mere claude substring; matches lowercase', () => {
  const r = resolveClaudeDesktop({ platform: 'win32', home, localAppData, listPackages: () => ['AnthropicClaudeHelper', 'Claude_new'] });
  assert.equal(r.flavor, 'msix');
  assert.ok(r.dir.includes('Claude_new'), r.dir);
  const lower = resolveClaudeDesktop({ platform: 'win32', home, localAppData, listPackages: () => ['claude_only'] });
  assert.equal(lower.flavor, 'msix');
  assert.ok(lower.dir.includes('claude_only'), lower.dir);
});

test('claude desktop: mac and linux paths', () => {
  const mac = resolveClaudeDesktop({ platform: 'darwin', home: '/Users/e' });
  assert.equal(mac.flavor, 'mac');
  assert.ok(mac.dir.includes(path.join('Application Support', 'Claude')));
  const lin = resolveClaudeDesktop({ platform: 'linux', home: '/home/e' });
  assert.equal(lin.flavor, 'linux');
  assert.ok(lin.dir.endsWith(path.join('.config', 'Claude')));
});

test('looksLikeClaudeAppDir: true only when app artifacts are present', () => {
  const withLogs = (p: string) => p === '/claude' || p === path.join('/claude', 'logs');
  assert.equal(looksLikeClaudeAppDir('/claude', withLogs), true);
  const onlyDir = (p: string) => p === '/claude'; // dir exists but no artifacts (e.g. only our file)
  assert.equal(looksLikeClaudeAppDir('/claude', onlyDir), false);
  const missing = () => false;
  assert.equal(looksLikeClaudeAppDir('/claude', missing), false);
});
