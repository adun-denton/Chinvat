const API_ORIGIN = 'https://services.leadconnectorhq.com';
const DEFAULT_VERSION = 'v3';

const RESOURCE_FAMILIES = Object.freeze({
  contacts: {
    description: 'Contacts, search, duplicate resolution, notes, tasks, tags, appointments, and followers.',
    collection: '/contacts/',
    item: '/contacts/{id}',
    search: '/contacts/',
    location: 'query',
  },
  conversations: {
    description: 'Conversation search, threads, messages, recordings, and message status.',
    collection: '/conversations/search',
    item: '/conversations/{id}',
    location: 'query',
  },
  messages: {
    description: 'Outbound messages, inbound-message injection, attachments, transcripts, and status.',
    collection: '/conversations/messages',
    item: '/conversations/messages/{id}',
    location: 'body',
  },
  opportunities: {
    description: 'Pipeline opportunities, search, upsert, followers, and status.',
    collection: '/opportunities/search',
    item: '/opportunities/{id}',
    location: 'query',
  },
  pipelines: {
    description: 'Opportunity pipeline and stage definitions.',
    collection: '/opportunities/pipelines',
    item: '/opportunities/pipelines/{id}',
    location: 'query',
  },
  calendars: {
    description: 'Calendars, groups, resources, availability, appointments, and blocked slots.',
    collection: '/calendars/',
    item: '/calendars/{id}',
    location: 'query',
  },
  calendar_events: {
    description: 'Calendar events and appointments.',
    collection: '/calendars/events',
    item: '/calendars/events/{id}',
    location: 'query',
  },
  workflows: {
    description: 'Workflow inventory and contact enrollment/removal.',
    collection: '/workflows/',
    item: '/workflows/{id}',
    location: 'query',
  },
  social_posts: {
    description: 'Social Planner drafts, approval state, scheduling, publishing, and post statistics.',
    collection: '/social-media-posting/{locationId}/posts',
    list: '/social-media-posting/{locationId}/posts/list',
    listMethod: 'POST',
    listBody: {},
    item: '/social-media-posting/{locationId}/posts/{id}',
    location: 'path',
  },
  social_accounts: {
    description: 'Connected Social Planner accounts and channel metadata.',
    collection: '/social-media-posting/{locationId}/accounts',
    item: '/social-media-posting/{locationId}/accounts/{id}',
    location: 'path',
  },
  users: {
    description: 'Sub-account users and assignment metadata.',
    collection: '/users/',
    item: '/users/{id}',
    location: 'query',
  },
  locations: {
    description: 'The configured sub-account profile and settings exposed by API.',
    collection: '/locations/search',
    item: '/locations/{id}',
    location: 'item',
  },
  tags: {
    description: 'Location-level contact tags.',
    collection: '/locations/{locationId}/tags',
    item: '/locations/{locationId}/tags/{id}',
    location: 'path',
  },
  custom_fields: {
    description: 'Location-level custom fields.',
    collection: '/locations/{locationId}/customFields',
    item: '/locations/{locationId}/customFields/{id}',
    location: 'path',
  },
  custom_values: {
    description: 'Location-level custom values.',
    collection: '/locations/{locationId}/customValues',
    item: '/locations/{locationId}/customValues/{id}',
    location: 'path',
  },
  forms: {
    description: 'Form inventory and submissions.',
    collection: '/forms/',
    item: '/forms/{id}',
    location: 'query',
  },
  surveys: {
    description: 'Survey inventory and submissions.',
    collection: '/surveys/',
    item: '/surveys/{id}',
    location: 'query',
  },
  products: {
    description: 'Products, prices, collections, and inventory.',
    collection: '/products/',
    item: '/products/{id}',
    location: 'query',
  },
  orders: {
    description: 'Payment orders, fulfillment, and order status.',
    collection: '/payments/orders',
    item: '/payments/orders/{id}',
    location: 'query',
    defaultQuery: { altId: '{locationId}', altType: 'location', limit: 10, offset: 0 },
  },
  transactions: {
    description: 'Payment transaction inventory.',
    collection: '/payments/transactions',
    item: '/payments/transactions/{id}',
    location: 'query',
    defaultQuery: { altId: '{locationId}', altType: 'location', limit: 10, offset: 0 },
  },
  invoices: {
    description: 'Invoices, estimates, templates, schedules, and payment state.',
    collection: '/invoices/',
    item: '/invoices/{id}',
    location: 'query',
    defaultQuery: { altId: '{locationId}', altType: 'location', limit: '10', offset: '0' },
  },
  subscriptions: {
    description: 'Recurring payment subscriptions.',
    collection: '/payments/subscriptions',
    item: '/payments/subscriptions/{id}',
    location: 'query',
    defaultQuery: { altId: '{locationId}', altType: 'location', limit: 10, offset: 0 },
  },
  businesses: {
    description: 'Business records associated with the sub-account.',
    collection: '/businesses/',
    item: '/businesses/{id}',
    location: 'query',
  },
  media: {
    description: 'Media storage files and folders.',
    collection: '/medias/files',
    item: '/medias/files/{id}',
    location: 'query',
    defaultQuery: { type: 'file', limit: 10, offset: 0 },
  },
  blogs: {
    description: 'Blog sites, authors, categories, posts, and publishing state.',
    collection: '/blogs/site/all',
    item: '/blogs/{id}',
    location: 'query',
    defaultQuery: { skip: 0, limit: 10 },
  },
  custom_objects: {
    description: 'Custom object schemas and records when enabled for the sub-account.',
    collection: '/objects/',
    item: '/objects/{id}',
    location: 'query',
  },
  associations: {
    description: 'Association definitions and relationships between supported records.',
    collection: '/associations/',
    item: '/associations/{id}',
    location: 'query',
  },
  campaigns: {
    description: 'Campaign inventory exposed to the sub-account API.',
    collection: '/campaigns/',
    item: '/campaigns/{id}',
    location: 'query',
  },
  snapshots: {
    description: 'Snapshot inventory visible to the token; commonly agency-plan and scope dependent.',
    collection: '/snapshots/',
    item: '/snapshots/{id}',
    location: 'query',
  },
  voice_ai_agents: {
    description: 'Voice AI agent inventory and supported agent configuration.',
    collection: '/voice-ai/agents',
    item: '/voice-ai/agents/{id}',
    location: 'query',
  },
});

const ACCOUNT_BOUND = Object.freeze([
  'Create, rotate, revoke, and rescope the Private Integration token.',
  'Select the sub-account associated with a Private Integration.',
  'Connect, consent, reconnect, or remove Meta/Facebook/Instagram assets.',
  'Control Meta Business ownership, app review, ad-account payment, and Page permissions.',
  'Change the HighLevel subscription, wallet, rebilling, marketplace apps, or premium-feature entitlements.',
  'Complete phone, email, domain, payment-provider, and identity-provider verification.',
  'Perform UI-only configuration where no public v2 endpoint exists, including full visual workflow authoring.',
]);

const params = {
  family: { type: 'string', required: true, description: `Resource family: ${Object.keys(RESOURCE_FAMILIES).join(', ')}.` },
  id: { type: 'string', required: true, description: 'HighLevel resource identifier.' },
  query: { type: 'object', description: 'Query-string parameters. Arrays become repeated parameters.' },
  body: { type: 'object', description: 'JSON request body.' },
  version: { type: 'string', description: 'Optional per-request Version header override, such as v3 or 2023-02-21.' },
};

const OPERATIONS = Object.freeze([
  { name: 'capability_inventory', description: 'Describe the maximum API surface, route families, and account-bound controls without making a request.', risk: 'read', params: {} },
  { name: 'connection_health', description: 'Read the configured sub-account to verify token, location, host, and API version.', risk: 'read', params: {} },
  { name: 'resource_list', description: 'GET a catalogued resource collection with location context injected.', risk: 'read', params: { family: params.family, query: params.query } },
  { name: 'resource_get', description: 'GET one catalogued resource by ID.', risk: 'read', params: { family: params.family, id: params.id, query: params.query } },
  { name: 'resource_create', description: 'POST to a catalogued resource collection.', risk: 'act', params: { family: params.family, body: params.body, query: params.query } },
  { name: 'resource_update', description: 'PUT or PATCH one catalogued resource.', risk: 'act', params: { family: params.family, id: params.id, body: params.body, query: params.query, method: { type: 'string', description: 'PUT (default) or PATCH.' } } },
  { name: 'resource_delete', description: 'DELETE one catalogued resource.', risk: 'dangerous', params: { family: params.family, id: params.id, query: params.query } },
  { name: 'api_get', description: 'Maximum-surface GET against any HighLevel v2 path on the fixed API host.', risk: 'read', params: { path: { type: 'string', required: true }, query: params.query, version: params.version } },
  { name: 'api_post', description: 'Maximum-surface POST against any HighLevel v2 path on the fixed API host.', risk: 'act', params: { path: { type: 'string', required: true }, query: params.query, body: params.body, version: params.version } },
  { name: 'api_put', description: 'Maximum-surface PUT against any HighLevel v2 path on the fixed API host.', risk: 'act', params: { path: { type: 'string', required: true }, query: params.query, body: params.body, version: params.version } },
  { name: 'api_patch', description: 'Maximum-surface PATCH against any HighLevel v2 path on the fixed API host.', risk: 'act', params: { path: { type: 'string', required: true }, query: params.query, body: params.body, version: params.version } },
  { name: 'api_delete', description: 'Maximum-surface DELETE against any HighLevel v2 path on the fixed API host.', risk: 'dangerous', params: { path: { type: 'string', required: true }, query: params.query, body: params.body, version: params.version } },
]);

function config(ctx) {
  const accessToken = String(ctx.config.accessToken ?? '').trim();
  const locationId = String(ctx.config.locationId ?? '').trim();
  const apiVersion = String(ctx.config.apiVersion ?? DEFAULT_VERSION).trim() || DEFAULT_VERSION;
  const timeoutMs = Math.max(1000, Math.min(300000, Number(ctx.config.timeoutMs ?? 60000)));
  if (!accessToken || !locationId) throw new Error('accessToken and locationId are required');
  return { accessToken, locationId, apiVersion, timeoutMs };
}

function cleanId(value, field = 'id') {
  const id = String(value ?? '').trim();
  if (!/^[A-Za-z0-9_-]{2,160}$/.test(id)) throw new Error(`${field} is invalid`);
  return id;
}

function cleanPath(value) {
  const path = String(value ?? '').trim();
  if (!path.startsWith('/') || path.startsWith('//') || path.includes('\\') || /[\r\n]/.test(path))
    throw new Error('path must be an absolute API path beginning with one slash');
  const parsed = new URL(path, API_ORIGIN);
  if (parsed.origin !== API_ORIGIN) throw new Error('path must remain on the fixed HighLevel API host');
  return `${parsed.pathname}${parsed.search}`;
}

function family(value) {
  const name = String(value ?? '').trim();
  const spec = RESOURCE_FAMILIES[name];
  if (!spec) throw new Error(`unknown family '${name}'`);
  return { name, spec };
}

function fillPath(template, cfg, id) {
  let path = template.replaceAll('{locationId}', encodeURIComponent(cleanId(cfg.locationId, 'locationId')));
  if (id !== undefined) path = path.replaceAll('{id}', encodeURIComponent(cleanId(id)));
  return path;
}

function addQuery(url, query) {
  if (query === undefined) return;
  if (!query || typeof query !== 'object' || Array.isArray(query)) throw new Error('query must be an object');
  for (const [key, raw] of Object.entries(query)) {
    if (raw === undefined || raw === null) continue;
    const values = Array.isArray(raw) ? raw : [raw];
    for (const value of values) {
      if (typeof value === 'object') url.searchParams.append(key, JSON.stringify(value));
      else url.searchParams.append(key, String(value));
    }
  }
}

function withLocation(spec, cfg, query, body, isItem = false) {
  const defaults = Object.fromEntries(
    Object.entries(spec.defaultQuery ?? {}).map(([key, value]) => [
      key,
      value === '{locationId}' ? cfg.locationId : value,
    ])
  );
  const nextQuery = { ...defaults, ...(query ?? {}) };
  const nextBody = body === undefined ? undefined : { ...body };
  const locationParam = spec.locationParam ?? 'locationId';
  if (spec.location === 'query' && nextQuery[locationParam] === undefined)
    nextQuery[locationParam] = cfg.locationId;
  if (spec.location === 'body' && nextBody && nextBody.locationId === undefined) nextBody.locationId = cfg.locationId;
  if (spec.location === 'item' && isItem) return { query: nextQuery, body: nextBody, itemId: cfg.locationId };
  return { query: nextQuery, body: nextBody };
}

function redact(value, token) {
  if (typeof value === 'string') return token.length > 5 ? value.split(token).join('[REDACTED]') : value;
  if (Array.isArray(value)) return value.map((entry) => redact(entry, token));
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, entry]) => [
      /authorization|access.?token|api.?key|secret/i.test(key) ? key : key,
      /authorization|access.?token|api.?key|secret/i.test(key) ? '[REDACTED]' : redact(entry, token),
    ]));
  }
  return value;
}

async function request(method, path, query, body, ctx, version) {
  const cfg = config(ctx);
  const url = new URL(cleanPath(path), API_ORIGIN);
  addQuery(url, query);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error(`HighLevel request timed out after ${cfg.timeoutMs}ms`)), cfg.timeoutMs);
  const onAbort = () => controller.abort(ctx.signal?.reason);
  ctx.signal?.addEventListener('abort', onAbort, { once: true });
  try {
    ctx.log?.(`${method} ${url.pathname}`);
    const response = await fetch(url, {
      method,
      headers: {
        Accept: 'application/json',
        Authorization: `Bearer ${cfg.accessToken}`,
        Version: String(version ?? cfg.apiVersion),
        ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: controller.signal,
    });
    const text = await response.text();
    let output = null;
    if (text) {
      try { output = JSON.parse(text); }
      catch { output = text; }
    }
    output = redact(output, cfg.accessToken);
    if (!response.ok) {
      const detail = typeof output === 'string' ? output : JSON.stringify(output);
      throw new Error(`HighLevel ${response.status} ${response.statusText}: ${detail}`.slice(0, 4000));
    }
    return output;
  } catch (error) {
    const message = redact(String(error instanceof Error ? error.message : error), cfg.accessToken);
    throw new Error(message);
  } finally {
    clearTimeout(timer);
    ctx.signal?.removeEventListener('abort', onAbort);
  }
}

function inventory() {
  return {
    api: {
      origin: API_ORIGIN,
      authentication: 'HighLevel Private Integration token (API v2)',
      configuredContext: 'One selected sub-account/location',
      methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'],
    },
    genericEscapeHatch: 'api_get/api_post/api_put/api_patch/api_delete accept any relative v2 path on the fixed host.',
    families: Object.fromEntries(Object.entries(RESOURCE_FAMILIES).map(([name, spec]) => [name, {
      description: spec.description,
      collection: spec.collection,
      item: spec.item,
      locationBinding: spec.location,
    }])),
    accountBound: ACCOUNT_BOUND,
    interpretation: 'Availability is discovered empirically: token scopes, plan entitlements, rollout state, and resource ownership can permit or reject each route independently.',
  };
}

const adapter = {
  name: 'highlevel',
  version: '0.1.0',
  description: 'Maximum-surface HighLevel API v2 adapter for mapping a selected sub-account through Chinvat.',
  configSchema: [
    { key: 'accessToken', label: 'Private Integration token', type: 'secret', required: true, help: 'API v2 token created after selecting the target sub-account.' },
    { key: 'locationId', label: 'Sub-account / Location ID', type: 'string', required: true, help: 'HighLevel location ID bound to the Private Integration.' },
    { key: 'apiVersion', label: 'API version header', type: 'string', default: DEFAULT_VERSION },
    { key: 'timeoutMs', label: 'Request timeout (ms)', type: 'number', default: 60000 },
  ],
  activation: {
    kind: 'service',
    note: 'Create a Private Integration for the target sub-account, then enter its token and Location ID.',
  },
  capabilities: () => [...OPERATIONS],

  async health(ctx) {
    if (!ctx.config.accessToken || !ctx.config.locationId)
      return { ok: false, detail: 'not configured (accessToken and locationId required)' };
    try {
      const cfg = config(ctx);
      const result = await request('GET', `/locations/${encodeURIComponent(cleanId(cfg.locationId, 'locationId'))}`, undefined, undefined, ctx);
      const location = result?.location ?? result;
      const label = location?.name || location?.companyId || cfg.locationId;
      return { ok: true, detail: `connected to sub-account ${label}` };
    } catch (error) {
      return { ok: false, detail: String(error instanceof Error ? error.message : error) };
    }
  },

  async invoke(operation, args, ctx) {
    if (operation === 'capability_inventory') return { output: inventory() };
    if (operation === 'connection_health') {
      const status = await adapter.health(ctx);
      return { output: { ...status, origin: API_ORIGIN, apiVersion: String(ctx.config.apiVersion ?? DEFAULT_VERSION), tokenExposed: false } };
    }

    const rawMethods = {
      api_get: 'GET',
      api_post: 'POST',
      api_put: 'PUT',
      api_patch: 'PATCH',
      api_delete: 'DELETE',
    };
    if (rawMethods[operation]) {
      return { output: await request(rawMethods[operation], args.path, args.query, args.body, ctx, args.version) };
    }

    if (operation.startsWith('resource_')) {
      const cfg = config(ctx);
      const { spec } = family(args.family);
      if (operation === 'resource_list' || operation === 'resource_create') {
        const isList = operation === 'resource_list';
        const requestBody = isList && spec.listMethod === 'POST' ? { ...(spec.listBody ?? {}) } : args.body;
        const values = withLocation(spec, cfg, args.query, requestBody, false);
        const method = isList ? (spec.listMethod ?? 'GET') : 'POST';
        const route = isList ? (spec.list ?? spec.collection) : spec.collection;
        return { output: await request(method, fillPath(route, cfg), values.query, values.body, ctx) };
      }
      const values = withLocation(spec, cfg, args.query, args.body, true);
      const itemId = values.itemId ?? args.id;
      const itemPath = fillPath(spec.item, cfg, itemId);
      if (operation === 'resource_get')
        return { output: await request('GET', itemPath, values.query, undefined, ctx) };
      if (operation === 'resource_update') {
        const method = String(args.method ?? 'PUT').toUpperCase();
        if (!['PUT', 'PATCH'].includes(method)) throw new Error('resource_update method must be PUT or PATCH');
        return { output: await request(method, itemPath, values.query, values.body, ctx) };
      }
      if (operation === 'resource_delete')
        return { output: await request('DELETE', itemPath, values.query, undefined, ctx) };
    }
    throw new Error(`module 'highlevel' has no operation '${operation}' (use capabilities_describe)`);
  },
};

export { API_ORIGIN, DEFAULT_VERSION, RESOURCE_FAMILIES, inventory };
export default adapter;
