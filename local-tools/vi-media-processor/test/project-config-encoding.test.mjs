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

async function scratch() {
  return mkdtemp(path.join(tmpdir(), 'vi-media-encoding-'));
}

test('a UTF-8 BOM written by a Windows editor is tolerated and does not change the hash contract', async () => {
  const folder = await scratch();
  const filePath = path.join(folder, CONFIG_FILE_NAME);
  const body = JSON.stringify(config(), null, 2);
  await writeFile(filePath, Buffer.concat([Buffer.from([0xEF, 0xBB, 0xBF]), Buffer.from(body, 'utf8')]));

  const loaded = await loadProjectConfig({ configPath: filePath });
  assert.deepEqual(loaded.config, config());

  // The digest covers the raw bytes on disk, BOM included, so provenance stays exact.
  const plainFolder = await scratch();
  const plainPath = path.join(plainFolder, CONFIG_FILE_NAME);
  await writeFile(plainPath, body, 'utf8');
  const plain = await loadProjectConfig({ configPath: plainPath });
  assert.notEqual(loaded.sha256, plain.sha256);
});

test('UTF-16 and NUL-bearing config files are refused with an actionable message', async () => {
  const folder = await scratch();
  const body = JSON.stringify(config(), null, 2);

  const utf16le = path.join(folder, 'utf16le.json');
  await writeFile(utf16le, Buffer.concat([Buffer.from([0xFF, 0xFE]), Buffer.from(body, 'utf16le')]));
  await assert.rejects(loadProjectConfig({ configPath: utf16le }), /UTF-16 encoded; save it as UTF-8/);

  const utf16be = path.join(folder, 'utf16be.json');
  await writeFile(utf16be, Buffer.concat([Buffer.from([0xFE, 0xFF]), Buffer.from(body, 'utf16le')]));
  await assert.rejects(loadProjectConfig({ configPath: utf16be }), /UTF-16 encoded; save it as UTF-8/);

  const bomless = path.join(folder, 'bomless-utf16.json');
  await writeFile(bomless, Buffer.from(body, 'utf16le'));
  await assert.rejects(loadProjectConfig({ configPath: bomless }), /contains NUL bytes; save it as UTF-8 text/);
});

test('non-UTF-8 bytes are refused instead of being silently replaced', async () => {
  const folder = await scratch();
  const filePath = path.join(folder, 'legacy-codepage.json');
  const withLabel = JSON.stringify(config({
    presets: [{ ...config().presets[0], label: 'PLACEHOLDER' }],
  }), null, 2);
  const bytes = Buffer.from(withLabel, 'utf8');
  const marker = bytes.indexOf(Buffer.from('PLACEHOLDER', 'utf8'));
  // A single Windows-1256 byte where UTF-8 expects a lead byte.
  bytes[marker] = 0xD9;
  await writeFile(filePath, bytes);
  await assert.rejects(loadProjectConfig({ configPath: filePath }), /is not valid UTF-8/);
});

test('an empty or non-object config fails closed with a project-config error, never a raw TypeError', async () => {
  const folder = await scratch();
  const empty = path.join(folder, 'empty.json');
  await writeFile(empty, '');
  await assert.rejects(loadProjectConfig({ configPath: empty }), /Invalid project config: valid JSON is required/);

  for (const value of [undefined, null, 42, 'text', [], true]) {
    assert.throws(
      () => validateProjectConfig(value),
      (error) => error instanceof Error
        && !(error instanceof TypeError)
        && /Invalid project config: top level must be a plain object/.test(error.message),
      `expected a project-config error for ${String(value)}`,
    );
  }
});

test('a directory named like the config fails closed on both the explicit and discovered path', async () => {
  const folder = await scratch();
  const asDirectory = path.join(folder, CONFIG_FILE_NAME);
  await mkdir(asDirectory);
  await assert.rejects(loadProjectConfig({ configPath: asDirectory }), /path is not a regular file/);
  await assert.rejects(discoverProjectConfig(folder), /path is not a regular file/);
});

test('discovery and hashing survive spaces and non-Latin characters in the path', async () => {
  const root = await scratch();
  const nested = path.join(root, 'وب سایت', 'assets', 'incoming media');
  await mkdir(nested, { recursive: true });
  const filePath = path.join(root, 'وب سایت', CONFIG_FILE_NAME);
  await writeFile(filePath, JSON.stringify(config(), null, 2), 'utf8');

  assert.equal(await discoverProjectConfig(nested), filePath);
  const loaded = await loadProjectConfig({ startDirectory: nested });
  assert.equal(loaded.path, filePath);
  assert.match(loaded.sha256, /^[a-f0-9]{64}$/);
});

test('the upward walk terminates at the filesystem root instead of looping', async () => {
  const unreachable = path.join(path.parse(tmpdir()).root, 'vi-media-absent-directory-xyz');
  assert.equal(await discoverProjectConfig(unreachable), null);
});
