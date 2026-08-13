import { createInterface } from 'node:readline/promises';
import { stdin as input, stdout as output } from 'node:process';
import path from 'node:path';
import { NConvertAdapter } from './nconvert-adapter.mjs';
import { createPresetMap, getPreset, PRESETS } from './presets.mjs';
import { loadProjectConfig } from './project-config.mjs';
import { executeRun, prepareRun } from './processor.mjs';

export async function runCli(argv) {
  const options = parseArguments(argv);
  if (options.help) {
    printHelp();
    return;
  }

  const backend = new NConvertAdapter({ executable: options.nconvert });
  if (options.preset) {
    if (!options.folder) throw new Error('Use --in <folder> with --preset');
    const context = await resolvePresetContext({ folder: options.folder, configPath: options.config });
    await backend.assertAvailable();
    await runSelection({
      folder: options.folder,
      preset: getPreset(options.preset, context.presets),
      presets: context.presets,
      provenance: context.provenance,
      backend,
      assumeYes: options.yes,
    });
    return;
  }
  await interactiveLoop(options.folder, backend, { configPath: options.config });
}

export async function resolvePresetContext({ folder, configPath } = {}) {
  const loaded = await loadProjectConfig({
    configPath,
    startDirectory: folder ? path.resolve(folder) : process.cwd(),
  });
  if (!loaded) {
    return {
      presets: PRESETS,
      provenance: {
        configPath: null,
        configSha256: null,
        configSchemaVersion: null,
        minimumProcessorVersion: null,
      },
    };
  }

  const minimumProcessorVersion = loaded.config.minimum_processor_version ?? null;
  return {
    presets: createPresetMap(loaded.config.presets),
    provenance: {
      configPath: loaded.path,
      configSha256: loaded.sha256,
      configSchemaVersion: loaded.config.schema_version,
      minimumProcessorVersion,
    },
  };
}

async function interactiveLoop(initialFolder, backend, { configPath } = {}) {
  const terminal = createInterface({ input, output });
  let folder = initialFolder ? path.resolve(initialFolder) : null;
  let backendVerified = false;
  try {
    while (true) {
      if (!folder) folder = path.resolve(await terminal.question('Folder: '));
      const context = await resolvePresetContext({ folder, configPath });
      // Fail fast, as the pre-portability CLI did: an operator should learn that the
      // backend is missing before choosing a preset, not after.
      if (!backendVerified) {
        await backend.assertAvailable();
        backendVerified = true;
      }
      const presets = [...context.presets.values()];
      const changeFolderChoice = presets.length + 1;
      console.log(`\nVI Media Processor\n\nFolder: ${folder}`);
      printConfiguration(context.provenance);
      console.log('');
      for (const [index, preset] of presets.entries()) {
        console.log(`${index + 1}. ${preset.label} (${preset.id})`);
      }
      console.log(`${changeFolderChoice}. Change folder\n0. Exit`);
      const answer = (await terminal.question('\n> ')).trim();
      if (answer === '0') return;
      if (answer === String(changeFolderChoice)) {
        folder = path.resolve(await terminal.question('Folder: '));
        continue;
      }
      const selection = Number(answer);
      const preset = Number.isInteger(selection) ? presets[selection - 1] : null;
      if (!preset) {
        console.log(`Choose 0-${changeFolderChoice}.`);
        continue;
      }
      await runSelection({ folder, preset, presets: context.presets, provenance: context.provenance, backend, terminal });
    }
  } finally {
    terminal.close();
  }
}

async function runSelection({ folder, preset, presets, provenance, backend, terminal, assumeYes = false }) {
  const plan = await prepareRun({ folder, preset, presets, provenance, backend });
  const ready = plan.entries.filter((entry) => entry.status === 'ready');
  const skipped = plan.entries.filter((entry) => entry.status === 'skipped');
  const failed = plan.entries.filter((entry) => entry.status === 'failed');
  const example = ready[0] ?? plan.entries[0];
  console.log(`\nPreset: ${preset.label} (${preset.id})`);
  console.log(`Target: ${preset.width}x${preset.height}`);
  console.log(`Mode: ${preset.mode} / ${preset.anchor}`);
  console.log(`Format: ${preset.format.toUpperCase()} / quality ${preset.quality}`);
  console.log(`Upscale: no / too-small: ${preset.onTooSmall}`);
  console.log(`Metadata: ${preset.metadata} after orientation/color handling`);
  printConfiguration(plan.provenance);
  console.log(`\nFound: ${plan.entries.length}\nProcessable: ${ready.length}\nSkipped: ${skipped.length}\nFailed preflight: ${failed.length}`);
  if (example) console.log(`\nExample: ${example.name} -> ${example.outputName}`);
  console.log('\nSource files will not be modified.');
  if (!ready.length) {
    console.log('Nothing to process.');
    return;
  }

  let approved = assumeYes;
  if (!approved) {
    if (!terminal) {
      const confirmation = createInterface({ input, output });
      try {
        approved = !/^n(?:o)?$/i.test((await confirmation.question('\nRun? [Y/n] ')).trim());
      } finally {
        confirmation.close();
      }
    } else {
      approved = !/^n(?:o)?$/i.test((await terminal.question('\nRun? [Y/n] ')).trim());
    }
  }
  if (!approved) {
    console.log('Cancelled.');
    return;
  }

  const result = await executeRun(plan, backend);
  const counts = countStatuses(result.records);
  console.log(`\nProcessed: ${counts.ok ?? 0}\nSkipped: ${counts.skipped ?? 0}\nFailed: ${counts.failed ?? 0}`);
  console.log(`\nOutput: ${plan.outputDirectory}\nRun record: ${result.recordPath}`);
  if (counts.failed) process.exitCode = 2;
}

export function parseArguments(argv) {
  const options = {
    folder: null,
    preset: null,
    config: null,
    yes: false,
    help: false,
    nconvert: process.env.NCONVERT_PATH || 'nconvert',
  };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--help' || argument === '-h') options.help = true;
    else if (argument === '--yes' || argument === '-y') options.yes = true;
    else if (argument === '--preset') options.preset = requireValue(argv, ++index, '--preset');
    else if (argument === '--in') options.folder = requireValue(argv, ++index, '--in');
    else if (argument === '--config') options.config = requireValue(argv, ++index, '--config');
    else if (argument === '--nconvert') options.nconvert = requireValue(argv, ++index, '--nconvert');
    else if (argument.startsWith('-')) throw new Error(`Unknown option: ${argument}`);
    else if (!options.folder) options.folder = argument;
    else throw new Error(`Unexpected argument: ${argument}`);
  }
  return options;
}

function requireValue(argv, index, option) {
  const value = argv[index];
  if (!value || value.startsWith('-')) throw new Error(`${option} requires a value`);
  return value;
}

function countStatuses(records) {
  return records.reduce((counts, record) => {
    counts[record.status] = (counts[record.status] ?? 0) + 1;
    return counts;
  }, {});
}

function printConfiguration(provenance) {
  if (!provenance.configPath) {
    console.log('Config: built-in processor presets');
    return;
  }
  console.log(`Config: ${provenance.configPath}`);
  console.log(`Config SHA-256: ${provenance.configSha256}`);
  console.log(`Minimum processor: ${provenance.minimumProcessorVersion ?? 'none'}`);
}

function printHelp() {
  console.log(`VI Dumb Media Processor\n\nUsage:\n  vi-media [folder]\n  vi-media --preset <id> --in <folder> [--yes]\n\nOptions:\n  --preset <id>       Project or built-in pre…12863 tokens truncated…, orientation: 'Top Left', components: 3, metadata: null };
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
