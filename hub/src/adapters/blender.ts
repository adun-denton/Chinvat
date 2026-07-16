/**
 * Blender adapter — v0.1: connection slice.
 * Speaks the ahujasid/blender-mcp add-on wire protocol (MIT, attribution in
 * app-bridges/blender/) directly over loopback TCP via LocalAppBridge.
 * Ops: scene_info / object_info / viewport_snapshot (read) and
 * execute_python (dangerous, gated on the python_enabled toggle, default off).
 * Structured modeling ops (render/export/import canned scripts) arrive in
 * later updates per the connection-first plan.
 */
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { AdapterError } from '../types.js';
import type { AdapterContext, ChinvatAdapter, InvokeResult } from '../types.js';
import { LocalAppBridge } from '../lib/local-app-bridge.js';

const MAX_CODE_BYTES = 100 * 1024;

function bridgeFor(ctx: AdapterContext): LocalAppBridge {
  const host = typeof ctx.config.host === 'string' && ctx.config.host.trim() ? ctx.config.host.trim() : '127.0.0.1';
  const port = Number(ctx.config.port ?? 9876);
  if (!Number.isInteger(port) || port < 1 || port > 65535)
    throw new AdapterError(`invalid port config: ${String(ctx.config.port)}`);
  // Shared per-endpoint instance so the command queue serializes across jobs;
  // constructor enforces loopback-only hosts (Grok review fixes #1/#3/#4).
  return LocalAppBridge.for(host, port);
}

const adapter: ChinvatAdapter = {
  name: 'blender',
  version: '0.1.0',
  description:
    'Blender via the Chinvat Blender bridge add-on (TCP 9876) — scene inspection, viewport snapshots, gated Python execution.',
  activation: {
    kind: 'app-connect',
    note: 'Blender open with the bridge add-on installed + one Connect click in the N-panel (Chinvat tab).',
    guide: 'app-bridges/blender/README.md',
  },
  configSchema: [
    { key: 'host', label: 'Bridge host', type: 'string', default: '127.0.0.1', help: 'Loopback only; the add-on binds locally.' },
    { key: 'port', label: 'Bridge port', type: 'number', default: 9876 },
    {
      key: 'python_enabled',
      label: 'Allow Python execution (execute_python)',
      type: 'boolean',
      default: false,
      help: 'Arbitrary bpy code = local code execution by design. Leave off unless actively modeling.',
    },
  ],

  capabilities: () => [
    {
      name: 'scene_info',
      description: 'Current scene summary: objects, counts, active collection.',
      risk: 'read',
      params: {},
    },
    {
      name: 'object_info',
      description: 'Details for one object: transform, mesh stats, materials.',
      risk: 'read',
      params: { name: { type: 'string', description: 'Object name', required: true } },
    },
    {
      name: 'viewport_snapshot',
      description: 'Capture the 3D viewport to a PNG artifact — the visual-verification primitive.',
      risk: 'read',
      params: { max_size: { type: 'number', description: 'Longest edge in px (default 800)' } },
    },
    {
      name: 'execute_python',
      description:
        'Run arbitrary Python (bpy) inside Blender. Local code execution by design; needs the python_enabled toggle.',
      risk: 'dangerous',
      params: { code: { type: 'string', description: 'Python source', required: true } },
    },
  ],

  async health(ctx) {
    const port = Number(ctx.config.port ?? 9876);
    const ok = await bridgeFor(ctx).ping();
    return ok
      ? { ok: true, detail: `blender bridge reachable on :${port}` }
      : { ok: false, detail: `no bridge on :${port} — open Blender and start the bridge add-on` };
  },

  async invoke(operation, args, ctx): Promise<InvokeResult> {
    const bridge = bridgeFor(ctx);

    switch (operation) {
      case 'scene_info': {
        const result = await bridge.send({ type: 'get_scene_info' }, { timeoutMs: 15_000, signal: ctx.signal });
        return { output: result };
      }

      case 'object_info': {
        const name = args.name;
        if (typeof name !== 'string' || !name.trim()) throw new AdapterError("param 'name' is required");
        const result = await bridge.send(
          { type: 'get_object_info', params: { name } },
          { timeoutMs: 15_000, signal: ctx.signal }
        );
        return { output: result };
      }

      case 'viewport_snapshot': {
        const maxSize = Math.min(Math.max(Number(args.max_size ?? 800) || 800, 64), 4096);
        // The add-on writes the capture to a filepath we supply (same machine),
        // then we lift it into the artifact store and remove the temp file.
        const tmp = path.join(os.tmpdir(), `chinvat-blender-${crypto.randomBytes(6).toString('hex')}.png`);
        try {
          const result = (await bridge.send(
            { type: 'get_viewport_screenshot', params: { max_size: maxSize, filepath: tmp, format: 'png' } },
            { timeoutMs: 30_000, signal: ctx.signal }
          )) as Record<string, unknown>;
          const png = await fs.readFile(tmp);
          const artifact = await ctx.saveArtifact('viewport.png', png);
          return {
            output: { width: result?.width, height: result?.height, artifact },
            artifacts: [artifact],
          };
        } finally {
          await fs.unlink(tmp).catch(() => undefined);
        }
      }

      case 'execute_python': {
        if (ctx.config.python_enabled !== true)
          throw new AdapterError("execute_python is disabled — enable the module's python_enabled toggle first");
        const code = args.code;
        if (typeof code !== 'string' || !code.trim()) throw new AdapterError("param 'code' is required");
        if (Buffer.byteLength(code, 'utf8') > MAX_CODE_BYTES)
          throw new AdapterError(`code exceeds ${MAX_CODE_BYTES} bytes`);
        ctx.log(`execute_python: ${code.length} chars`);
        const result = await bridge.send(
          { type: 'execute_code', params: { code } },
          { timeoutMs: 120_000, signal: ctx.signal }
        );
        return { output: result };
      }

      default:
        throw new AdapterError(`unknown operation: ${operation}`);
    }
  },
};

export default adapter;
