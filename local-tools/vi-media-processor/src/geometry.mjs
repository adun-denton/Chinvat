const SWAPPED_ORIENTATIONS = new Set(['right top', 'right bottom', 'left bottom', 'left top']);

export function orientedDimensions(info) {
  const orientation = String(info.orientation ?? '').toLowerCase();
  return SWAPPED_ORIENTATIONS.has(orientation)
    ? { width: info.height, height: info.width }
    : { width: info.width, height: info.height };
}

export function createGeometryPlan(info, preset) {
  const input = orientedDimensions(info);
  if (preset.mode === 'cover') {
    const scale = Math.max(preset.width / input.width, preset.height / input.height);
    if (!preset.upscale && scale > 1) {
      return { processable: false, reason: 'too_small', input, output: null };
    }
    return {
      processable: true,
      input,
      output: { width: preset.width, height: preset.height },
      orientation: info.orientation,
      resize: { mode: 'cover', width: preset.width, height: preset.height, anchor: preset.anchor },
    };
  }

  const scale = Math.min(preset.width / input.width, preset.height / input.height, preset.upscale ? Infinity : 1);
  const output = {
    width: Math.max(1, Math.round(input.width * scale)),
    height: Math.max(1, Math.round(input.height * scale)),
  };
  return {
    processable: true,
    input,
    output,
    orientation: info.orientation,
    resize: { mode: 'fit', width: output.width, height: output.height, anchor: preset.anchor },
  };
}
