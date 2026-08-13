import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { parseArguments, resolvePresetContext } from '../src/cli.mjs';
import { CONFIG_FILE_NAME } from '../src/project-config.mjs';
import { getPreset, PRESETS } from '../src/presets.mjs';
import { PROCESSOR_VERSION } from '../src/version.mjs';

function config(overrides = {}, presetOverrides = {}) {
  return {
    schema_version: 1,
    minimum_processor_version: '0.2.0',
    presets: [{
      id: 'SITE_CARD', label: 'Site card', version: 3, suffix: 'CARD',
      width: 800, height: 600, mode: 'cover', anchor: 'center', upscale: false,
      onTooSmall: 'skip', format: 'webp', quality: 82, colorspace: 'srgb',
      metadata: 'strip', alpha: 'preserve', background: '#FFFFFF',
      ...presetOverrides,
    }],
    ...overrides,
  };
}

async function project(contents = config(), name = CONFIG_FILE_NAME) {
  const root = await mkdtemp(path.join(tmpdir(), 'vi-media-context-'));
  const input = path.join(root, 'assets', 'incoming');
  await mkdir(input, { recursive: true });
  const filePath = path.join(root, name);
  await writeFile(filePath, JSON.stringify(contents, null, 2), 'utf8');
  return { root, input, filePath };
}

test('built-in presets are used only when no project config is discoverable', async () => {
  const bare = await mkdtemp(path.join(tmpdir(), 'vi-media-context-bare-'));
  const context = await resolvePresetContext({ folder: bare });
  assert.equal(context.presets, PRESETS);
  assert.deepEqual(context.provenance, {
    configPath: null, configSha256: null, configSchemaVersion: null, minimumProcessorVersion: null,
  });
  assert.ok(getPreset('WP_HERO', context.presets));
});

test('a discovered project config fully replaces the built-in preset set', async () => {
  const { input, filePath } = await project();
  const context = await resolvePresetContext({ folder: input });

  assert.deepEqual([...context.presets.keys()], ['SITE_CARD']);
  assert.equal(context.provenance.configPath, filePath);
  assert.match(context.provenance.configSha256, /^[a-f0-9]{64}$/);
  assert.equal(context.provenance.configSchemaVersion, 1);
  assert.equal(context.provenance.minimumProcessorVersion, '0.2.0');
  assert.throws(() => getPreset('WP_HERO', context.presets), /Unknown preset: WP_HERO/);
});

test('an explicit --config outranks a config that discovery would have found', async () => {
  const discovered = await project(config({}, { id: 'SITE_DISCOVERED', suffix: 'DISC' }));
  const explicit = await project(config({}, { id: 'SITE_EXPLICIT', suffix: 'EXPL' }), 'other.config.json');

  const context = await resolvePresetContext({ folder: discovered.input, configPath: explicit.filePath });
  assert.deepEqual([...context.presets.keys()], ['SITE_EXPLICIT']);
  assert.equal(context.provenance.configPath, explicit.filePath);

  const withoutExplicit = await resolvePresetContext({ folder: discovered.input });
  assert.deepEqual([...withoutExplicit.presets.keys()], ['SITE_DISCOVERED']);
});

test('a missing or invalid explicit --config fails closed and never silently falls back', async () => {
  const discovered = await project();
  const missing = path.join(discovered.root, 'absent.config.json');
  await assert.rejects(
    resolvePresetContext({ folder: discovered.input, configPath: missing }),
    /Invalid project config: could not read .*ENOENT/,
  );

  const broken = path.join(discovered.root, 'broken.config.json');
  await writeFile(broken, '{ "schema_version": 1, ', 'utf8');
  await assert.rejects(
    resolvePresetContext({ folder: discovered.input, configPath: broken }),
    /Invalid project config: valid JSON is required/,
  );
});

test('an unsupported schema version or an unmet minimum processor version stops the run', async () => {
  const future = await project(config({ schema_version: 2 }));
  await assert.rejects(resolvePresetContext({ folder: future.input }), /schema_version must be 1/);

  const demanding = await project(config({ minimum_processor_version: '99.0.0' }));
  await assert.rejects(
    resolvePresetContext({ folder: demanding.input }),
    new RegExp(`requires processor >= 99\\.0\\.0; current processor is ${PROCESSOR_VERSION.replace(/\./g, '\\.')}`),
  );

  const range = await project(config({ minimum_processor_version: '^0.2.0' }));
  await assert.rejects(resolvePresetContext({ folder: range.input }), /minimum_processor_version must be a semantic version/);
});

test('a config without a minimum requirement records null rather than inventing one', async () => {
  const contents = config();
  delete contents.minimum_processor_version;
  const { input } = await project(contents);
  const context = await resolvePresetContext({ folder: input });
  assert.equal(context.provenance.minimumProcessorVersion, null);
});

test('the pre-portability CLI surface still parses unchanged and --config is additive', () => {
  assert.deepEqual(parseArguments(['D:\\Brand\\Images']).folder, 'D:\\Brand\\Images');
  const legacy = parseArguments(['--preset', 'WP_HERO', '--in', 'D:\\Brand\\Images', '--yes']);
  assert.equal(legacy.preset, 'WP_HERO');
  assert.equal(legacy.folder, 'D:\\Brand\\Images');
  assert.equal(legacy.yes, true);
  assert.equal(legacy.config, null);
  assert.equal(parseArguments(['--nconvert', 'C:\\Tools\\nconvert.exe']).nconvert, 'C:\\Tools\\nconvert.exe');
  assert.equal(parseArguments(['-h']).help, true);

  assert.equal(parseArguments(['--config', '.\\vi-media.config.json']).config, '.\\vi-media.config.json');
  assert.throws(() => parseArguments(['--config']), /--config requires a value/);
  assert.throws(() => parseArguments(['--config', '--yes']), /--config requires a value/);
  assert.throws(() => parseArguments(['--unknown']), /Unknown option: --unknown/);
});
