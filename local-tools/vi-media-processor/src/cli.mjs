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
  console.log(`VI Dumb Media Processor\n\nUsage:\n  vi-media [folder]\n  vi-media --preset <id> --in <folder> [--yes]\n\nOptions:\n  --preset <id>       Project or built-in preset ID\n  --in <folder>       Top-level source folder\n  --config <path>     Exact project config; otherwise discover upward from input folder\n  --nconvert <path>   NConvert executable (or set NCONVERT_PATH)\n  --yes, -y           Run without confirmation\n  --help, -h          Show this help`);
  console.log(`\nBuilt-in fallback presets: ${[...PRESETS.keys()].join(', ')}`);
}
