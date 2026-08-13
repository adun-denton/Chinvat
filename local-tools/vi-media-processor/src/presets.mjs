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

export const PRESETS = new Map(presetList.map((preset) => [preset.id, Object.freeze(preset)]));

export function getPreset(id) {
  const normalized = String(id ?? '').trim().toUpperCase();
  const preset = PRESETS.get(normalized);
  if (!preset) throw new Error(`Unknown preset: ${id}`);
  return preset;
}

export function validatePreset(preset) {
  if (!/^[A-Z0-9_]{2,32}$/.test(preset.id)) throw new Error(`Invalid preset id: ${preset.id}`);
  if (!/^[A-Z0-9_]{2,32}$/.test(preset.suffix)) throw new Error(`Invalid suffix: ${preset.suffix}`);
  if (!Number.isInteger(preset.width) || preset.width < 1) throw new Error('Invalid preset width');
  if (!Number.isInteger(preset.height) || preset.height < 1) throw new Error('Invalid preset height');
  if (!['cover', 'fit'].includes(preset.mode)) throw new Error(`Unsupported mode: ${preset.mode}`);
  if (preset.anchor !== 'center') throw new Error(`Unsupported anchor: ${preset.anchor}`);
  if (preset.upscale !== false) throw new Error('MVP presets must not upscale');
  if (preset.format !== 'webp') throw new Error(`Unsupported MVP format: ${preset.format}`);
}

for (const preset of PRESETS.values()) validatePreset(preset);
