/**
 * GIMP adapter — v0.1: connection slice (the 2D-environment testbed).
 * Speaks the maorcc/gimp-mcp plug-in's TCP/JSON protocol on 127.0.0.1:9877.
 * The plug-in is GPLv3 and NOT vendored — the user installs it into GIMP 3
 * themselves (see docs/DESIGN-local-app-bridges.md §4); this adapter only
 * talks to its socket. Requests: {"type", "params"} for structured ops,
 * {"cmds": [lines]} for Python. Responses: {"status","results"|"error"}.
 * Ops: gimp_info / image_metadata / snapshot (read) and execute_python
 * (dangerous, gated on python_enabled, default off). Structured edit ops
 * (crop/scale/adjust/export) arrive in later updates per connection-first.
 */
import { AdapterError } from '../types.js';
import type { AdapterContext, ChinvatAdapter, InvokeResult } from '../types.js';
import { LocalAppBridge } from '../lib/local-app-bridge.js';

const MAX_CODE_BYTES = 100 * 1024;

function bridgeFor(ctx: AdapterContext): LocalAppBridge {
  const conf = ctx.config ?? {}; // modules configured only via enabled/tier have no config block
  const host = typeof conf.host === 'string' && conf.host.trim() ? conf.host.trim() : '127.0.0.1';
  const port = Number(conf.port ?? 9877);
  if (!Number.isInteger(port) || port < 1 || port > 65535)
    throw new AdapterError(`invalid port config: ${String(conf.port)}`);
  return LocalAppBridge.for(host, port);
}

const adapter: ChinvatAdapter = {
  name: 'gimp',
  version: '0.1.0',
  description:
    'GIMP 3 via the gimp-mcp plug-in socket (TCP 9877) — image inspection, snapshots, gated Python execution. Plug-in installed by the user (GPL, not vendored).',
  configSchema: [
    { key: 'host', label: 'Bridge host', type: 'string', default: '127.0.0.1', help: 'Loopback only.' },
    { key: 'port', label: 'Bridge port', type: 'number', default: 9877 },
    {
      key: 'python_enabled',
      label: 'Allow Python execution (execute_python)',
      type: 'boolean',
      default: false,
      help: 'Arbitrary PyGObject code = local code execution by design. Leave off unless actively editing.',
    },
  ],

  capabilities: () => [
    {
      name: 'gimp_info',
      description: 'GIMP version, directories, open images, capabilities.',
      risk: 'read',
      params: {},
    },
    {
      name: 'image_metadata',
      description: 'Current image structure without bitmap transfer: size, layers, channels, paths, file.',
      risk: 'read',
      params: {},
    },
    {
      name: 'snapshot',
      description: 'Current image as a PNG artifact — the visual-verification primitive. Optional scaling/region params.',
      risk: 'read',
      params: {
        max_width: { type: 'number', description: 'Scale to fit width (default 1024)' },
        max_height: { type: 'number', description: 'Scale to fit height (default 1024)' },
      },
    },
    {
      name: 'execute_python',
      description:
        'Run PyGObject Python lines inside GIMP (persistent context). Local code execution by design; needs the python_enabled toggle.',
      risk: 'dangerous',
      params: {
        lines: { type: 'array', description: 'Python source lines executed in order', required: true },
      },
    },
  ],

  async health(ctx) {
    const port = Number((ctx.config ?? {}).port ?? 9877);
    const ok = await bridgeFor(ctx).ping();
    return ok
      ? { ok: true, detail: `gimp bridge reachable on :${port}` }
      : { ok: false, detail: `no bridge on :${port} — open GIMP and start the MCP plug-in server` };
  },

  async invoke(operation, args, ctx): Promise<InvokeResult> {
    const bridge = bridgeFor(ctx);

    switch (operation) {
      case 'gimp_info': {
        const result = await bridge.send({ type: 'get_gimp_info' }, { timeoutMs: 20_000, signal: ctx.signal });
        return { output: result };
      }

      case 'image_metadata': {
        const result = await bridge.send({ type: 'get_image_metadata' }, { timeoutMs: 20_000, signal: ctx.signal });
        return { output: result };
      }

      case 'snapshot': {
        const clamp = (v: unknown, d: number) => Math.min(Math.max(Number(v ?? d) || d, 64), 4096);
        const params = { max_width: clamp(args.max_width, 1024), max_height: clamp(args.max_height, 1024) };
        const result = (await bridge.send(
          { type: 'get_image_bitmap', params },
          { timeoutMs: 60_000, signal: ctx.signal }
        )) as Record<string, unknown>;
        const b64 = result?.image_data;
        if (typeof b64 !== 'string' || !b64) throw new AdapterError('bridge returned no image_data — is an image open in GIMP?');
        // Explicit decode bound: a 4096x4096 PNG is far below this; fail clearly
        // instead of soft-OOMing near the wire cap (Grok fix #3).
        if (b64.length > 48 * 1024 * 1024) throw new AdapterError('image_data exceeds 48MB base64 cap');
        const artifact = await ctx.saveArtifact('gimp-snapshot.png', Buffer.from(b64, 'base64'));
        return {
          output: { width: result?.width, height: result?.height, original_width: result?.original_width, original_height: result?.original_height, artifact },
          artifacts: [artifact],
        };
      }

      case 'execute_python': {
        if ((ctx.config ?? {}).python_enabled !== true)
          throw new AdapterError("execute_python is disabled — enable the module's python_enabled toggle first");
        const lines = args.lines;
        if (!Array.isArray(lines) || !lines.length || !lines.every((l) => typeof l === 'string'))
          throw new AdapterError("param 'lines' must be a non-empty array of strings");
        if (lines.length > 2048) throw new AdapterError('too many lines (max 2048)'); // cardinality != bytes (Grok fix #1)
        const total = lines.reduce((n, l) => n + Buffer.byteLength(l, 'utf8'), 0);
        if (total > MAX_CODE_BYTES) throw new AdapterError(`code exceeds ${MAX_CODE_BYTES} bytes`);
        ctx.log(`execute_python: ${lines.length} line(s), ${total} bytes`);
        const result = await bridge.send({ raw: { cmds: lines } }, { timeoutMs: 120_000, signal: ctx.signal });
        return { output: result };
      }

      default:
        throw new AdapterError(`unknown operation: ${operation}`);
    }
  },
};

export default adapter;
