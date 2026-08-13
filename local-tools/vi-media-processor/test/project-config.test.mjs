import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  CONFIG_FILE_NAME,
  CONFIG_SCHEMA_VERSION,
  discoverProjectConfig,
  loadProjectConfig,
  validateProjectConfig,
} from '../src/project-config.mjs';

function config(overrides = {}) {
  return {
    schema_version: CONFIG_SCHEMA_VERSION,
    minimum_processor_version: '0.2.0',
    presets: [{
      id: 'SITE_HERO', label: 'Site hero', version: 1, suffix: 'HERO',
      width: 1920, height: 800, mode: 'cover', anchor: 'center', upscale: false,
      onTooSmall: 'skip', format: 'webp', quality: 82, colorspace: 'srgb',
      metadata: 'strip', alpha: 'preserve', background: '#FFFFFF',
    }],
    ...overrides,
  };
}

async function writeConfig(directory, contents = config()) {
  const filePath = path.join(directory, CONFIG_FILE_NAME);
  await writeFile(filePath, JSON.stringify(contents, null, 2));
  return filePath;
}

test('loads and validates a strict, compatible project config', async () => {
  const folder = await mkdtemp(path.join(tmpdir(), 'vi-media-config-'));
  const filePath = await writeConfig(folder);
  const loaded = await loadProjectConfig({ configPath: filePath });

  assert.equal(loaded.path, filePath);
  assert.match(loaded.sha256, /^[a-f0-9]{64}$/);
  assert.deepEqual(loaded.config, config());
});

test('rejects unknown and prototype-ish config keys', () => {
  assert.throws(() => validateProjectConfig(config({ unknown: true })), /Invalid project config: top level has unsupported key: unknown/);
  assert.throws(() => validateProjectConfig(JSON.parse('{"schema_version":1,"presets":[],"__proto__":{}}')), /Invalid project config: top level has unsupported key: __proto__/);
  assert.throws(() => validateProjectConfig(config({ presets: [{ ...config().presets[0], unexpected: true }] })), /Invalid project config: presets\[0\] has unsupported key: unexpected/);
});

test('rejects invalid modification suffixes and duplicate ids or suffixes', () => {
  assert.throws(() => validateProjectConfig(config({ presets: [{ ...config().presets[0], suffix: 'hero-x' }] })), /Invalid project config: presets\[0\].suffix/);
  const duplicateId = [{ ...config().presets[0] }, { ...config().presets[0], suffix: 'CARD' }];
  assert.throws(() => validateProjectConfig(config({ presets: duplicateId })), /duplicate preset id/);
  const duplicateSuffix = [{ ...config().presets[0] }, { ...config().presets[0], id: 'SITE_CARD', suffix: 'HERO' }];
  assert.throws(() => validateProjectConfig(config({ presets: duplicateSuffix })), /duplicate preset suffix/);
});

test('requires usable presets and a strict semantic minimum version', () => {
  assert.throws(() => validateProjectConfig(config({ presets: [] })), /presets must be a nonempty array/);
  assert.throws(() => validateProjectConfig(config({ minimum_processor_version: '^0.2.0' })), /minimum_processor_version must be a semantic version/);
});

test('discovers the nearest config while walking parent directories', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'vi-media-config-'));
  const nested = path.join(root, 'site', 'assets', 'incoming');
  await mkdir(nested, { recursive: true });
  const rootConfig = await writeConfig(root, config({ minimum_processor_version: '0.1.0' }));
  const site = path.join(root, 'site');
  const nearestConfig = await writeConfig(site, config({ minimum_processor_version: '0.2.0' }));
  const inputFile = path.join(nested, 'image.jpg');
  await writeFile(inputFile, 'image');

  assert.equal(await discoverProjectConfig(nested), nearestConfig);
  assert.equal((await loadProjectConfig({ startDirectory: inputFile })).path, nearestConfig);
  assert.notEqual(rootConfig, nearestConfig);
});

test('an explicit path is exact and never falls back to discovered config', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'vi-media-config-'));
  const nested = path.join(root, 'nested');
  await mkdir(nested);
  await writeConfig(root);
  const missing = path.join(nested, 'other.json');

  await assert.rejects(loadProjectConfig({ configPath: missing, startDirectory: nested }), /Invalid project config: could not read .*ENOENT/);
  assert.equal(await loadProjectConfig({ startDirectory: path.join(tmpdir(), 'no-config-here') }), null);
});

test('config hash reflects file content changes', async () => {
  const folder = await mkdtemp(path.join(tmpdir(), 'vi-media-config-'));
  const filePath = await writeConfig(folder);
  const before = (await loadProjectConfig({ configPath: filePath })).sha256;
  const changed = config();
  changed.presets[0].label = 'Changed label';
  await writeConfig(folder, changed);
  const after = (await loadProjectConfig({ configPath: filePath })).sha256;
  assert.notEqual(before, after);
});
