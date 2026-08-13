import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { createPresetMap, getPreset } from '../src/presets.mjs';
import { executeRun, prepareRun } from '../src/processor.mjs';

class FakeBackend {
  constructor(info = {}) {
    this.info = info;
    this.converted = [];
  }
  async version() { return 'test'; }
  async inspect(filePath) {
    if (path.basename(filePath).startsWith('.tmp-')) return { width: this.expected.width, height: this.expected.height, pages: 1, orientation: 'Top Left', components: 3, metadata: null };
    const value = this.info[path.basename(filePath)];
    if (value instanceof Error) throw value;
    return value ?? { width: 3000, height: 2000, pages: 1, orientation: 'Top Left', components: 3, metadata: null };
  }
  async convert(request) {
    this.expected = request.geometry.output;
    this.converted.push(request);
    await writeFile(request.temporaryPath, `derivative:${path.basename(request.sourcePath)}`);
  }
}

test('processing preserves sources, names derivatives, excludes outputs, and records every image', async () => {
  const folder = await mkdtemp(path.join(tmpdir(), 'vi-media-'));
  await writeFile(path.join(folder, 'photo one.jpg'), 'source-one');
  await writeFile(path.join(folder, 'عکس.png'), 'source-two');
  await writeFile(path.join(folder, 'old_HERO.webp'), 'old-derivative');
  await writeFile(path.join(folder, 'notes.txt'), 'ignored');
  await mkdir(path.join(folder, 'nested'));
  await writeFile(path.join(folder, 'nested', 'nested.jpg'), 'must-not-process');
  const before = await digest(path.join(folder, 'photo one.jpg'));
  const backend = new FakeBackend();
  const plan = await prepareRun({ folder, preset: getPreset('WP_GALLERY'), backend });
  const result = await executeRun(plan, backend);

  assert.equal(await digest(path.join(folder, 'photo one.jpg')), before);
  assert.equal(backend.converted.length, 2);
  assert.equal(await readFile(path.join(folder, 'processed', 'WP_GALLERY', 'photo one_GAL.webp'), 'utf8'), 'derivative:photo one.jpg');
  assert.equal(result.records.length, 3);
  assert.equal(result.records.find((record) => record.source === 'old_HERO.webp').reason, 'known_derivative');
  assert.ok(result.records.every((record) => !('caption' in record) && !('alt_text' in record)));
  assert.ok(result.records.every((record) => record.config_source === 'built_in' && record.config_path === null));
});

test('existing output, animation, corrupt input, and undersized cover fail safely', async () => {
  const folder = await mkdtemp(path.join(tmpdir(), 'vi-media-'));
  for (const name of ['exists.jpg', 'animated.gif', 'corrupt.jpg', 'small.png']) await writeFile(path.join(folder, name), name);
  const output = path.join(folder, 'processed', 'WP_HERO');
  await mkdir(output, { recursive: true });
  await writeFile(path.join(output, 'exists_HERO.webp'), 'keep-me');
  const backend = new FakeBackend({
    'animated.gif': { width: 3000, height: 2000, pages: 4, orientation: 'Top Left', components: 3, metadata: null },
    'corrupt.jpg': new Error('decode failed'),
    'small.png': { width: 800, height: 800, pages: 1, orientation: 'Top Left', components: 4, metadata: null },
  });
  const plan = await prepareRun({ folder, preset: getPreset('WP_HERO'), backend });
  const byName = Object.fromEntries(plan.entries.map((entry) => [entry.name, entry]));
  assert.equal(byName['exists.jpg'].reason, 'output_exists');
  assert.equal(byName['animated.gif'].reason, 'animated_or_multipage');
  assert.equal(byName['corrupt.jpg'].status, 'failed');
  assert.equal(byName['small.png'].reason, 'too_small');
  assert.equal(await readFile(path.join(output, 'exists_HERO.webp'), 'utf8'), 'keep-me');
});

test('same stems are refused instead of ambiguously disambiguated', async () => {
  const folder = await mkdtemp(path.join(tmpdir(), 'vi-media-'));
  await writeFile(path.join(folder, 'same.jpg'), 'one');
  await writeFile(path.join(folder, 'same.png'), 'two');
  await assert.rejects(
    prepareRun({ folder, preset: getPreset('WP_GALLERY'), backend: new FakeBackend() }),
    /Output filename collision: same\.jpg, same\.png/i,
  );
});

test('project-owned config provenance is recorded for every outcome', async () => {
  const folder = await mkdtemp(path.join(tmpdir(), 'vi-media-'));
  await writeFile(path.join(folder, 'card.jpg'), 'source');
  const presets = createPresetMap([{
    ...getPreset('WP_THUMB'), id: 'SITE_CARD', label: 'Site card', version: 3, suffix: 'CARD',
  }]);
  const plan = await prepareRun({
    folder,
    preset: getPreset('SITE_CARD', presets),
    presets,
    backend: new FakeBackend(),
    provenance: {
      configPath: 'C:\\website\\vi-media.config.json',
      configSha256: 'a'.repeat(64),
      configSchemaVersion: 1,
      minimumProcessorVersion: '0.2.0',
    },
  });
  const result = await executeRun(plan, new FakeBackend());
  const record = result.records[0];

  assert.equal(record.config_source, 'project');
  assert.equal(record.config_path, 'C:\\website\\vi-media.config.json');
  assert.equal(record.config_sha256, 'a'.repeat(64));
  assert.equal(record.config_schema_version, 1);
  assert.equal(record.minimum_processor_version, '0.2.0');
  assert.equal(record.processor_version, '0.2.0');
});

async function digest(filePath) {
  return createHash('sha256').update(await readFile(filePath)).digest('hex');
}
