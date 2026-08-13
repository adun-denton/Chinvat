import { access } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import path from 'node:path';

export class NConvertAdapter {
  constructor({ executable = process.env.NCONVERT_PATH || 'nconvert', run = runProcess } = {}) {
    this.executable = executable;
    this.run = run;
    this._version = null;
  }

  async assertAvailable() {
    if (path.isAbsolute(this.executable)) await access(this.executable);
    const result = await this.run(this.executable, ['-help']);
    const match = result.output.match(/NCONVERT v([\d.]+)/i);
    // NConvert prints valid help/version output but exits non-zero on some Windows releases.
    if (!match) throw new Error(`NConvert is unavailable at ${this.executable}`);
    this._version = match[1];
    return this._version;
  }

  async version() {
    return this._version ?? this.assertAvailable();
  }

  async inspect(filePath) {
    const result = await this.run(this.executable, ['-fullinfo', filePath]);
    if (result.code !== 0 || !/: Success\s*$/m.test(result.output)) {
      throw new Error(cleanBackendError(result.output, 'NConvert could not read the input'));
    }
    const width = readInteger(result.output, 'Width');
    const height = readInteger(result.output, 'Height');
    const pages = readInteger(result.output, 'Page(s)');
    const exifOrientation = result.output.match(/^\s*Orientation\s+\(0x0112\):\s*([^\r\n]+)/mi)?.[1];
    const orientation = normalizeOrientation(exifOrientation) ?? readValue(result.output, 'Orientation') ?? 'Top Left';
    const components = readInteger(result.output, 'Components per pixel', false);
    const metadata = readValue(result.output, 'Metadata');
    if (!width || !height || !pages) throw new Error('NConvert returned incomplete image information');
    return { width, height, pages, orientation, components, metadata: metadata ?? null };
  }

  buildArguments({ sourcePath, temporaryPath, preset, geometry }) {
    const args = ['-quiet', '-icc', '-rtype', 'lanczos'];
    args.push(...orientationArguments(geometry.orientation));
    if (geometry.resize.mode === 'cover') {
      args.push('-resize', 'fill', String(geometry.resize.width), String(geometry.resize.height));
    } else {
      args.push('-ratio', '-resize', String(geometry.resize.width), String(geometry.resize.height));
    }
    if (preset.metadata === 'strip') args.push('-rmeta');
    args.push('-q', String(preset.quality), '-out', preset.format, '-no_auto_ext', '-o', temporaryPath, sourcePath);
    return args;
  }

  async convert(request) {
    const result = await this.run(this.executable, this.buildArguments(request));
    if (result.code !== 0) throw new Error(cleanBackendError(result.output, 'NConvert conversion failed'));
  }
}

export function orientationArguments(orientation) {
  switch (String(orientation ?? 'Top Left').toLowerCase()) {
    case 'top left': return [];
    case 'top right': return ['-xflip'];
    case 'bottom right': return ['-rotate', '180'];
    case 'bottom left': return ['-yflip'];
    case 'left top': return ['-xflip', '-rotate', '270'];
    case 'right top': return ['-rotate', '90'];
    case 'right bottom': return ['-xflip', '-rotate', '90'];
    case 'left bottom': return ['-rotate', '270'];
    default: throw new Error(`Unsupported orientation: ${orientation}`);
  }
}

export function runProcess(command, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { windowsHide: true, shell: false });
    let output = '';
    child.stdout.on('data', (chunk) => { output += chunk; });
    child.stderr.on('data', (chunk) => { output += chunk; });
    child.on('error', reject);
    child.on('close', (code) => resolve({ code: code ?? 1, output }));
  });
}

function readInteger(output, label, required = true) {
  const value = readValue(output, label);
  if (value == null) {
    if (required) throw new Error(`NConvert did not report ${label}`);
    return null;
  }
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed)) throw new Error(`Invalid ${label} from NConvert`);
  return parsed;
}

function readValue(output, label) {
  const escapedLabel = label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = output.match(new RegExp(`^\\s*${escapedLabel}\\s*:\\s*(.+?)\\s*$`, 'mi'));
  return match?.[1]?.trim() ?? null;
}

function cleanBackendError(output, fallback) {
  const lines = output.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  const useful = lines.filter((line) => !line.startsWith('** NCONVERT') && !line.startsWith('** This is'));
  return useful.at(-1) ?? fallback;
}

function normalizeOrientation(value) {
  if (!value) return null;
  return value.replace(/\s*\(\d+\)\s*$/, '').trim().replace(/-/g, ' ').replace(/\b\w/g, (letter) => letter.toUpperCase());
}
