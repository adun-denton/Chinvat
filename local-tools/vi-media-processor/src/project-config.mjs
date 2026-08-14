import { createHash } from 'node:crypto';
import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { assertMinimumVersion, parseSemver } from './semver.mjs';
import { PROCESSOR_VERSION } from './version.mjs';

export const CONFIG_FILE_NAME = 'vi-media.config.json';
export const CONFIG_SCHEMA_VERSION = 1;

const TOP_LEVEL_KEYS = new Set(['schema_version', 'minimum_processor_version', 'presets']);
const PRESET_KEYS = new Set([
  'id', 'label', 'version', 'suffix', 'width', 'height', 'mode', 'anchor',
  'upscale', 'onTooSmall', 'format', 'quality', 'colorspace', 'metadata',
  'alpha', 'background',
]);
const PROTOTYPE_KEYS = new Set(['__proto__', 'constructor', 'prototype']);
const IDENTIFIER = /^[A-Z0-9_]{2,32}$/;
const BACKGROUND = /^#[0-9A-Fa-f]{6}$/;

export async function loadProjectConfig({ configPath, startDirectory = process.cwd() } = {}) {
  const filePath = configPath === undefined || configPath === null
    ? await discoverProjectConfig(startDirectory)
    : path.resolve(configPath);

  if (!filePath) return null;
  let contents;
  try {
    const fileStats = await stat(filePath);
    if (!fileStats.isFile()) throw invalid(`path is not a regular file: ${filePath}`);
    contents = await readFile(filePath);
  } catch (error) {
    if (error.message?.startsWith('Invalid project config:')) throw error;
    throw invalid(`could not read ${filePath} (${error.code ?? error.message})`);
  }
  const text = decodeConfigText(contents, filePath);
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    throw invalid(`valid JSON is required (${error.message})`);
  }
  const config = validateProjectConfig(parsed);
  if (config.minimum_processor_version) {
    assertMinimumVersion(PROCESSOR_VERSION, config.minimum_processor_version);
  }
  return {
    path: filePath,
    sha256: sha256Buffer(contents),
    config,
  };
}

export async function discoverProjectConfig(startDirectory = process.cwd()) {
  const resolvedStart = path.resolve(startDirectory);
  let current = resolvedStart;
  try {
    if ((await stat(resolvedStart)).isFile()) current = path.dirname(resolvedStart);
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
  }

  while (true) {
    const candidate = path.join(current, CONFIG_FILE_NAME);
    try {
      const candidateStats = await stat(candidate);
      if (!candidateStats.isFile()) throw invalid(`path is not a regular file: ${candidate}`);
      return candidate;
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
    }
    const parent = path.dirname(current);
    if (parent === current) return null;
    current = parent;
  }
}

export function validateProjectConfig(config) {
  assertPlainObject(config, 'top level');
  assertKnownKeys(config, TOP_LEVEL_KEYS, 'top level');
  if (config.schema_version !== CONFIG_SCHEMA_VERSION) {
    throw invalid(`schema_version must be ${CONFIG_SCHEMA_VERSION}`);
  }
  if ('minimum_processor_version' in config) {
    if (typeof config.minimum_processor_version !== 'string') throw invalid('minimum_processor_version must be a string');
    try {
      parseSemver(config.minimum_processor_version);
    } catch (error) {
      throw invalid(`minimum_processor_version must be a semantic version (${error.message})`);
    }
  }
  if (!Array.isArray(config.presets) || !config.presets.length) throw invalid('presets must be a nonempty array');

  const ids = new Set();
  const suffixes = new Set();
  for (const [index, preset] of config.presets.entries()) {
    validatePreset(preset, index);
    const id = preset.id.toUpperCase();
    const suffix = preset.suffix.toUpperCase();
    if (ids.has(id)) throw invalid(`duplicate preset id: ${preset.id}`);
    if (suffixes.has(suffix)) throw invalid(`duplicate preset suffix: ${preset.suffix}`);
    ids.add(id);
    suffixes.add(suffix);
  }
  return config;
}

export async function sha256File(filePath) {
  return sha256Buffer(await readFile(filePath));
}

function validatePreset(preset, index) {
  const location = `presets[${index}]`;
  assertPlainObject(preset, location);
  assertKnownKeys(preset, PRESET_KEYS, location);
  for (const key of PRESET_KEYS) {
    if (!(key in preset)) throw invalid(`${location}.${key} is required`);
  }
  if (typeof preset.id !== 'string' || !IDENTIFIER.test(preset.id)) throw invalid(`${location}.id must match ${IDENTIFIER}`);
  if (typeof preset.label !== 'string' || !preset.label.trim() || preset.label.length > 80) throw invalid(`${location}.label must be nonempty and at most 80 characters`);
  if (!positiveInteger(preset.version)) throw invalid(`${location}.version must be a positive integer`);
  if (typeof preset.suffix !== 'string' || !IDENTIFIER.test(preset.suffix)) throw invalid(`${location}.suffix must match ${IDENTIFIER}`);
  for (const key of ['width', 'height']) {
    if (!positiveInteger(preset[key]) || preset[key] > 16384) throw invalid(`${location}.${key} must be a positive integer no greater than 16384`);
  }
  if (!['cover', 'fit'].includes(preset.mode)) throw invalid(`${location}.mode must be cover or fit`);
  if (preset.anchor !== 'center') throw invalid(`${location}.anchor must be center`);
  if (preset.upscale !== false) throw invalid(`${location}.upscale must be false`);
  if (!['skip', 'output_smaller'].includes(preset.onTooSmall)) throw invalid(`${location}.onTooSmall must be skip or output_smaller`);
  if (preset.format !== 'webp') throw invalid(`${location}.format must be webp`);
  if (!Number.isInteger(preset.quality) || preset.quality < 1 || preset.quality > 100) throw invalid(`${location}.quality must be an integer from 1 to 100`);
  if (preset.colorspace !== 'srgb') throw invalid(`${location}.colorspace must be srgb`);
  if (preset.metadata !== 'strip') throw invalid(`${location}.metadata must be strip`);
  if (preset.alpha !== 'preserve') throw invalid(`${location}.alpha must be preserve`);
  if (typeof preset.background !== 'string' || !BACKGROUND.test(preset.background)) throw invalid(`${location}.background must be #RRGGBB`);
}

function assertPlainObject(value, location) {
  if (
    value === null
    || value === undefined
    || typeof value !== 'object'
    || Array.isArray(value)
    || Object.getPrototypeOf(value) !== Object.prototype
  ) {
    throw invalid(`${location} must be a plain object`);
  }
}

// Windows editors routinely emit a UTF-8 BOM or a UTF-16 file. The SHA-256 is taken
// over the raw bytes, so tolerating a BOM here does not weaken provenance; every
// other encoding is refused with an actionable message instead of a JSON error.
function decodeConfigText(contents, filePath) {
  if (contents.length >= 2) {
    const utf16le = contents[0] === 0xFF && contents[1] === 0xFE;
    const utf16be = contents[0] === 0xFE && contents[1] === 0xFF;
    if (utf16le || utf16be) throw invalid(`${filePath} is UTF-16 encoded; save it as UTF-8`);
  }
  const body = contents.length >= 3 && contents[0] === 0xEF && contents[1] === 0xBB && contents[2] === 0xBF
    ? contents.subarray(3)
    : contents;
  if (body.includes(0x00)) throw invalid(`${filePath} contains NUL bytes; save it as UTF-8 text`);
  const text = body.toString('utf8');
  if (text.includes('\uFFFD')) throw invalid(`${filePath} is not valid UTF-8`);
  return text;
}

function assertKnownKeys(value, knownKeys, location) {
  for (const key of Object.keys(value)) {
    if (PROTOTYPE_KEYS.has(key) || !knownKeys.has(key)) throw invalid(`${location} has unsupported key: ${key}`);
  }
}

function positiveInteger(value) {
  return Number.isInteger(value) && value > 0;
}

function sha256Buffer(value) {
  return createHash('sha256').update(value).digest('hex');
}

function invalid(message) {
  return new Error(`Invalid project config: ${message}`);
}
