import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parse as tomlParse, stringify as tomlStringify } from 'smol-toml';
import YAML from 'yaml';

export type Transport = 'http' | 'stdio';
export type Format = 'json' | 'toml' | 'yaml';
export type Scope = 'global' | 'project';

export interface ConnectCtx {
  url: string; // http://127.0.0.1:<port>/mcp
  nodePath: string; // absolute node executable
  indexPath: string; // absolute path to hub/dist/index.js
}

export function makeConnectCtx(bind: string, port: number): ConnectCtx {
  const host = bind === '0.0.0.0' ? '127.0.0.1' : bind;
  return {
    url: `http://${host}:${port}/mcp`,
    nodePath: process.execPath,
    indexPath: path.resolve(import.meta.dirname, 'index.js'),
  };
}

// small fs/env helpers
const home = os.homedir();
const exists = (p: string | null): boolean => !!p && fs.existsSync(p);

function onPath(bin: string): boolean {
  const dirs = (process.env.PATH || '').split(path.delimiter);
  const exts = process.platform === 'win32' ? ['.exe', '.cmd', '.bat', ''] : [''];
  for (const d of dirs) {
    if (!d) continue;
    for (const e of exts) {
      try {
        if (fs.existsSync(path.join(d, bin + e))) return true;
      } catch {
        /* ignore */
      }
    }
  }
  return false;
}

function claudeDesktopPath(): string {
  if (process.platform === 'win32')
    return path.join(process.env.APPDATA || path.join(home, 'AppData', 'Roaming'), 'Claude', 'claude_desktop_config.json');
  if (process.platform === 'darwin')
    return path.join(home, 'Library', 'Application Support', 'Claude', 'claude_desktop_config.json');
  return path.join(home, '.config', 'Claude', 'claude_desktop_config.json');
}

// format (de)serialization
function serialize(obj: unknown, format: Format): string {
  if (format === 'toml') return tomlStringify(obj as Record<string, unknown>);
  if (format === 'yaml') return YAML.stringify(obj);
  return JSON.stringify(obj, null, 2) + '\n';
}
function parse(text: string, format: Format): Record<string, any> {
  const t = text.trim();
  if (!t) return {};
  if (format === 'toml') return tomlParse(t) as Record<string, any>;
  if (format === 'yaml') return (YAML.parse(t) as Record<string, any>) ?? {};
  return JSON.parse(t);
}

// client definitions
interface ClientDef {
  id: string;
  name: string;
  blurb: string;
  format: Format;
  container: string;
  transports: Transport[];
  defaultTransport: Transport;
  scopes: Scope[];
  restart: string;
  autoInstall: boolean; // global (user-scope) auto-install supported
  note?: string;
  globalPath(): string | null;
  projectPath: string;
  detect(): { installed: boolean; via: string };
  entry(t: Transport, ctx: ConnectCtx): Record<string, unknown>;
  oneCommand?(scope: Scope, ctx: ConnectCtx): string | undefined;
}

const stdioEntry = (ctx: ConnectCtx) => ({ command: 'node', args: [ctx.indexPath, '--stdio'] });

const CLIENTS: ClientDef[] = [
  {
    id: 'codex',
    name: 'Codex',
    blurb: 'OpenAI Codex CLI / desktop. Native Streamable HTTP.',
    format: 'toml',
    container: 'mcp_servers',
    transports: ['http', 'stdio'],
    defaultTransport: 'http',
    scopes: ['project', 'global'],
    restart: 'Restart Codex (or start a new session) to pick up the server.',
    autoInstall: true,
    note: 'If an older Codex build ignores the url server, add [features] experimental_use_rmcp_client = true above it.',
    globalPath: () => path.join(home, '.codex', 'config.toml'),
    projectPath: '.codex/config.toml',
    detect: () => (exists(path.join(home, '.codex')) ? { installed: true, via: '~/.codex' } : onPath('codex') ? { installed: true, via: 'codex on PATH' } : { installed: false, via: '' }),
    entry: (t, ctx) => (t === 'http' ? { url: ctx.url } : stdioEntry(ctx)),
  },
  {
    id: 'claude-desktop',
    name: 'Claude Desktop',
    blurb: 'Anthropic desktop app. Speaks stdio natively; HTTP via the mcp-remote bridge.',
    format: 'json',
    container: 'mcpServers',
    transports: ['stdio', 'http'],
    defaultTransport: 'stdio',
    scopes: ['global'],
    restart: 'Quit Claude Desktop completely (tray included) and reopen it.',
    autoInstall: true,
    note: 'Claude Desktop has no native HTTP transport, so stdio is the reliable choice for a local hub. The HTTP option shells out to npx mcp-remote.',
    globalPath: claudeDesktopPath,
    projectPath: '(global only)',
    detect: () => (exists(path.dirname(claudeDesktopPath())) ? { installed: true, via: 'Claude config folder' } : { installed: false, via: '' }),
    entry: (t, ctx) => (t === 'stdio' ? stdioEntry(ctx) : { command: 'npx', args: ['-y', 'mcp-remote', ctx.url] }),
  },
  {
    id: 'claude-code',
    name: 'Claude Code',
    blurb: 'Anthropic coding CLI. Native Streamable HTTP; one-command install.',
    format: 'json',
    container: 'mcpServers',
    transports: ['http', 'stdio'],
    defaultTransport: 'http',
    scopes: ['project', 'global'],
    restart: 'Run /mcp in Claude Code (or restart the session) to connect.',
    autoInstall: true,
    globalPath: () => path.join(home, '.claude.json'),
    projectPath: '.mcp.json',
    detect: () => (onPath('claude') ? { installed: true, via: 'claude on PATH' } : exists(path.join(home, '.claude.json')) ? { installed: true, via: '~/.claude.json' } : { installed: false, via: '' }),
    entry: (t, ctx) => (t === 'http' ? { type: 'http', url: ctx.url } : stdioEntry(ctx)),
    oneCommand: (scope, ctx) => `claude mcp add --transport http ${scope === 'project' ? '-s project ' : ''}chinvat ${ctx.url}`,
  },
  {
    id: 'hermes',
    name: 'Hermes',
    blurb: 'Nous Research Hermes Agent. Native HTTP; no restart needed.',
    format: 'yaml',
    container: 'mcp_servers',
    transports: ['http', 'stdio'],
    defaultTransport: 'http',
    scopes: ['global'],
    restart: 'No restart needed — run /reload-mcp in a Hermes chat to re-discover tools.',
    autoInstall: true,
    globalPath: () => path.join(home, '.hermes', 'config.yaml'),
    projectPath: '(global only)',
    detect: () => (exists(path.join(home, '.hermes')) ? { installed: true, via: '~/.hermes' } : onPath('hermes') ? { installed: true, via: 'hermes on PATH' } : { installed: false, via: '' }),
    entry: (t, ctx) => (t === 'http' ? { url: ctx.url } : stdioEntry(ctx)),
  },
  {
    id: 'cursor',
    name: 'Cursor',
    blurb: 'Cursor IDE. Native Streamable HTTP.',
    format: 'json',
    container: 'mcpServers',
    transports: ['http', 'stdio'],
    defaultTransport: 'http',
    scopes: ['project', 'global'],
    restart: 'Cursor reloads MCP automatically; if not, toggle the server off/on in Settings → MCP.',
    autoInstall: true,
    globalPath: () => path.join(home, '.cursor', 'mcp.json'),
    projectPath: '.cursor/mcp.json',
    detect: () => (exists(path.join(home, '.cursor')) ? { installed: true, via: '~/.cursor' } : onPath('cursor') ? { installed: true, via: 'cursor on PATH' } : { installed: false, via: '' }),
    entry: (t, ctx) => (t === 'http' ? { url: ctx.url } : stdioEntry(ctx)),
  },
  {
    id: 'generic',
    name: 'Generic MCP client',
    blurb: 'Any other MCP-capable client. Point it at the endpoint below.',
    format: 'json',
    container: 'mcpServers',
    transports: ['http', 'stdio'],
    defaultTransport: 'http',
    scopes: ['global'],
    restart: 'Reload or restart your client after adding the server.',
    autoInstall: false,
    globalPath: () => null,
    projectPath: '(client-specific)',
    detect: () => ({ installed: true, via: 'transport-only' }),
    entry: (t, ctx) => (t === 'http' ? { type: 'http', url: ctx.url } : stdioEntry(ctx)),
  },
];

function def(id: string): ClientDef {
  const d = CLIENTS.find((c) => c.id === id);
  if (!d) throw new Error(`unknown client '${id}'`);
  return d;
}

function snippetFor(d: ClientDef, t: Transport, ctx: ConnectCtx): string {
  if (d.id === 'generic') {
    return t === 'http'
      ? `Transport: Streamable HTTP\nURL:       ${ctx.url}`
      : `Transport: stdio\nCommand:   ${ctx.nodePath}\nArgs:      ${ctx.indexPath} --stdio`;
  }
  return serialize({ [d.container]: { chinvat: d.entry(t, ctx) } }, d.format);
}

export interface ClientView {
  id: string;
  name: string;
  blurb: string;
  format: Format;
  transports: Transport[];
  defaultTransport: Transport;
  scopes: Scope[];
  restart: string;
  note?: string;
  autoInstall: boolean;
  globalPath: string | null;
  projectPath: string;
  detected: { installed: boolean; via: string };
  snippets: Record<string, string>;
  oneCommand?: Record<string, string>;
}

export function listClients(ctx: ConnectCtx): { endpoint: string; clients: ClientView[] } {
  const clients = CLIENTS.map((d) => {
    const snippets: Record<string, string> = {};
    for (const t of d.transports) snippets[t] = snippetFor(d, t, ctx);
    let oneCommand: Record<string, string> | undefined;
    if (d.oneCommand) {
      oneCommand = {};
      for (const s of d.scopes) {
        const c = d.oneCommand(s, ctx);
        if (c) oneCommand[s] = c;
      }
    }
    return {
      id: d.id,
      name: d.name,
      blurb: d.blurb,
      format: d.format,
      transports: d.transports,
      defaultTransport: d.defaultTransport,
      scopes: d.scopes,
      restart: d.restart,
      note: d.note,
      autoInstall: d.autoInstall,
      globalPath: d.globalPath(),
      projectPath: d.projectPath,
      detected: d.detect(),
      snippets,
      oneCommand,
    };
  });
  return { endpoint: ctx.url, clients };
}

export interface InstallPreview {
  clientId: string;
  transport: Transport;
  scope: 'global';
  path: string;
  format: Format;
  exists: boolean;
  before: string;
  after: string;
  backupPath: string | null;
}

/** Compute the merged file without writing. Global/user scope only. */
export function previewInstall(ctx: ConnectCtx, clientId: string, transport: Transport): InstallPreview {
  const d = def(clientId);
  if (!d.autoInstall) throw new Error(`${d.name} has no automatic installer — copy the configuration instead.`);
  const target = d.globalPath();
  if (!target) throw new Error(`${d.name} has no known global config path.`);
  const fileExists = fs.existsSync(target);
  const before = fileExists ? fs.readFileSync(target, 'utf8') : '';
  let obj: Record<string, any>;
  try {
    obj = parse(before, d.format);
  } catch (e) {
    throw new Error(`existing ${path.basename(target)} could not be parsed (${e instanceof Error ? e.message : e}); fix or remove it, or install manually.`);
  }
  obj[d.container] = obj[d.container] || {};
  obj[d.container].chinvat = d.entry(transport, ctx);
  const after = serialize(obj, d.format);
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  return {
    clientId,
    transport,
    scope: 'global',
    path: target,
    format: d.format,
    exists: fileExists,
    before,
    after,
    backupPath: fileExists ? `${target}.chinvat-backup-${stamp}` : null,
  };
}

export interface InstallResult {
  path: string;
  backup: string | null;
  merged: boolean;
}

/** Back up (if present) then write the merged config. */
export function applyInstall(ctx: ConnectCtx, clientId: string, transport: Transport): InstallResult {
  const p = previewInstall(ctx, clientId, transport);
  fs.mkdirSync(path.dirname(p.path), { recursive: true });
  if (p.exists && p.backupPath) fs.copyFileSync(p.path, p.backupPath);
  fs.writeFileSync(p.path, p.after);
  return { path: p.path, backup: p.exists ? p.backupPath : null, merged: p.exists };
}

export interface EndpointTest {
  ok: boolean;
  url: string;
  detail: string;
  toolCount?: number;
  workerCount?: number;
  workers?: string[];
}

/** Real MCP handshake against the hub's own HTTP endpoint, then call workers_list. */
export async function testEndpoint(ctx: ConnectCtx): Promise<EndpointTest> {
  try {
    const { Client } = await import('@modelcontextprotocol/sdk/client/index.js');
    const { StreamableHTTPClientTransport } = await import('@modelcontextprotocol/sdk/client/streamableHttp.js');
    const transport = new StreamableHTTPClientTransport(new URL(ctx.url));
    const client = new Client({ name: 'chinvat-selftest', version: '0.1.0' });
    await client.connect(transport);
    const tools = await client.listTools();
    const res: any = await client.callTool({ name: 'workers_list', arguments: { include_disabled: true } });
    await client.close();
    let workers: string[] = [];
    try {
      const parsed = JSON.parse(res?.content?.[0]?.text ?? '[]');
      workers = Array.isArray(parsed) ? parsed.map((w: any) => w.name) : [];
    } catch {
      /* ignore */
    }
    return {
      ok: true,
      url: ctx.url,
      detail: `Connected. ${tools.tools.length} tools, ${workers.length} workers.`,
      toolCount: tools.tools.length,
      workerCount: workers.length,
      workers,
    };
  } catch (e) {
    return { ok: false, url: ctx.url, detail: e instanceof Error ? e.message : String(e) };
  }
}
