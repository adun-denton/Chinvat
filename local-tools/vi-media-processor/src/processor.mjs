import { createHash, randomUUID } from 'node:crypto';
import { constants as fsConstants } from 'node:fs';
import { createReadStream } from 'node:fs';
import { access, copyFile, mkdir, open, rm, stat } from 'node:fs/promises';
import path from 'node:path';
import { PRESETS } from './presets.mjs';
import { PROCESSOR_VERSION } from './version.mjs';
import { createGeometryPlan } from './geometry.mjs';
import { detectOutputCollisions, discoverInputs } from './discovery.mjs';

export async function prepareRun({ folder, preset, backend, presets = PRESETS, provenance = {} }) {
  const sourceFolder = path.resolve(folder);
  const folderStats = await stat(sourceFolder);
  if (!folderStats.isDirectory()) throw new Error(`Input is not a folder: ${sourceFolder}`);

  const outputDirectory = path.join(sourceFolder, 'processed', preset.id);
  // Derivative exclusion follows the active preset set only. Once a project config
  // is loaded it owns that repository's modification codes; built-in codes must not
  // leak in and silently exclude a legitimate source file.
  const knownSuffixes = new Set([...presets.values()].map((item) => item.suffix));
  const discovered = await discoverInputs(sourceFolder, knownSuffixes);
  const collisions = detectOutputCollisions(discovered, preset, outputDirectory);
  if (collisions.length) {
    const details = collisions.map((group) => group.map((item) => item.name).join(', ')).join('; ');
    throw new Error(`Output filename collision: ${details}`);
  }

  const entries = [];
  for (const item of discovered) {
    const outputName = `${item.stem}_${preset.suffix}.${preset.format}`;
    const outputPath = path.join(outputDirectory, outputName);
    const base = { ...item, outputName, outputPath };
    if (item.knownDerivative) {
      entries.push({ ...base, status: 'skipped', reason: 'known_derivative' });
      continue;
    }
    if (await exists(outputPath)) {
      entries.push({ ...base, status: 'skipped', reason: 'output_exists' });
      continue;
    }
    try {
      const info = await backend.inspect(item.sourcePath);
      if (info.pages !== 1) {
        entries.push({ ...base, info, status: 'skipped', reason: 'animated_or_multipage' });
        continue;
      }
      const geometry = createGeometryPlan(info, preset);
      if (!geometry.processable) {
        entries.push({ ...base, info, geometry, status: 'skipped', reason: geometry.reason });
        continue;
      }
      entries.push({ ...base, info, geometry, sourceHash: await sha256(item.sourcePath), status: 'ready' });
    } catch (error) {
      entries.push({ ...base, status: 'failed', reason: 'unreadable_input', error: error.message });
    }
  }

  return { sourceFolder, outputDirectory, preset, entries, provenance: normalizeProvenance(provenance) };
}

export async function executeRun(plan, backend) {
  await mkdir(plan.outputDirectory, { recursive: true });
  const backendVersion = await backend.version();
  const runId = randomUUID();
  const startedAt = new Date().toISOString();
  const records = [];

  for (const [entryIndex, entry] of plan.entries.entries()) {
    if (entry.status !== 'ready') {
      records.push(toRecord(entry, plan.preset, { backendVersion, runId, provenance: plan.provenance }));
      continue;
    }

    // Bounded length: a long stem must not push the staging path past the Windows
    // MAX_PATH limit that the final output name would still have fitted under.
    const temporaryPath = path.join(
      plan.outputDirectory,
      `.tmp-${runId.slice(0, 8)}-${entryIndex}.${plan.preset.format}`,
    );
    const itemStarted = Date.now();
    try {
      if (await exists(entry.outputPath)) throw new SkipError('output_exists');
      await backend.convert({
        sourcePath: entry.sourcePath,
        temporaryPath,
        preset: plan.preset,
        geometry: entry.geometry,
      });
      const outputInfo = await backend.inspect(temporaryPath);
      validateOutput(outputInfo, entry.geometry.output);
      if (await sha256(entry.sourcePath) !== entry.sourceHash) {
        throw new Error('Source changed during processing');
      }
      try {
        await copyFile(temporaryPath, entry.outputPath, fsConstants.COPYFILE_EXCL);
      } catch (error) {
        if (error.code === 'EEXIST') throw new SkipError('output_exists_race');
        throw error;
      }
      await rm(temporaryPath, { force: true });
      const outputStats = await stat(entry.outputPath);
      records.push(toRecord(entry, plan.preset, {
        status: 'ok',
        backendVersion,
        runId,
        provenance: plan.provenance,
        outputInfo,
        outputBytes: outputStats.size,
        elapsedMs: Date.now() - itemStarted,
      }));
    } catch (error) {
      await rm(temporaryPath, { force: true });
      records.push(toRecord(entry, plan.preset, {
        status: error instanceof SkipError ? 'skipped' : 'failed',
        reason: error instanceof SkipError ? error.message : 'processing_error',
        error: error instanceof SkipError ? undefined : error.message,
        backendVersion,
        runId,
        provenance: plan.provenance,
        elapsedMs: Date.now() - itemStarted,
      }));
    }
  }

  const recordPath = path.join(plan.outputDirectory, `run-${timestampForFile(startedAt)}-${runId.slice(0, 8)}.jsonl`);
  const handle = await open(recordPath, 'wx');
  try {
    await handle.writeFile(`${records.map((record) => JSON.stringify(record)).join('\n')}\n`, 'utf8');
  } finally {
    await handle.close();
  }
  return { runId, startedAt, records, recordPath };
}

function toRecord(entry, preset, overrides = {}) {
  const status = overrides.status ?? entry.status;
  return compact({
    run_id: overrides.runId,
    source: entry.name,
    output: entry.outputName,
    preset: preset.id,
    preset_version: preset.version,
    modification_code: preset.suffix,
    input_dimensions: entry.geometry ? [entry.geometry.input.width, entry.geometry.input.height] : undefined,
    output_dimensions: overrides.outputInfo
      ? [overrides.outputInfo.width, overrides.outputInfo.height]
      : entry.geometry?.output ? [entry.geometry.output.width, entry.geometry.output.height] : undefined,
    source_sha256: entry.sourceHash,
    output_bytes: overrides.outputBytes,
    status,
    reason: overrides.reason ?? entry.reason,
    error: overrides.error ?? entry.error,
    warnings: [],
    backend: 'nconvert',
    backend_version: overrides.backendVersion,
    processor_version: PROCESSOR_VERSION,
    config_source: overrides.provenance?.configSource ?? 'built_in',
    config_path: overrides.provenance?.configPath ?? null,
    config_sha256: overrides.provenance?.configSha256 ?? null,
    config_schema_version: overrides.provenance?.configSchemaVersion ?? null,
    minimum_processor_version: overrides.provenance?.minimumProcessorVersion ?? null,
    elapsed_ms: overrides.elapsedMs,
  });
}

function normalizeProvenance(provenance) {
  const configPath = provenance.configPath ?? null;
  return {
    configSource: configPath ? 'project' : 'built_in',
    configPath,
    configSha256: provenance.configSha256 ?? null,
    configSchemaVersion: provenance.configSchemaVersion ?? null,
    minimumProcessorVersion: provenance.minimumProcessorVersion ?? null,
  };
}

function validateOutput(info, expected) {
  if (info.pages !== 1) throw new Error('Derivative is animated or multipage');
  if (info.width !== expected.width || info.height !== expected.height) {
    throw new Error(`Derivative dimensions ${info.width}x${info.height} do not match ${expected.width}x${expected.height}`);
  }
  if (String(info.orientation).toLowerCase() !== 'top left') {
    throw new Error(`Derivative orientation is not normalized: ${info.orientation}`);
  }
  if (info.metadata) throw new Error(`Derivative still contains metadata: ${info.metadata}`);
}

function sha256(filePath) {
  return new Promise((resolve, reject) => {
    const hash = createHash('sha256');
    const input = createReadStream(filePath);
    input.on('error', reject);
    input.on('data', (chunk) => hash.update(chunk));
    input.on('end', () => resolve(hash.digest('hex')));
  });
}

async function exists(filePath) {
  try {
    await access(filePath);
    return true;
  } catch (error) {
    if (error.code === 'ENOENT') return false;
    throw error;
  }
}

function compact(value) {
  return Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined));
}

function timestampForFile(iso) {
  return iso.replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');
}

class SkipError extends Error {}
