import { readdir } from 'node:fs/promises';
import path from 'node:path';

export const INPUT_EXTENSIONS = new Set(['.jpg', '.jpeg', '.png', '.tif', '.tiff', '.bmp', '.gif', '.webp']);

export async function discoverInputs(folder, knownSuffixes) {
  const entries = await readdir(folder, { withFileTypes: true });
  const suffixPattern = new RegExp(`_(?:${[...knownSuffixes].map(escapeRegex).join('|')})$`, 'i');
  const discovered = [];

  for (const entry of entries) {
    if (!entry.isFile()) continue;
    const extension = path.extname(entry.name).toLowerCase();
    if (!INPUT_EXTENSIONS.has(extension)) continue;
    const stem = path.basename(entry.name, extension);
    discovered.push({
      name: entry.name,
      stem,
      extension,
      sourcePath: path.join(folder, entry.name),
      knownDerivative: suffixPattern.test(stem),
    });
  }

  return discovered.sort((left, right) => left.name.localeCompare(right.name, undefined, { sensitivity: 'base' }));
}

export function detectOutputCollisions(items, preset, outputDirectory) {
  const byOutput = new Map();
  for (const item of items) {
    if (item.knownDerivative) continue;
    const outputName = `${item.stem}_${preset.suffix}.${preset.format}`;
    const outputPath = path.join(outputDirectory, outputName);
    const key = outputPath.toLocaleLowerCase('en-US');
    const group = byOutput.get(key) ?? [];
    group.push({ ...item, outputName, outputPath });
    byOutput.set(key, group);
  }
  return [...byOutput.values()].filter((group) => group.length > 1);
}

function escapeRegex(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
