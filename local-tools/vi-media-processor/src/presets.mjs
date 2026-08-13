const presetList = [
  {
    id: 'WP_HERO',
    label: 'WP Hero',
    version: 1,
    suffix: 'HERO',
    width: 1920,
    height: 800,
    mode: 'cover',
    anchor: 'center',
    upscale: false,
    onTooSmall: 'skip',
    format: 'webp',
    quality: 82,
    colorspace: 'srgb',
    metadata: 'strip',
    alpha: 'preserve',
    background: '#FFFFFF',
  },
  {
    id: 'WP_GALLERY',
    label: 'WP Gallery',
    version: 1,
    suffix: 'GAL',
    width: 1600,
    height: 1600,
    mode: 'fit',
    anchor: 'center',
    upscale: false,
    onTooSmall: 'output_smaller',
    format: 'webp',
    quality: 82,
    colorspace: 'srgb',
    metadata: 'strip',
    alpha: 'preserve',
    background: '#FFFFFF',
  },
  {
    id: 'WP_THUMB',
    label: 'WP Thumbnail',
    version: 1,
    suffix: 'THUMB',
    width: 600,
    height: 600,
    mode: 'cover',
    anchor: 'center',
    upscale: false,
    onTooSmall: 'skip',
    format: 'webp',
    quality: 82,
    colorspace: 'srgb',
    metadata: 'strip',
    alpha: 'preserve',
    background: '#FFFFFF',
  },
];

export const PRESETS = createPresetMap(presetList);

export function getPreset(id, presets = PRESETS) {
  const normalized = String(id ?? '').trim().toUpperCase();
  const preset = presets.get(normalized);
  if (!preset) throw new Error(`Unknown preset: ${id}`);
  return preset;
}

export function validatePreset(preset) {
  if (!preset || typeof preset !== 'object' || Array.isArray(preset)) throw new Error('Invalid preset');
  if (!/^[A-Z0-9_]{2,32}$/.test(preset.id)) throw new Error(`Invalid preset id: ${preset.id}`);
  if (typeof preset.label !== 'string' || !preset.label.trim() || preset.label.length > 80) throw new Error('Invalid preset label');
  if (!Number.isInteger(preset.version) || preset.version < 1) throw new Error('Invalid preset version');
  if (!/^[A-Z0-9_]{2,32}$/.test(preset.suffix)) throw new Error(`Invalid suffix: ${preset.suffix}`);
  if (!Number.isInteger(preset.width) || preset.width < 1) throw new Error('Invalid preset width');
  if (!Number.isInteger(preset.height) || preset.height < 1) throw new Error('Invalid preset height');
  if (!['cover', 'fit'].includes(preset.mode)) throw new Error(`Unsupported mode: ${preset.mode}`);
  if (preset.anchor !== 'center') throw new Error(`Unsupported anchor: ${preset.anchor}`);
  if (preset.upscale !== false) throw new Error('MVP presets must not upscale');
  if (!['skip', 'output_smaller'].includes(preset.onTooSmall)) throw new Error(`Unsupported too-small policy: ${preset.onTooSmall}`);
  if (preset.format !== 'webp') throw new Error(`Unsupported MVP format: ${preset.format}`);
  if (!Number.isInteger(preset.quality) || preset.quality < 1 || preset.quality > 100) throw new Error('Invalid preset quality');
  if (preset.colorspace !== 'srgb') throw new Error(`Unsupported colorspace: ${preset.colorspace}`);
  if (preset.metadata !== 'strip') throw new Error(`Unsupported metadata policy: ${preset.metadata}`);
  if (preset.alpha !== 'preserve') throw new Error(`Unsupported alpha policy: ${preset.alpha}`);
  if (!/^#[0-9A-F]{6}$/i.test(preset.background)) throw new Error(`Invalid background: ${preset.background}`);
}

export function createPresetMap(presets) {
  if (!Array.isArray(presets) || !presets.length) throw new Error('At least one preset is required');
  const values = new Map();
  const suffixes = new Set();
  for (const preset of presets) {
    validatePreset(preset);
    const id = preset.id.toUpperCase();
    const suffix = preset.suffix.toUpperCase();
    if (values.has(id)) throw new Error(`Duplicate preset id: ${preset.id}`);
    if (suffixes.has(suffix)) throw new Error(`Duplicate preset suffix: ${preset.suffix}`);
    values.set(id, Object.freeze({ ...preset }));
    suffixes.add(suffix);
  }
  return values;
}
