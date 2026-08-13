import { createInterface } from 'node:readline/promises';
import { stdin as input, stdout as output } from 'node:process';
import path from 'node:path';
import { NConvertAdapter } from './nconvert-adapter.mjs';
import { PRESETS, getPreset } from './presets.mjs';
import { executeRun, prepareRun } from './processor.mjs';

export async function runCli(argv) {
  const options = parseArguments(argv);
  if (options.help) {
    printHelp();
    return;
  }
  const backend = new NConvertAdapter({ executable: options.nconvert });
  await backend.assertAvailable();

  if (options.preset) {
    if (!options.folder) throw new Error('Use --in <folder> with --preset');
    await runSelection({ folder: options.folder, preset: getPreset(options.preset), backend, assumeYes: options.yes });
    return;
  }
  await interactiveLoop(options.folder, backend);
}

async function interactiveLoop(initialFolder, backend) {
  const terminal = createInterface({ input, output });
  let folder = initialFolder ? path.resolve(initialFolder) : null;
  try {
    while (true) {
      if (!folder) folder = path.resolve(await terminal.question('Folder: '));
      console.log(`\nVI Media Processor\n\nFolder: ${folder}\n`);
      console.log('1. WP Hero\n2. WP Gallery\n3. WP Thumbnail\n4. Change folder\n0. Exit');
      const answer = (await terminal.question('\n> ')).trim();
      if (answer === '0') return;
      if (answer === '4') {
        folder = path.resolve(await terminal.question('Folder: '));
        continue;
      }
      const presetId = { 1: 'WP_HERO', 2: 'WP_GALLERY', 3: 'WP_THUMB' }[answer];
      if (!presetId) {
        console.log('Choose 0–4.');
        continue;
      }
      await runSelection({ folder, preset: getPreset(presetId), backend, terminal });
    }
  } finally {
    terminal.close();
  }
}

async function runSelection({ folder, preset, backend, terminal, assumeYes = false }) {
  const plan = await prepareRun({ folder, preset, backend });
  const ready = plan.entries.filter((entry) => entry.status === 'ready');
  const skipped = plan.entries.filter((entry) => entry.status === 'skipped');
  const failed = plan.entries.filter((entry) => entry.status === 'failed');
  const example = ready[0] ?? plan.entries[0];
  console.log(`\nPreset: ${preset.label}`);
  console.log(`Target: ${preset.width}x${preset.height}`);
  console.log(`Mode: ${preset.mode} / ${preset.anchor}`);
  console.log(`Format: ${preset.format.toUpperCase()} / quality ${preset.quality}`);
  console.log(`Upscale: no / too-small: ${preset.onTooSmall}`);
  console.log(`Metadata: ${preset.metadata} after orientation/color handling`);
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
  const options = { folder: null, preset: null, yes: false, help: false, nconvert: process.env.NCONVERT_PATH || 'nconvert' };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--help' || argument === '-h') options.help = true;
    else if (argument === '--yes' || argument === '-y') options.yes = true;
    else if (argument === '--preset') options.preset = requireValue(argv, ++index, '--preset');
    else if (argument === '--in') options.folder = requireValue(argv, ++index, '--in');
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

function printHelp() {
  console.log(`VI Dumb Media Processor\n\nUsage:\n  vi-media [folder]\n  vi-media --preset WP_HERO --in <folder> [--yes]\n\nOptions:\n  --preset <id>       WP_HERO, WP_GALLERY, or WP_THUMB\n  --in <folder>       Top-level source folder\n  --nconvert <path>   NConvert executable (or set NCONVERT_PATH)\n  --yes, -y           Run without confirmation\n  --help, -h          Show this help`);
  console.log(`\nPresets: ${[...PRESETS.keys()].join(', ')}`);
}
