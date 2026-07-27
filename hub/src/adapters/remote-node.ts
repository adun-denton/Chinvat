/**
 * remote-node — Remote Node Management.
 *
 * Federates other Chinvat hubs. Each remote machine runs its own full hub; this
 * adapter speaks MCP Streamable HTTP to them, so a remote box keeps its own
 * module set, policy tiers, approval queue and job ledger. Nothing here executes
 * anything locally.
 *
 * Two deliberate constraints:
 *
 * 1. Transport. Plain http is accepted only when the host is loopback, a mesh
 *    address (Tailscale/Headscale CGNAT 100.64/10, Tailscale ULA, *.ts.net) or
 *    an RFC1918 private address — contexts where an encrypted overlay or a LAN
 *    already carries the link. Public hosts require https unless the operator
 *    sets allowInsecureHttp explicitly.
 *
 * 2. No risk laundering. Proxying is not a way to run a remote `dangerous`
 *    operation under a local `act` gate. `node_invoke` reads the remote
 *    operation's declared risk first and refuses anything `dangerous`;
 *    `node_invoke_privileged` is itself `dangerous` locally and additionally
 *    requires an explicit confirm string. The remote hub's own policy tier still
 *    applies on top — a remote job can still stop at waiting_approval there.
 */
import {
  AdapterError,
  type AdapterContext,
  type ChinvatAdapter,
  type OperationSpec,
} from '../types.js';
import { msg, unknownOp } from './util.js';

export type HostClass = 'loopback' | 'mesh' | 'private' | 'public';

export interface NodeDef {
  name: string;
  url: string;
  token?: string;
  note?: string;
}

export interface ResolvedNode extends NodeDef {
  hostClass: HostClass;
  secure: boolean;
}

const NAME_RE = /^[a-z0-9][a-z0-9._-]{0,62}$/i;
const TAILSCALE_ULA = 'fd7a:115c:a1e0';

/**
 * Where does this host sit? Drives whether plain http is acceptable.
 * Mesh detection covers Tailscale and Headscale, which both hand out
 * 100.64.0.0/10 (CGNAT) v4 addresses and fd7a:115c:a1e0::/48 v6 addresses.
 */
export function classifyHost(hostname: string): HostClass {
  const h = hostname.trim().toLowerCase().replace(/^\[|\]$/g, '');
  if (!h) throw new AdapterError('node url has no host');
  if (h === 'localhost' || h === '::1' || /^127\./.test(h)) return 'loopback';
  if (h.startsWith(TAILSCALE_ULA)) return 'mesh';

  const v4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(h);
  if (v4) {
    const a = Number(v4[1]);
    const b = Number(v4[2]);
    if (v4.slice(1).some((o) => Number(o) > 255)) throw new AdapterError(`invalid IPv4 host '${h}'`);
    if (a === 100 && b >= 64 && b <= 127) return 'mesh'; // CGNAT: Tailscale / Headscale
    if (a === 10) return 'private';
    if (a === 172 && b >= 16 && b <= 31) return 'private';
    if (a === 192 && b === 168) return 'private';
    if (a === 169 && b === 254) return 'private'; // link-local
    return 'public';
  }

  if (h.includes(':') && /^f[cd]/.test(h)) return 'private'; // IPv6 ULA fc00::/7
  if (h === 'ts.net' || h.endsWith('.ts.net')) return 'mesh'; // Tailscale MagicDNS
  return 'public';
}

/** Normalize a node URL to an absolute `/mcp` endpoint and reject unusable forms. */
export function normalizeNodeUrl(value: string): string {
  const raw = String(value ?? '').trim();
  if (!raw) throw new AdapterError('node url is required');
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new AdapterError(`node url '${raw}' is not a valid absolute URL (include http:// or https://)`);
  }
  if (!['http:', 'https:'].includes(url.protocol))
    throw new AdapterError(`node url must use http or https, got '${url.protocol}'`);
  if (url.username || url.password)
    throw new AdapterError('node url must not embed credentials — use the node token field');
  url.hash = '';
  url.search = '';
  const path = url.pathname.replace(/\/+$/, '');
  url.pathname = path === '' ? '/mcp' : path;
  return url.toString();
}

/** Parse the `nodes` config value: a JSON array of {name,url,token?,note?}. */
export function parseNodes(raw: unknown): NodeDef[] {
  if (raw === undefined || raw === null || String(raw).trim() === '')
    throw new AdapterError(
      "no nodes configured — set 'nodes' to a JSON array like " +
        '[{"name":"gpu-us","url":"http://100.101.102.103:7777/mcp","token":"…"}]'
    );
  let parsed: unknown = raw;
  if (typeof raw === 'string') {
    try {
      parsed = JSON.parse(raw);
    } catch (e) {
      throw new AdapterError(`'nodes' is not valid JSON: ${msg(e)}`);
    }
  }
  if (!Array.isArray(parsed)) throw new AdapterError("'nodes' must be a JSON array");
  if (parsed.length === 0) throw new AdapterError("'nodes' is empty — add at least one node");

  const seen = new Set<string>();
  return parsed.map((entry, i) => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry))
      throw new AdapterError(`nodes[${i}] must be an object`);
    const e = entry as Record<string, unknown>;
    const name = String(e.name ?? '').trim();
    if (!NAME_RE.test(name))
      throw new AdapterError(
        `nodes[${i}].name '${name}' is invalid — use letters, digits, dot, dash or underscore (max 63)`
      );
    const key = name.toLowerCase();
    if (seen.has(key)) throw new AdapterError(`duplicate node name '${name}'`);
    seen.add(key);
    const token = e.token === undefined || e.token === null ? undefined : String(e.token).trim();
    return {
      name,
      url: normalizeNodeUrl(String(e.url ?? '')),
      ...(token ? { token } : {}),
      ...(e.note ? { note: String(e.note) } : {}),
    };
  });
}

/** Apply the transport and credential rules, producing a node ready to dial. */
export function resolveNode(node: NodeDef, allowInsecureHttp = false): ResolvedNode {
  const url = new URL(node.url);
  const hostClass = classifyHost(url.hostname);
  const secure = url.protocol === 'https:';

  if (!secure && hostClass === 'public' && !allowInsecureHttp)
    throw new AdapterError(
      `node '${node.name}' uses plain http to a public host (${url.hostname}). ` +
        'Use https, put the node on a mesh VPN (Tailscale/Headscale), or set allowInsecureHttp to override.'
    );
  if (!node.token && hostClass !== 'loopback')
    throw new AdapterError(
      `node '${node.name}' has no token. A hub reachable off-box must require one — ` +
        "set 'authToken' on that hub and copy it into this node entry."
    );
  return { ...node, hostClass, secure };
}

/** Resolve every configured node, or throw on the first invalid one. */
export function resolveAll(config: Record<string, unknown>): ResolvedNode[] {
  const allow = config.allowInsecureHttp === true;
  return parseNodes(config.nodes).map((n) => resolveNode(n, allow));
}

export function pickNode(nodes: ResolvedNode[], requested: unknown, fallback: unknown): ResolvedNode {
  const want = String(requested ?? fallback ?? '').trim();
  if (!want) {
    if (nodes.length === 1) return nodes[0];
    throw new AdapterError(
      `'node' is required — configured nodes: ${nodes.map((n) => n.name).join(', ')}`
    );
  }
  const found = nodes.find((n) => n.name.toLowerCase() === want.toLowerCase());
  if (!found)
    throw new AdapterError(
      `unknown node '${want}' — configured nodes: ${nodes.map((n) => n.name).join(', ')}`
    );
  return found;
}

/** Never echo a node token back through an operation result. */
export function publicView(node: ResolvedNode): Record<string, unknown> {
  return {
    name: node.name,
    url: node.url,
    host_class: node.hostClass,
    transport: node.secure ? 'https' : 'http',
    authenticated: Boolean(node.token),
    ...(node.note ? { note: node.note } : {}),
  };
}

// ── remote MCP plumbing ──────────────────────────────────────────────────────

interface McpToolResult {
  isError?: boolean;
  content?: Array<{ type?: string; text?: string }>;
}

function textOf(res: McpToolResult): string {
  return (res?.content ?? [])
    .filter((c) => c?.type === 'text' || typeof c?.text === 'string')
    .map((c) => c.text ?? '')
    .join('\n')
    .trim();
}

/** Unwrap an MCP tool result into data, turning remote failures into AdapterError. */
export function unwrapToolResult(res: McpToolResult, what: string): unknown {
  const text = textOf(res);
  if (res?.isError) throw new AdapterError(`${what} failed on the node: ${text.slice(0, 800)}`);
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

type RemoteCall = (tool: string, args: Record<string, unknown>) => Promise<unknown>;

/** Open a client to one node, run `fn`, always close. */
async function withNode<T>(
  node: ResolvedNode,
  ctx: AdapterContext,
  fn: (call: RemoteCall) => Promise<T>
): Promise<T> {
  const { Client } = await import('@modelcontextprotocol/sdk/client/index.js');
  const { StreamableHTTPClientTransport } = await import(
    '@modelcontextprotocol/sdk/client/streamableHttp.js'
  );
  const timeoutMs = Number(ctx.config.timeoutMs ?? 60_000);
  const transport = new StreamableHTTPClientTransport(new URL(node.url), {
    ...(node.token ? { requestInit: { headers: { Authorization: `Bearer ${node.token}` } } } : {}),
  });
  const client = new Client({ name: 'chinvat-remote-node', version: '0.1.0' });
  try {
    await client.connect(transport);
  } catch (e) {
    const detail = msg(e);
    const hint = /401|unauthor/i.test(detail)
      ? " — the node rejected the token; check 'authToken' on that hub"
      : /fetch failed|ECONNREFUSED|ETIMEDOUT|EHOSTUNREACH/i.test(detail)
        ? ' — the node is unreachable; check the mesh link and that its hub is running and bound to the mesh address'
        : '';
    throw new AdapterError(`cannot reach node '${node.name}' at ${node.url}: ${detail}${hint}`, true);
  }
  try {
    return await fn(async (tool, args) => {
      const res = (await client.callTool({ name: tool, arguments: args }, undefined, {
        timeout: timeoutMs,
        signal: ctx.signal,
      })) as McpToolResult;
      return unwrapToolResult(res, tool);
    });
  } finally {
    await client.close().catch(() => {});
  }
}

/** Ask a node for one operation's declared risk. Returns undefined if absent. */
async function remoteRisk(
  call: RemoteCall,
  module: string,
  operation: string
): Promise<string | undefined> {
  const described = (await call('capabilities_describe', { module })) as
    | { operations?: Array<{ name?: string; risk?: string }> }
    | null;
  const ops = described?.operations ?? [];
  const found = ops.find((o) => o?.name === operation);
  if (!found) {
    const names = ops.map((o) => o?.name).filter(Boolean).slice(0, 40).join(', ');
    throw new AdapterError(
      `node has no operation '${module}.${operation}'` + (names ? ` — available: ${names}` : '')
    );
  }
  return found.risk;
}

// ── operations ───────────────────────────────────────────────────────────────

const nodeParam = {
  node: {
    type: 'string' as const,
    description: 'Configured node name. Optional when exactly one node is configured.',
  },
};
const targetParams = {
  ...nodeParam,
  module: { type: 'string' as const, description: 'Module name on the remote hub.', required: true },
  operation: { type: 'string' as const, description: 'Operation name on that module.', required: true },
  args: { type: 'object' as const, description: 'Arguments for the remote operation.' },
  mode: { type: 'string' as const, description: '"sync" waits for a result, "async" returns a job id. Default sync.' },
  wait_ms: { type: 'number' as const, description: 'Sync wait budget on the remote hub.' },
};
const jobParams = {
  ...nodeParam,
  job_id: { type: 'string' as const, description: 'Job id returned by the remote hub.', required: true },
};

const operations: OperationSpec[] = [
  {
    name: 'nodes_list',
    description: 'Configured remote nodes with transport classification. Tokens are never returned.',
    risk: 'read',
    params: {},
  },
  {
    name: 'node_health',
    description: 'Handshake with one node: reachability, tool count, worker names.',
    risk: 'read',
    params: nodeParam,
  },
  {
    name: 'node_workers',
    description: "List the remote hub's modules with health, tier and operations.",
    risk: 'read',
    params: { ...nodeParam, include_disabled: { type: 'boolean', description: 'Include disabled modules.' } },
  },
  {
    name: 'node_capabilities',
    description: 'Full operation schemas for one module on a node.',
    risk: 'read',
    params: { ...nodeParam, module: { type: 'string', description: 'Remote module name.', required: true } },
  },
  {
    name: 'node_invoke',
    description:
      "Run a read or act operation on a node. Refuses remote operations declared 'dangerous' — " +
      'use node_invoke_privileged for those.',
    risk: 'act',
    params: targetParams,
  },
  {
    name: 'node_invoke_privileged',
    description:
      "Run any operation on a node, including remote 'dangerous' ones such as system.run_command. " +
      'Requires confirm:"REMOTE_EXECUTE". The remote hub\'s own policy tier still applies.',
    risk: 'dangerous',
    params: {
      ...targetParams,
      confirm: { type: 'string', description: 'Must be exactly REMOTE_EXECUTE.', required: true },
    },
  },
  { name: 'node_job_status', description: 'Status, timing and recent events for a remote job.', risk: 'read', params: jobParams },
  { name: 'node_job_result', description: 'Final result and artifact list for a remote job.', risk: 'read', params: jobParams },
  { name: 'node_job_cancel', description: 'Cancel a remote job, or deny one waiting for approval there.', risk: 'act', params: jobParams },
];

async function submit(
  node: ResolvedNode,
  args: Record<string, unknown>,
  ctx: AdapterContext,
  privileged: boolean
): Promise<unknown> {
  const module = String(args.module ?? '').trim();
  const operation = String(args.operation ?? '').trim();
  if (!module || !operation) throw new AdapterError("'module' and 'operation' are required");
  if (privileged && args.confirm !== 'REMOTE_EXECUTE')
    throw new AdapterError(
      'node_invoke_privileged requires confirm:"REMOTE_EXECUTE" — this runs a remote operation that the node itself marks dangerous'
    );

  return withNode(node, ctx, async (call) => {
    const risk = await remoteRisk(call, module, operation);
    if (!privileged && risk === 'dangerous')
      throw new AdapterError(
        `node marks '${module}.${operation}' as dangerous. node_invoke will not proxy it. ` +
          'Use node_invoke_privileged with confirm:"REMOTE_EXECUTE", which is gated as dangerous here too.'
      );
    ctx.log(`${node.name}: ${module}.${operation} (remote risk: ${risk ?? 'unknown'})`);
    const result = await call('tasks_submit', {
      module,
      operation,
      args: (args.args as Record<string, unknown>) ?? {},
      mode: args.mode === 'async' ? 'async' : 'sync',
      ...(args.wait_ms !== undefined ? { wait_ms: Number(args.wait_ms) } : {}),
    });
    return { node: node.name, module, operation, remote_risk: risk, result };
  });
}

const adapter: ChinvatAdapter = {
  name: 'remote-node',
  version: '0.1.0',
  description:
    'Remote Node Management — federate other Chinvat hubs over a private mesh. Each node keeps its own modules, ' +
    'policy tiers and approval queue; this module proxies discovery and job submission to them. Remote dangerous ' +
    'operations are gated separately so proxying cannot downgrade risk.',
  activation: {
    kind: 'service',
    note: 'Install and run a Chinvat hub on each remote machine, give it an authToken and a mesh-reachable bind, then list it here.',
    guide: 'docs/REMOTE-NODES.md',
  },
  configSchema: [
    {
      key: 'nodes',
      label: 'Nodes (JSON array)',
      type: 'secret',
      required: true,
      placeholder: '[{"name":"gpu-us","url":"http://100.101.102.103:7777/mcp","token":"…"}]',
      help: 'One entry per remote hub: name, url (its /mcp endpoint), token (that hub\'s authToken), optional note. Stored locally; tokens are never returned by any operation.',
    },
    {
      key: 'timeoutMs',
      label: 'Request timeout (ms)',
      type: 'number',
      default: 60000,
      help: 'Per-call budget for remote MCP requests. Raise it for long sync jobs such as model pulls or transcodes.',
    },
    {
      key: 'allowInsecureHttp',
      label: 'Allow plain http to public hosts',
      type: 'boolean',
      default: false,
      help: 'Off by default. Plain http is always allowed to loopback, mesh (Tailscale/Headscale) and private addresses; this override is only for a public host without TLS, which is rarely correct.',
    },
  ],

  capabilities: () => operations,

  async health(ctx: AdapterContext) {
    let nodes: ResolvedNode[];
    try {
      nodes = resolveAll(ctx.config);
    } catch (e) {
      return { ok: false, detail: msg(e) };
    }
    const probes = await Promise.all(
      nodes.map(async (n) => {
        try {
          await withNode(n, { ...ctx, config: { ...ctx.config, timeoutMs: 8000 } }, async (call) => {
            await call('workers_list', { include_disabled: false });
          });
          return { name: n.name, ok: true };
        } catch (e) {
          return { name: n.name, ok: false, detail: msg(e) };
        }
      })
    );
    const up = probes.filter((p) => p.ok);
    const down = probes.filter((p) => !p.ok);
    return {
      ok: down.length === 0,
      detail:
        `${up.length}/${nodes.length} node(s) reachable` +
        (down.length ? ` · unreachable: ${down.map((d) => d.name).join(', ')}` : '') +
        (up.length ? ` · up: ${up.map((u) => u.name).join(', ')}` : ''),
    };
  },

  async invoke(operation: string, args: Record<string, unknown>, ctx: AdapterContext) {
    const nodes = resolveAll(ctx.config);

    if (operation === 'nodes_list')
      return { output: { count: nodes.length, nodes: nodes.map(publicView) } };

    const node = pickNode(nodes, args.node, ctx.config.defaultNode);

    switch (operation) {
      case 'node_health':
        return {
          output: await withNode(node, ctx, async (call) => {
            const workers = (await call('workers_list', { include_disabled: true })) as {
              hub?: unknown;
              workers?: Array<{ name?: string; enabled?: boolean }>;
            } | null;
            const list = workers?.workers ?? [];
            return {
              node: node.name,
              reachable: true,
              hub: workers?.hub ?? null,
              worker_count: list.length,
              enabled: list.filter((w) => w?.enabled).map((w) => w?.name),
            };
          }),
        };

      case 'node_workers':
        return {
          output: await withNode(node, ctx, (call) =>
            call('workers_list', { include_disabled: args.include_disabled === true })
          ),
        };

      case 'node_capabilities': {
        const module = String(args.module ?? '').trim();
        if (!module) throw new AdapterError("'module' is required");
        return {
          output: await withNode(node, ctx, (call) => call('capabilities_describe', { module })),
        };
      }

      case 'node_invoke':
        return { output: await submit(node, args, ctx, false) };

      case 'node_invoke_privileged':
        return { output: await submit(node, args, ctx, true) };

      case 'node_job_status':
      case 'node_job_result':
      case 'node_job_cancel': {
        const jobId = String(args.job_id ?? '').trim();
        if (!jobId) throw new AdapterError("'job_id' is required");
        const tool =
          operation === 'node_job_status'
            ? 'tasks_status'
            : operation === 'node_job_result'
              ? 'tasks_result'
              : 'tasks_cancel';
        return { output: await withNode(node, ctx, (call) => call(tool, { job_id: jobId })) };
      }

      default:
        return unknownOp('remote-node', operation);
    }
  },
};

export default adapter;
