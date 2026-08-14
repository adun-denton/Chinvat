import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { compareDiscoveredNames, discoverInputs } from '../src/discovery.mjs';
import { createPresetMap, getPreset } from '../src/presets.mjs';
import { executeRun, prepareRun } from '../src/processor.mjs';
import { PROCESSOR_VERSION } from '../src/version.mjs';

const PROJECT_PRESETS = createPresetMap([{
  id: 'SITE_CARD', label: 'Site card', version: 3, suffix: 'CARD',
  width: 800, height: 600, mode: 'cover', anchor: 'center', upscale: false,
  onTooSmall: 'skip', format: 'webp', quality: 82, colorspace: 'srgb',
  metadata: 'strip', alpha: 'preserve', background: '#FFFFFF',
}]);

const PROVENANCE = {
  configPath: 'D:\\Sites\\brand\\vi-media.config.json',
  configSha256: 'a'.repeat(64),
  configSchemaVersion: 1,
  minimumProcessorVersion: '0.2.0',
};

class FakeBackend {
  constructor() { this.converted = []; }
  async version() { return 'test'; }
  async inspect(filePath) {
    if (path.basename(filePath).startsWith('.tmp-')) {
      return { width: this.expected.width, height: this.expected.height, pages: 1, orientation: 'Top Left', components: 3, metadata: null };
    }
    return { width: 3000, height: 2000, pages: 1, orientation: 'Top Left', components: 3, metadata: null };
  }
  async convert(request) {
    this.expected = request.geometry.output;
    this.converted.push(request);
    await writeFile(request.temporaryPath, 'derivative');
  }
}

async function folderWith(names) {
  const folder = await mkdtemp(path.join(tmpdir(), 'vi-media-portability-'));
  for (const name of names) await writeFile(path.join(folder, name), name);
  return folder;
}

test('every run record carries the config provenance the operator was shown', async () => {
  const folder = await folderWith(['product.jpg']);
  const backend = new FakeBackend();
  const plan = await prepareRun({
    folder, preset: PROJECT_PRESETS.get('SITE_CARD'), presets: PROJECT_PRESETS, provenance: PROVENANCE, backend,
  });
  const result = await executeRun(plan, backend);
  const written = (await readFile(result.recordPath, 'utf8')).trim().split('\n').map((line) => JSON.parse(line));

  assert.equal(written.length, 1);
  for (const record of written) {
    assert.equal(record.status, 'ok');
    assert.equal(record.processor_version, PROCESSOR_VERSION);
    assert.equal(record.config_source, 'project');
    assert.equal(record.config_path, PROVENANCE.configPath);
    assert.equal(record.config_sha256, PROVENANCE.configSha256);
    assert.equal(record.config_schema_version, 1);
    assert.equal(record.minimum_processor_version, '0.2.0');
    assert.equal(record.preset, 'SITE_CARD');
    assert.equal(record.preset_version, 3);
    assert.equal(record.modification_code, 'CARD');
  }
});

test('a run without a project config is recorded as built_in, not as a null project config', async () => {
  const folder = await folderWith(['product.jpg']);
  const backend = new FakeBackend();
  const plan = await prepareRun({ folder, preset: getPreset('WP_GALLERY'), backend });
  const [record] = (await executeRun(plan, backend)).records;

  assert.equal(record.config_source, 'built_in');
  assert.equal(record.config_path, null);
  assert.equal(record.config_sha256, null);
  assert.equal(record.config_schema_version, null);
  assert.equal(record.minimum_processor_version, null);
  assert.equal(record.processor_version, PROCESSOR_VERSION);
});

test('skipped and failed entries carry the same provenance as processed entries', async () => {
  const folder = await folderWith(['product.jpg', 'legacy_CARD.jpg']);
  const backend = new FakeBackend();
  const plan = await prepareRun({
    folder, preset: PROJECT_PRESETS.get('SITE_CARD'), presets: PROJECT_PRESETS, provenance: PROVENANCE, backend,
  });
  const { records } = await executeRun(plan, backend);
  assert.equal(records.length, 2);
  assert.ok(records.some((record) => record.reason === 'known_derivative'));
  assert.ok(records.every((record) => record.config_sha256 === PROVENANCE.configSha256));
});

test('built-in modification codes do not exclude sources once a project config owns the codes', async () => {
  const folder = await folderWith(['banner_THUMB.jpg', 'hero_HERO.png', 'legacy_CARD.jpg', 'plain.jpg']);
  const backend = new FakeBackend();
  const plan = await prepareRun({
    folder, preset: PROJECT_PRESETS.get('SITE_CARD'), presets: PROJECT_PRESETS, provenance: PROVENANCE, backend,
  });
  const byName = Object.fromEntries(plan.entries.map((entry) => [entry.name, entry]));

  assert.equal(byName['legacy_CARD.jpg'].reason, 'known_derivative');
  assert.equal(byName['banner_THUMB.jpg'].status, 'ready');
  assert.equal(byName['hero_HERO.png'].status, 'ready');
  assert.equal(byName['plain.jpg'].status, 'ready');
});

test('the built-in run still excludes built-in modification codes', async () => {
  const folder = await folderWith(['banner_THUMB.jpg', 'plain.jpg']);
  const plan = await prepareRun({ folder, preset: getPreset('WP_GALLERY'), backend: new FakeBackend() });
  const byName = Object.fromEntries(plan.entries.map((entry) => [entry.name, entry]));
  assert.equal(byName['banner_THUMB.jpg'].reason, 'known_derivative');
  assert.equal(byName['plain.jpg'].status, 'ready');
});

test('discovery order is a stable total order that does not depend on the host locale', async () => {
  // Use names that remain distinct on case-insensitive Windows filesystems.
  const folder = await folderWith(['B.jpg', 'ä.jpg', 'a.jpg']);
  const order = (await discoverInputs(folder, new Set(['HERO']))).map((item) => item.name);
  assert.deepEqual(order, ['a.jpg', 'ä.jpg', 'B.jpg']);

  const names = ['A.jpg', 'a.jpg', 'Ä.jpg', 'ä.jpg', 'B.jpg', 'b.jpg', 'image.JPG', 'image.jpg'];
  for (const left of names) {
    for (const right of names) {
      const comparison = compareDiscoveredNames({ name: left }, { name: right });
      if (left === right) assert.equal(comparison, 0, `${left} vs ${right}`);
      else assert.notEqual(comparison, 0, `${left} vs ${right} must not tie`);
      const reverse = compareDiscoveredNames({ name: right }, { name: left });
      assert.equal(Math.sign(comparison) + Math.sign(reverse), 0, `${left} vs ${right} must be antisymmetric`);
    }
  }
});

test('the staging file name stays short enough for a long stem on Windows', async () => {
  const stem = 'p'.repeat(160);
  const folder = await folderWith([`${stem}.jpg`]);
  const backend = new FakeBackend();
  const plan = await prepareRun({
    folder, preset: PROJECT_PRESETS.get('SITE_CARD'), presets: PROJECT_PRESETS, provenance: PROVENANCE, backend,
  });
  await executeRun(plan, backend);

  const [request] = backend.converted;
  const temporaryName = path.basename(request.temporaryPath);
  assert.match(temporaryName, /^\.tmp-[0-9a-f]{8}-\d+\.webp$/);
  assert.ok(
    temporaryName.length <= path.basename(request.sourcePath).length,
    `staging name ${temporaryName.length} must not exceed the source name ${path.basename(request.sourcePath).length}`,
  );
});

test('the recorded processor version matches the published package version', async () => {
  const packagePath = fileURLToPath(new URL('../package.json', import.meta.url));
  const manifest = JSON.parse(await readFile(packagePath, 'utf8'));
  assert.equal(manifest.version, PROCESSOR_VERSION);
});
