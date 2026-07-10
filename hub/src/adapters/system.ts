import { execFile } from 'node:child_process';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { AdapterError, type ChinvatAdapter } from '../types.js';
import { unknownOp } from './util.js';

function guard(config: Record<string, unknown>, p: string): string {
  const root = path.resolve(String(config.allowedRoot ?? os.homedir()));
  const abs = path.resolve(root, String(p ?? '.'));
  if (config.allowFullAccess === true) return path.resolve(String(p ?? '.'));
  if (abs !== root && !abs.startsWith(root + path.sep)) {
    throw new AdapterError(
      `path '${p}' escapes allowedRoot '${root}' — adjust module config to widen access`
    );
  }
  return abs;
}

function run(
  cmd: string,
  cmdArgs: string[],
  opts: { cwd?: string; timeoutMs: number; signal?: AbortSignal }
): Promise<{ stdout: string; stderr: string; exit_code: number }> {
  return new Promise((resolve) => {
    const child = execFile(
      cmd,
      cmdArgs,
      { cwd: opts.cwd, timeout: opts.timeoutMs, maxBuffer: 10 * 1024 * 1024, windowsHide: true },
      (err, stdout, stderr) => {
        const anyErr = err as (Error & { code?: number | string }) | null;
        resolve({
          stdout: String(stdout ?? ''),
          stderr: String(stderr ?? '') + (anyErr && typeof anyErr.code === 'string' ? `\n${anyErr.message}` : ''),
          exit_code: anyErr ? (typeof anyErr.code === 'number' ? anyErr.code : 1) : 0,
        });
      }
    );
    opts.signal?.addEventListener('abort', () => child.kill(), { once: true });
  });
}

function shellInvocation(command: string): { cmd: string; args: string[] } {
  if (process.platform === 'win32') {
    return {
      cmd: 'powershell.exe',
      args: ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', command],
    };
  }
  return { cmd: '/bin/bash', args: ['-c', command] };
}

const adapter: ChinvatAdapter = {
  name: 'system',
  version: '0.1.0',
  description: 'The machine itself — shell commands, files, processes, apps. Fenced by allowedRoot.',
  configSchema: [
    {
      key: 'allowedRoot',
      label: 'Allowed root path',
      type: 'string',
      help: 'File operations are confined here. Defaults to your home directory.',
    },
    {
      key: 'allowFullAccess',
      label: 'Allow full filesystem access',
      type: 'boolean',
      default: false,
      help: 'Disables the fence. Combine with tier=approve at minimum.',
    },
  ],

  capabilities: () => [
    {
      name: 'run_command',
      description: 'Run a shell command (PowerShell on Windows, bash elsewhere).',
      risk: 'dangerous',
      params: {
        command: { type: 'string', required: true },
        cwd: { type: 'string' },
        timeout_sec: { type: 'number', description: 'default 120' },
      },
    },
    {
      name: 'list_dir',
      description: 'List a directory.',
      risk: 'read',
      params: { path: { type: 'string' } },
    },
    {
      name: 'read_file',
      description: 'Read a text file (capped).',
      risk: 'read',
      params: {
        path: { type: 'string', required: true },
        max_bytes: { type: 'number', description: 'default 65536' },
      },
    },
    {
      name: 'write_file',
      description: 'Write/append a text file (creates parents).',
      risk: 'act',
      params: {
        path: { type: 'string', required: true },
        content: { type: 'string', required: true },
        append: { type: 'boolean' },
      },
    },
    {
      name: 'move_path',
      description: 'Move/rename a file or directory.',
      risk: 'act',
      params: { from: { type: 'string', required: true }, to: { type: 'string', required: true } },
    },
    {
      name: 'delete_path',
      description: 'Delete a file or directory tree.',
      risk: 'dangerous',
      params: { path: { type: 'string', required: true } },
    },
    {
      name: 'open_app',
      description: 'Open a file/app/URL with the OS default handler.',
      risk: 'act',
      params: { target: { type: 'string', required: true } },
    },
    { name: 'process_list', description: 'Snapshot of running processes.', risk: 'read', params: {} },
    { name: 'system_info', description: 'OS, CPU, memory, uptime.', risk: 'read', params: {} },
  ],

  health: async () => ({
    ok: true,
    detail: `${process.platform} ${os.release()} · node ${process.version}`,
  }),

  invoke: async (op, args, ctx) => {
    switch (op) {
      case 'run_command': {
        const { cmd, args: shellArgs } = shellInvocation(String(args.command));
        const cwd = args.cwd ? guard(ctx.config, String(args.cwd)) : undefined;
        const timeoutMs = Math.min(Number(args.timeout_sec ?? 120), 3600) * 1000;
        const result = await run(cmd, shellArgs, { cwd, timeoutMs, signal: ctx.signal });
        const artifacts: string[] = [];
        if (result.stdout.length > 32_000) {
          artifacts.push(await ctx.saveArtifact('stdout.txt', result.stdout));
          result.stdout = result.stdout.slice(0, 32_000) + '\n… (full output in artifact)';
        }
        return { output: result, artifacts };
      }
      case 'list_dir': {
        const dir = guard(ctx.config, String(args.path ?? '.'));
        const entries = await fsp.readdir(dir, { withFileTypes: true });
        return {
          output: entries.map((e) => ({
            name: e.name,
            type: e.isDirectory() ? 'dir' : e.isSymbolicLink() ? 'link' : 'file',
          })),
        };
      }
      case 'read_file': {
        const file = guard(ctx.config, String(args.path));
        const cap = Math.min(Number(args.max_bytes ?? 65_536), 1_048_576);
        const buf = await fsp.readFile(file);
        return {
          output: {
            path: file,
            size: buf.length,
            truncated: buf.length > cap,
            content: buf.subarray(0, cap).toString('utf8'),
          },
        };
      }
      case 'write_file': {
        const file = guard(ctx.config, String(args.path));
        await fsp.mkdir(path.dirname(file), { recursive: true });
        if (args.append === true) await fsp.appendFile(file, String(args.content));
        else await fsp.writeFile(file, String(args.content));
        return { output: { path: file, bytes: String(args.content).length } };
      }
      case 'move_path': {
        const from = guard(ctx.config, String(args.from));
        const to = guard(ctx.config, String(args.to));
        await fsp.mkdir(path.dirname(to), { recursive: true });
        await fsp.rename(from, to);
        return { output: { from, to } };
      }
      case 'delete_path': {
        const target = guard(ctx.config, String(args.path));
        await fsp.rm(target, { recursive: true, force: true });
        return { output: { deleted: target } };
      }
      case 'open_app': {
        const target = String(args.target);
        const inv =
          process.platform === 'win32'
            ? { cmd: 'cmd.exe', args: ['/c', 'start', '', target] }
            : process.platform === 'darwin'
              ? { cmd: 'open', args: [target] }
              : { cmd: 'xdg-open', args: [target] };
        const result = await run(inv.cmd, inv.args, { timeoutMs: 15_000, signal: ctx.signal });
        return { output: { launched: target, exit_code: result.exit_code } };
      }
      case 'process_list': {
        const inv =
          process.platform === 'win32'
            ? shellInvocation(
                'Get-Process | Sort-Object CPU -Descending | Select-Object -First 40 Id,ProcessName,CPU,WorkingSet | ConvertTo-Json'
              )
            : { cmd: '/bin/bash', args: ['-c', 'ps aux --sort=-%cpu | head -40'] };
        const result = await run(inv.cmd, inv.args, { timeoutMs: 20_000, signal: ctx.signal });
        return { output: result.stdout };
      }
      case 'system_info': {
        return {
          output: {
            platform: process.platform,
            release: os.release(),
            arch: os.arch(),
            hostname: os.hostname(),
            cpus: os.cpus().length,
            memory_gb: Math.round((os.totalmem() / 1024 ** 3) * 10) / 10,
            free_memory_gb: Math.round((os.freemem() / 1024 ** 3) * 10) / 10,
            uptime_hours: Math.round((os.uptime() / 3600) * 10) / 10,
          },
        };
      }
      default:
        unknownOp('system', op);
    }
  },
};

export default adapter;
