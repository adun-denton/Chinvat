import { AdapterError, type AdapterContext, type ChinvatAdapter, type OperationSpec } from '../types.js';
import { cfgStr, jsonFetch, msg, unknownOp } from './util.js';

export function normalizeCoolifyBase(value: string): string {
  const raw = value.trim().replace(/\/+$/, '').replace(/\/api\/v1$/i, '');
  if (!raw) return '';
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new AdapterError('baseUrl must be a valid http(s) URL');
  }
  if (!['http:', 'https:'].includes(url.protocol))
    throw new AdapterError('baseUrl must use http or https');
  if (url.username || url.password)
    throw new AdapterError('baseUrl must not contain credentials');
  url.hash = '';
  url.search = '';
  return url.toString().replace(/\/+$/, '');
}

function apiBase(config: Record<string, unknown>): string {
  return `${normalizeCoolifyBase(cfgStr(config, 'baseUrl'))}/api/v1`;
}

function token(config: Record<string, unknown>): string {
  return cfgStr(config, 'apiToken');
}

function resourceUuid(value: unknown, field = 'uuid'): string {
  const uuid = String(value ?? '').trim();
  if (!/^[A-Za-z0-9_-]{3,128}$/.test(uuid))
    throw new AdapterError(`${field} must be a Coolify resource UUID`);
  return uuid;
}

function redact(value: string, secret: string): string {
  return secret.length >= 6 ? value.split(secret).join('***') : value;
}

async function call(path: string, ctx: AdapterContext, init: RequestInit = {}): Promise<unknown> {
  const secret = token(ctx.config);
  try {
    return await jsonFetch(`${apiBase(ctx.config)}${path}`, {
      ...init,
      headers: { Accept: 'application/json', Authorization: `Bearer ${secret}`, ...init.headers },
      timeoutMs: Number(ctx.config.timeoutMs ?? 60_000),
      signal: ctx.signal,
    });
  } catch (error) {
    if (error instanceof AdapterError)
      throw new AdapterError(redact(error.message, secret), error.retriable);
    throw error;
  }
}

function byStatus(items: unknown): Record<string, number> {
  if (!Array.isArray(items)) return {};
  const counts: Record<string, number> = {};
  for (const item of items) {
    const status = String(item?.status ?? 'unknown');
    counts[status] = (counts[status] ?? 0) + 1;
  }
  return counts;
}

const readUuid = { uuid: { type: 'string' as const, description: 'Coolify resource UUID.', required: true } };
const operations: OperationSpec[] = [
  { name: 'infrastructure_overview', description: 'Summarize servers, projects, applications, databases, and services.', risk: 'read', params: {} },
  { name: 'list_servers', description: 'List Coolify servers.', risk: 'read', params: {} },
  { name: 'get_server', description: 'Get one server.', risk: 'read', params: readUuid },
  { name: 'server_resources', description: 'List resources assigned to one server.', risk: 'read', params: readUuid },
  { name: 'list_projects', description: 'List projects.', risk: 'read', params: {} },
  { name: 'get_project', description: 'Get one project.', risk: 'read', params: readUuid },
  { name: 'list_applications', description: 'List applications.', risk: 'read', params: {} },
  { name: 'get_application', description: 'Get one application.', risk: 'read', params: readUuid },
  { name: 'list_databases', description: 'List databases.', risk: 'read', params: {} },
  { name: 'get_database', description: 'Get one database.', risk: 'read', params: readUuid },
  { name: 'list_services', description: 'List services.', risk: 'read', params: {} },
  { name: 'get_service', description: 'Get one service.', risk: 'read', params: readUuid },
  { name: 'list_deployments', description: 'List deployments.', risk: 'read', params: {} },
  { name: 'get_deployment', description: 'Get one deployment.', risk: 'read', params: readUuid },
  { name: 'list_application_deployments', description: 'List deployments for one application.', risk: 'read', params: { application_uuid: { type: 'string', required: true } } },
  { name: 'validate_server', description: 'Ask Coolify to validate a server connection.', risk: 'act', params: readUuid },
  { name: 'deploy_application', description: 'Deploy an application, optionally forcing a rebuild.', risk: 'act', params: { uuid: { type: 'string', required: true }, force: { type: 'boolean', description: 'Force a rebuild.' } } },
  { name: 'start_application', description: 'Start an application.', risk: 'act', params: readUuid },
  { name: 'restart_application', description: 'Restart an application.', risk: 'act', params: readUuid },
  { name: 'stop_application', description: 'Stop an application and cause downtime.', risk: 'dangerous', params: readUuid },
  { name: 'start_database', description: 'Start a database.', risk: 'act', params: readUuid },
  { name: 'restart_database', description: 'Restart a database.', risk: 'act', params: readUuid },
  { name: 'stop_database', description: 'Stop a database and cause downtime.', risk: 'dangerous', params: readUuid },
  { name: 'start_service', description: 'Start a service.', risk: 'act', params: readUuid },
  { name: 'restart_service', description: 'Restart a service.', risk: 'act', params: readUuid },
  { name: 'stop_service', description: 'Stop a service and cause downtime.', risk: 'dangerous', params: readUuid },
  { name: 'cancel_deployment', description: 'Cancel an in-progress deployment.', risk: 'dangerous', params: readUuid },
];

const adapter: ChinvatAdapter = {
  name: 'coolify',
  version: '0.1.0',
  description: 'Inspect and operate a Coolify-managed server through its scoped API.',
  configSchema: [
    { key: 'baseUrl', label: 'Coolify URL', type: 'string', required: true, placeholder: 'https://coolify.example.com', help: 'Instance URL, with or without /api/v1.' },
    { key: 'apiToken', label: 'API token', type: 'secret', required: true, help: 'Use read permission for inventory; add deploy/write only when needed. Do not use root.' },
    { key: 'timeoutMs', label: 'Request timeout (ms)', type: 'number', default: 60000 },
  ],
  capabilities: () => operations,

  async health(ctx) {
    if (!ctx.config.baseUrl || !ctx.config.apiToken)
      return { ok: false, detail: 'not configured (baseUrl and apiToken required)' };
    try {
      const servers = await call('/servers', ctx);
      return { ok: true, detail: `connected · ${Array.isArray(servers) ? servers.length : 0} server(s)` };
    } catch (error) {
      return { ok: false, detail: msg(error) };
    }
  },

  async invoke(operation, args, ctx) {
    const uuidPath = (kind: string, suffix = '') =>
      `/${kind}/${encodeURIComponent(resourceUuid(args.uuid))}${suffix}`;
    switch (operation) {
      case 'infrastructure_overview': {
        const [servers, projects, applications, databases, services] = await Promise.all([
          call('/servers', ctx), call('/projects', ctx), call('/applications', ctx), call('/databases', ctx), call('/services', ctx),
        ]);
        return { output: {
          counts: {
            servers: Array.isArray(servers) ? servers.length : 0,
            projects: Array.isArray(projects) ? projects.length : 0,
            applications: Array.isArray(applications) ? applications.length : 0,
            databases: Array.isArray(databases) ? databases.length : 0,
            services: Array.isArray(services) ? services.length : 0,
          },
          status: { applications: byStatus(applications), databases: byStatus(databases), services: byStatus(services) },
        } };
      }
      case 'list_servers': return { output: await call('/servers', ctx) };
      case 'get_server': return { output: await call(uuidPath('servers'), ctx) };
      case 'server_resources': return { output: await call(uuidPath('servers', '/resources'), ctx) };
      case 'list_projects': return { output: await call('/projects', ctx) };
      case 'get_project': return { output: await call(uuidPath('projects'), ctx) };
      case 'list_applications': return { output: await call('/applications', ctx) };
      case 'get_application': return { output: await call(uuidPath('applications'), ctx) };
      case 'list_databases': return { output: await call('/databases', ctx) };
      case 'get_database': return { output: await call(uuidPath('databases'), ctx) };
      case 'list_services': return { output: await call('/services', ctx) };
      case 'get_service': return { output: await call(uuidPath('services'), ctx) };
      case 'list_deployments': return { output: await call('/deployments', ctx) };
      case 'get_deployment': return { output: await call(uuidPath('deployments'), ctx) };
      case 'list_application_deployments': return { output: await call(`/deployments/applications/${encodeURIComponent(resourceUuid(args.application_uuid, 'application_uuid'))}`, ctx) };
      case 'validate_server': return { output: await call(uuidPath('servers', '/validate'), ctx) };
      case 'deploy_application': {
        const query = new URLSearchParams({ uuid: resourceUuid(args.uuid), force: String(args.force === true) });
        return { output: await call(`/deploy?${query}`, ctx) };
      }
      case 'start_application': return { output: await call(uuidPath('applications', '/start'), ctx) };
      case 'restart_application': return { output: await call(uuidPath('applications', '/restart'), ctx) };
      case 'stop_application': return { output: await call(uuidPath('applications', '/stop'), ctx) };
      case 'start_database': return { output: await call(uuidPath('databases', '/start'), ctx) };
      case 'restart_database': return { output: await call(uuidPath('databases', '/restart'), ctx) };
      case 'stop_database': return { output: await call(uuidPath('databases', '/stop'), ctx) };
      case 'start_service': return { output: await call(uuidPath('services', '/start'), ctx) };
      case 'restart_service': return { output: await call(uuidPath('services', '/restart'), ctx) };
      case 'stop_service': return { output: await call(uuidPath('services', '/stop'), ctx) };
      case 'cancel_deployment': return { output: await call(uuidPath('deployments', '/cancel'), ctx, { method: 'POST' }) };
      default: unknownOp('coolify', operation);
    }
  },
};

export default adapter;
