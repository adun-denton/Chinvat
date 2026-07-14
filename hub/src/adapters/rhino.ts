/**
 * Rhino adapter — v0.1: connection slice.
 * Speaks the jingcheng-chen/rhinomcp plugin wire protocol (MIT, user-installed
 * via the Rhino Package Manager — see app-bridges/rhino/SETUP.md) directly
 * over loopback TCP via LocalAppBridge in 'framed' mode (4-byte BE length
 * prefix both directions, plugin ≥0.3).
 * Ops: document_summary / object_info / viewport_snapshot (read) and
 * execute_rhinoscript (dangerous, gated on the rhinoscript_enabled toggle,
 * default off). Structured modeling ops and Grasshopper arrive in later
 * updates per the connection-first plan.
 * Activation model: Rhino open + `mcpstart` typed once per Rhino session
 * (like GIMP's per-session Tools→MCP→Start; unlike Blender's N-panel Connect).
 */
import { AdapterError } from '../types.js';
import type { AdapterContext, ChinvatAdapter, InvokeResult } from '../types.js';
import { LocalAppBridge } from '../lib/local-app-bridge.js';

const MAX_CODE_BYTES = 100 * 1024;

function bridgeFor(ctx: AdapterContext): LocalAppBridge {
  const host = typeof ctx.config.host === 'string' && ctx.config.host.trim() ? ctx.config.host.trim() : '127.0.0.1';
  const port = Number(ctx.config.port ?? 1999);
  if (!Number.isInteger(port) || port < 1 || port > 65535)
    throw new AdapterError(`invalid port config: ${String(ctx.config.port)}`);
  // Shared per-endpoint instance (serializing queue across jobs); framing is
  // fixed at first creation — the rhinomcp plugin owns this port exclusively.
  return LocalAppBridge.for(host, port, { framing: 'framed' });
}

const VIEWPORTS = new Set(['active', 'perspective', 'top', 'front', 'right', 'back', 'left', 'bottom']);
const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

const adapter: ChinvatAdapter = {
  name: 'rhino',
  version: '0.1.0',
  description:
    'Rhino 8 via the rhinomcp plugin (TCP 1999) — document inspection, viewport snapshots, gated RhinoScript execution. Plugin installed by the user (MIT, Package Manager).',
  configSchema: [
    { key: 'host', label: 'Bridge host', type: 'string', default: '127.0.0.1', help: 'Loopback only; the plugin binds locally.' },
    { key: 'port', label: 'Bridge port', type: 'number', default: 1999 },
    {
      key: 'rhinoscript_enabled',
      label: 'Allow RhinoScript execution (execute_rhinoscript)',
      type: 'boolean',
      default: false,
      help: 'Arbitrary RhinoScript-Python = local code execution by design. Leave off unless actively modeling.',
    },
  ],

  capabilities: () => [
    {
      name: 'document_summary',
      description: 'Current document overview: objects, layers, counts.',
      risk: 'read',
      params: {},
    },
    {
      name: 'object_info',
      description: 'Details for one object by GUID or name: type, geometry, attributes.',
      risk: 'read',
      params: {
        id: { type: 'string', description: 'Object GUID (this or name required)' },
        name: { type: 'string', description: 'Object name (this or id required)' },
      },
    },
    {
      name: 'viewport_snapshot',
      description: 'Capture a viewport to a PNG artifact — the visual-verification primitive.',
      risk: 'read',
      params: {
        viewport: { type: 'string', description: "Viewport: active|perspective|top|front|right|back|left|bottom or a custom name (default 'active')" },
        width: { type: 'number', description: 'Image width px, 100–4096 (default 800)' },
        height: { type: 'number', description: 'Image height px, 100–4096 (default 600)' },
        zoom_to_fit: { type: 'boolean', description: 'Zoom to fit all objects before capture (default false)' },
      },
    },
    {
      name: 'execute_rhinoscript',
      description:
        'Run arbitrary RhinoScript-Python inside Rhino. Local code execution by design; needs the rhinoscript_enabled toggle.',
      risk: 'dangerous',
      params: { code: { type: 'string', description: 'RhinoScript-Python source', required: true } },
    },
  ],

  async health(ctx) {
    const port = Number(ctx.config.port ?? 1999);
    const ok = await bridgeFor(ctx).ping();
    return ok
      ? { ok: true, detail: `rhino bridge reachable on :${port}` }
      : { ok: false, detail: `no bridge on :${port} — open Rhino and run the mcpstart command` };
  },

  async invoke(operation, args, ctx): Promise<InvokeResult> {
    const bridge = bridgeFor(ctx);

    switch (operation) {
      case 'document_summary': {
        const result = await bridge.send({ type: 'get_document_summary' }, { timeoutMs: 15_000, signal: ctx.signal });
        return { output: result };
      }

      case 'object_info': {
        const id = typeof args.id === 'string' && args.id.trim() ? args.id.trim() : undefined;
        const name = typeof args.name === 'string' && args.name.trim() ? args.name.trim() : undefined;
        if (!id && !name) throw new AdapterError("param 'id' or 'name' is required");
        const result = await bridge.send(
          { type: 'get_object_info', params: id ? { id } : { name } },
          { timeoutMs: 15_000, signal: ctx.signal }
        );
        return { output: result };
      }

      case 'viewport_snapshot': {
        const viewport =
          typeof args.viewport === 'string' && args.viewport.trim() ? args.viewport.trim() : 'active';
        // Custom viewport names are legal per the contract; known names get a
        // case-normalize so 'Perspective' works. Custom names pass through
        // bounded (length + no control chars — Grok rhino-review fix #3,
        // partial: full allowlisting rejected because the wire contract
        // explicitly permits custom named viewports).
        const vp = VIEWPORTS.has(viewport.toLowerCase()) ? viewport.toLowerCase() : viewport;
        if (vp.length > 64 || /[\x00-\x1f\x7f]/.test(vp))
          throw new AdapterError('invalid viewport name (max 64 chars, no control characters)');
        const clamp = (v: unknown, def: number) => Math.min(Math.max(Math.trunc(Number(v ?? def)) || def, 100), 4096);
        const width = clamp(args.width, 800);
        const height = clamp(args.height, 600);
        const params: Record<string, unknown> = { viewport: vp, width, height };
        if (args.zoom_to_fit === true) params.zoom_to_fit = true;
        const result = (await bridge.send(
          { type: 'capture_viewport', params },
          { timeoutMs: 30_000, signal: ctx.signal }
        )) as Record<string, unknown>;
        // Plugin returns the PNG inline as base64 image_data — no temp file leg.
        const b64 = result?.image_data;
        if (typeof b64 !== 'string' || !b64) throw new AdapterError('bridge returned no image_data');
        // Buffer.from(base64) never throws — it silently skips junk — so
        // verify the decoded bytes actually are a PNG before storing them
        // (Grok rhino-review fix #8).
        const png = Buffer.from(b64, 'base64');
        if (png.length < 16 || !png.subarray(0, 8).equals(PNG_MAGIC))
          throw new AdapterError('bridge returned invalid image_data (not a PNG)');
        const artifact = await ctx.saveArtifact('viewport.png', png);
        return {
          output: {
            viewport_name: result?.viewport_name,
            width: result?.width,
            height: result?.height,
            artifact,
          },
          artifacts: [artifact],
        };
      }

      case 'execute_rhinoscript': {
        if (ctx.config.rhinoscript_enabled !== true)
          throw new AdapterError("execute_rhinoscript is disabled — enable the module's rhinoscript_enabled toggle first");
        const code = args.code;
        if (typeof code !== 'string' || !code.trim()) throw new AdapterError("param 'code' is required");
        if (Buffer.byteLength(code, 'utf8') > MAX_CODE_BYTES)
          throw new AdapterError(`code exceeds ${MAX_CODE_BYTES} bytes`);
        ctx.log(`execute_rhinoscript: ${code.length} chars`);
        const result = await bridge.send(
          { type: 'execute_rhinoscript_python_code', params: { code } },
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
