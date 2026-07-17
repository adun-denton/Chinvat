/**
 * Orca-lineage slicer adapter — v0.1: connection slice.
 * Targets Anycubic Slicer Next (Orca/Bambu CLI dialect, verified 1.4.1.2);
 * plain OrcaSlicer works by pointing exe_path/data_dir at it.
 * Transport: process spawn of a pinned executable — no socket, no app plugin
 * (see docs/DESIGN-local-app-bridges.md §5a). File-in/file-out only; no
 * printer control by design.
 * Ops: profiles_list, profile_read (read) · slice_model (act).
 * profile_clone/patch/diff + analyze_gcode arrive in later updates.
 */
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { AdapterError } from '../types.js';
import type { AdapterContext, ChinvatAdapter, InvokeResult } from '../types.js';

const CATEGORIES = ['machine', 'process', 'filament'] as const;
const DEFAULT_EXE = 'C:\\Program Files\\AnycubicSlicerNext\\AnycubicSlicerNext.exe';
const DEFAULT_DATA = path.join(process.env.APPDATA ?? '', 'AnycubicSlicerNext');
const MODEL_EXTS = new Set(['.stl', '.3mf', '.obj', '.step', '.stp']);

interface Cfg {
  exe: string;
  dataDir: string;
  projectDir: string;
  outputDir: string;
  maxSliceMs: number;
}

function cfg(ctx: AdapterContext): Cfg {
  const s = (v: unknown, d: string) => (typeof v === 'string' && v.trim() ? v.trim() : d);
  const maxSec = Number(ctx.config.max_slice_seconds ?? 600);
  const c = {
    exe: s(ctx.config.exe_path, DEFAULT_EXE),
    dataDir: s(ctx.config.data_dir, DEFAULT_DATA),
    projectDir: s(ctx.config.project_dir, ''),
    outputDir: s(ctx.config.output_dir, ''),
    maxSliceMs: (Number.isFinite(maxSec) && maxSec > 0 ? Math.min(Math.ceil(maxSec), 3600) : 600) * 1000,
  };
  // Fail closed on relative paths: everything here is joined/spawned later,
  // and a CWD-relative dir would confine nothing (Grok review fix #1).
  for (const [k, v] of Object.entries({ exe_path: c.exe, data_dir: c.dataDir }))
    if (!path.isAbsolute(v)) throw new AdapterError(`${k} must be an absolute path`);
  for (const [k, v] of Object.entries({ project_dir: c.projectDir, output_dir: c.outputDir }))
    if (v && !path.isAbsolute(v)) throw new AdapterError(`${k} must be an absolute path`);
  return c;
}

/** jobId feeds a path segment; restrict to a safe token (Grok review fix #2). */
function safeJobToken(id: string | undefined): string {
  const t = id ?? String(Date.now());
  if (!/^[\w-]+$/.test(t)) throw new AdapterError('unsafe job id for output path');
  return t;
}

/** Resolve `p` and require it to live under `root` (realpath, symlink-safe). */
function confine(p: string, root: string, what: string): string {
  if (!root) throw new AdapterError(`${what}: configure the module's directory first`);
  const rootReal = fs.realpathSync(root);
  const abs = path.resolve(rootReal, p);
  // realpath the deepest existing ancestor so symlinks can't escape.
  let probe = abs;
  while (!fs.existsSync(probe)) probe = path.dirname(probe);
  const real = fs.realpathSync(probe);
  if (real !== rootReal && !real.startsWith(rootReal + path.sep))
    throw new AdapterError(`${what}: path escapes ${root}`);
  return abs;
}

/** The two profile roots: user presets and vendor (system) presets.
 *  `system` is the vendor PARENT dir — works for any Orca-lineage fork
 *  (OrcaSlicer: many vendors; ASN: just Anycubic). rel_paths under system
 *  therefore include the vendor segment: `<vendor>\<category>\<name>.json`. */
function profileRoots(c: Cfg): Array<{ source: string; base: string }> {
  return [
    { source: 'user', base: path.join(c.dataDir, 'user', 'default') },
    { source: 'system', base: path.join(c.dataDir, 'system') },
  ];
}

const adapter: ChinvatAdapter = {
  name: 'orca',
  version: '0.1.0',
  description:
    'Orca-lineage slicer (Anycubic Slicer Next) via pinned CLI — profile inspection and headless STL/3MF slicing. Settings and slicing only; no printer control.',
  configSchema: [
    { key: 'exe_path', label: 'Slicer executable', type: 'string', default: DEFAULT_EXE },
    { key: 'data_dir', label: 'Slicer data dir (profiles)', type: 'string', default: DEFAULT_DATA },
    { key: 'project_dir', label: 'Models dir (slice inputs confined here)', type: 'string', required: true },
    { key: 'output_dir', label: 'Output dir (3mf/gcode)', type: 'string', required: true },
    { key: 'max_slice_seconds', label: 'Slice kill timer (s)', type: 'number', default: 600 },
  ],

  capabilities: () => [
    {
      name: 'profiles_list',
      description: 'List machine/process/filament profiles (user + vendor presets, any Orca-lineage fork). Capped at 300 rows; narrow with category/filter.',
      risk: 'read',
      params: {
        category: { type: 'string', description: 'machine|process|filament (default all)' },
        filter: { type: 'string', description: 'Case-insensitive substring on profile name' },
      },
    },
    {
      name: 'profile_read',
      description: 'Read one profile JSON by its relative path from profiles_list.',
      risk: 'read',
      params: {
        source: { type: 'string', description: "'user' or 'system'", required: true },
        rel_path: { type: 'string', description: 'Relative path from profiles_list', required: true },
      },
    },
    {
      name: 'slice_model',
      description:
        'Headless slice: model + machine/process/filament profiles → 3MF (G-code embedded at Metadata/plate_N.gcode). Saves the resolved profile set alongside for reproducibility.',
      risk: 'act',
      params: {
        model: { type: 'string', description: 'Model file inside project_dir (stl/3mf/obj/step)', required: true },
        machine: { type: 'string', description: 'Machine profile: source:rel_path', required: true },
        process: { type: 'string', description: 'Process profile: source:rel_path', required: true },
        filament: { type: 'string', description: 'Filament profile: source:rel_path', required: true },
        plate: { type: 'number', description: 'Plate to slice (default 1; 0 = all)' },
      },
    },
  ],

  async health(ctx) {
    const c = cfg(ctx);
    if (!fs.existsSync(c.exe)) return { ok: false, detail: `slicer exe not found: ${c.exe}` };
    if (!fs.existsSync(c.dataDir)) return { ok: false, detail: `slicer data dir not found: ${c.dataDir}` };
    const countIn = async (base: string, cats: readonly string[]) => {
      let n = 0;
      for (const cat of cats) {
        const d = path.join(base, cat);
        if (fs.existsSync(d)) n += (await fsp.readdir(d)).filter((f) => f.endsWith('.json')).length;
      }
      return n;
    };
    const userN = await countIn(path.join(c.dataDir, 'user', 'default'), CATEGORIES);
    let sysN = 0;
    const sysBase = path.join(c.dataDir, 'system');
    if (fs.existsSync(sysBase))
      for (const v of await fsp.readdir(sysBase, { withFileTypes: true }))
        if (v.isDirectory()) sysN += await countIn(path.join(sysBase, v.name), CATEGORIES);
    return { ok: true, detail: `${path.basename(c.exe)} · profiles user:${userN} system:${sysN}` };
  },

  async invoke(operation, args, ctx): Promise<InvokeResult> {
    const c = cfg(ctx);

    switch (operation) {
      case 'profiles_list': {
        const want = typeof args.category === 'string' ? [args.category] : [...CATEGORIES];
        if (want.some((w) => !(CATEGORIES as readonly string[]).includes(w)))
          throw new AdapterError(`category must be one of ${CATEGORIES.join('|')}`);
        const filter = typeof args.filter === 'string' ? args.filter.toLowerCase() : '';
        const out: Array<{ source: string; category: string; name: string; rel_path: string }> = [];
        const collect = async (source: string, dir: string, cat: string, relBase: string) => {
          if (!fs.existsSync(dir)) return;
          for (const f of await fsp.readdir(dir)) {
            if (!f.endsWith('.json')) continue;
            const name = f.replace(/\.json$/, '');
            if (filter && !name.toLowerCase().includes(filter)) continue;
            out.push({ source, category: cat, name, rel_path: path.join(relBase, f) });
          }
        };
        for (const { source, base } of profileRoots(c)) {
          if (source === 'user') {
            for (const cat of want) await collect(source, path.join(base, cat), cat, cat);
          } else {
            // system = vendor parent: system\<vendor>\<category>\*.json (any Orca fork)
            if (!fs.existsSync(base)) continue;
            for (const vendor of await fsp.readdir(base, { withFileTypes: true })) {
              if (!vendor.isDirectory()) continue;
              for (const cat of want)
                await collect(source, path.join(base, vendor.name, cat), cat, path.join(vendor.name, cat));
            }
          }
        }
        const LIMIT = 300;
        return {
          output: {
            count: out.length,
            truncated: out.length > LIMIT,
            hint: out.length > LIMIT ? "use params 'category' and/or 'filter' (substring) to narrow" : undefined,
            profiles: out.slice(0, LIMIT),
          },
        };
      }

      case 'profile_read': {
        const source = String(args.source ?? '');
        const rel = String(args.rel_path ?? '');
        const root = profileRoots(c).find((r) => r.source === source)?.base;
        if (!root) throw new AdapterError("source must be 'user' or 'system'");
        const abs = confine(rel, root, 'profile_read');
        if (!abs.endsWith('.json')) throw new AdapterError('profiles are .json files');
        const text = await fsp.readFile(abs, 'utf8');
        if (text.length > 1_000_000) throw new AdapterError('profile unexpectedly large');
        return { output: JSON.parse(text) };
      }

      case 'slice_model': {
        const resolveProfile = (spec: unknown, what: string): string => {
          const [source, ...rest] = String(spec ?? '').split(':');
          const root = profileRoots(c).find((r) => r.source === source)?.base;
          if (!root || !rest.length)
            throw new AdapterError(`${what}: use 'user:rel_path' or 'system:rel_path' from profiles_list`);
          const abs = confine(rest.join(':'), root, what);
          if (!fs.existsSync(abs)) throw new AdapterError(`${what}: profile not found: ${spec}`);
          // ';' is the CLI's multi-settings delimiter — a filename containing it
          // could smuggle a second, unconfined settings path (Grok review fix #4).
          if (abs.includes(';')) throw new AdapterError(`${what}: profile path contains ';'`);
          return abs;
        };
        const model = confine(String(args.model ?? ''), c.projectDir, 'model');
        if (!MODEL_EXTS.has(path.extname(model).toLowerCase()))
          throw new AdapterError(`model must be one of: ${[...MODEL_EXTS].join(' ')}`);
        if (!fs.existsSync(model)) throw new AdapterError(`model not found: ${args.model}`);
        const machine = resolveProfile(args.machine, 'machine');
        const proc = resolveProfile(args.process, 'process');
        const filament = resolveProfile(args.filament, 'filament');
        const plate = Number.isInteger(Number(args.plate)) ? Number(args.plate) : 1;
        if (plate < 0 || plate > 36) throw new AdapterError('plate must be 0..36');

        if (!c.outputDir) throw new AdapterError('configure output_dir first');
        await fsp.mkdir(c.outputDir, { recursive: true });
        // Confined output: realpath'd root + sanitized job token (Grok fix #2).
        const outRoot = fs.realpathSync(c.outputDir);
        const outDir = path.join(outRoot, `slice-${safeJobToken(ctx.jobId)}`);
        await fsp.mkdir(outDir, { recursive: true });
        const out3mf = path.join(outDir, 'sliced.3mf');

        // Raw model files (stl/obj/step) have no plates: the CLI resets plate N
        // to 0 anyway, and the object must be arranged onto the bed or slicing
        // fails with "Nothing to be sliced" (verified against ASN 1.4.1.2).
        const isProject = path.extname(model).toLowerCase() === '.3mf';
        const effectivePlate = isProject ? plate : 0;
        const cliArgs = [
          '--debug', '2',
          // OrcaSlicer system presets use "inherits" parent-chains that only
          // resolve when the data dir is known; without this the slice throws a
          // C++ exception at load. (The Anycubic fork's presets were flattened,
          // so it worked without.) Verified against OrcaSlicer 2.4.x.
          '--datadir', c.dataDir,
          '--load-settings', `${machine};${proc}`,
          '--load-filaments', filament,
          ...(isProject ? [] : ['--arrange', '1', '--ensure-on-bed']),
          '--slice', String(effectivePlate),
          // Filename only: the CLI prefixes it with --outputdir itself; an
          // absolute path here gets concatenated into garbage (ASN 1.4.1.2).
          '--export-3mf', 'sliced.3mf',
          '--outputdir', outDir,
          model,
        ];
        ctx.log(`slice_model: ${path.basename(model)} plate=${plate}`);

        if (ctx.signal?.aborted) throw new AdapterError('cancelled before slicing');
        const t0 = Date.now();
        const { code, tail } = await new Promise<{ code: number | null; tail: string }>((resolve, reject) => {
          const child = execFile(
            c.exe,
            cliArgs,
            { timeout: c.maxSliceMs, killSignal: 'SIGKILL', windowsHide: true, maxBuffer: 8 * 1024 * 1024 },
            (err, stdout, stderr) => {
              const text = `${stdout}\n${stderr}`;
              const tailText = text.slice(-4000);
              if (err && (err as NodeJS.ErrnoException).code === 'ENOENT')
                return reject(new AdapterError(`slicer exe not found: ${c.exe}`));
              resolve({ code: child.exitCode, tail: tailText });
            }
          );
          // Kill the whole tree on Windows — Orca-lineage slicers spawn workers
          // that child.kill would orphan (Grok review fix #3).
          const killTree = () => {
            if (process.platform === 'win32' && child.pid)
              execFile('taskkill', ['/PID', String(child.pid), '/T', '/F'], () => undefined);
            else child.kill('SIGKILL');
          };
          ctx.signal?.addEventListener('abort', killTree, { once: true });
        });
        const seconds = Math.round((Date.now() - t0) / 100) / 10;

        // Fail closed on nonzero exit even if a file appeared (Grok fix #6).
        if (code !== 0 || !fs.existsSync(out3mf)) {
          throw new AdapterError(
            `slicer failed (exit=${code}, ${seconds}s, 3mf=${fs.existsSync(out3mf)}). CLI tail:\n${tail}`
          );
        }
        // Reproducibility snapshot: the exact profiles used, next to the result.
        for (const [label, src] of [['machine', machine], ['process', proc], ['filament', filament]] as const)
          await fsp.copyFile(src, path.join(outDir, `used-${label}.json`));

        const size = (await fsp.stat(out3mf)).size;
        // Artifact copy is bounded; oversized results stay on disk, path returned (Grok fix #5).
        const MAX_ARTIFACT = 64 * 1024 * 1024;
        let artifact: string | undefined;
        if (size <= MAX_ARTIFACT) artifact = await ctx.saveArtifact('sliced.3mf', await fsp.readFile(out3mf));
        else ctx.log(`3mf is ${size} bytes (> ${MAX_ARTIFACT}); left on disk at ${out3mf}`);
        return {
          output: { exit: code, seconds, out_dir: outDir, size_bytes: size, artifact, cli_tail: tail.slice(-1200) },
          artifacts: artifact ? [artifact] : [],
        };
      }

      default:
        throw new AdapterError(`unknown operation: ${operation}`);
    }
  },
};

export default adapter;
