import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { parseArguments, resolvePresetContext } from '../src/cli.mjs';
import { CONFIG_FILE_NAME } from '../src/project-config.mjs';

function projectConfig(minimumProcessorVersion = '0.2.0') {
  return {
    schema_version: 1,
    minimum_processor_version: minimumProcessorVersion,
    presets: [{
      id: 'SITE_CARD', label: 'Site card', version: 2, suffix: 'CARD',
      width: 800, height: 800, mode: 'cover', anchor: 'center', upscale: false,
      onTooSmall: 'skip', format: 'webp', quality: 82, colorspace: 'srgb',
      metadata: 'strip', alpha: 'preserve', background: '#FFFFFF',
    }],
  };
}

test('CLI accepts an explicit project config while preserving existing arguments', () => {
  assert.deepEqual(parseArguments(['--preset', 'SITE_CARD', '--in', 'images', '--config', 'vi-media.config.json', '--yes']), {
    folder: 'images', preset: 'SITE_CARD', config: 'vi-media.config.json', yes: true, help: false,
    nconvert: process.env.NCONVERT_PATH || 'nconvert',
  });
  assert.equal(parseArguments(['images']).folder, 'images');
  assert.throws(() => parseArguments(['--config']), /--config requires a value/);
});

test('project config overrides built-ins and contributes stable provenance', async () => {
  const folder = await mkdtemp(path.join(tmpdir(), 'vi-media-cli-'));
  const configPath = path.join(folder, CONFIG_FILE_NAME);
  await writeFile(configPath, JSON.stringify(projectConfig(), null, 2));
  const context = await resolvePresetContext({ folder });

  assert.deepEqual([...context.presets.keys()], ['SITE_CARD']);
  assert.equal(context.provenance.configPath, configPath);
  assert.match(context.provenance.configSha256, /^[a-f0-9]{64}$/);
  assert.equal(context.provenance.minimumProcessorVersion, '0.2.0');
});

test('incompatible project minimum prevents processing before backend use', async () => {
  const folder = await mkdtemp(path.join(tmpdir(), 'vi-media-cli-'));
  await writeFile(path.join(folder, CONFIG_FILE_NAME), JSON.stringify(projectConfig('0.3.0')));
  await assert.rejects(resolvePresetContext({ folder }), /requires processor >= 0\.3\.0/);
});
