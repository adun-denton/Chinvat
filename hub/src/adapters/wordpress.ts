import { AdapterError, type ChinvatAdapter, type OperationSpec, type Risk } from '../types.js';
import { cfgStr, jsonFetch, msg, requireConfig, unknownOp } from './util.js';

function wpBase(config: Record<string, unknown>): string {
  return cfgStr(config, 'siteUrl').replace(/\/+$/, '');
}

function authHeader(config: Record<string, unknown>): Record<string, string> {
  requireConfig(config, ['siteUrl', 'username', 'appPassword']);
  const basic = Buffer.from(`${config.username}:${config.appPassword}`).toString('base64');
  return { Authorization: `Basic ${basic}`, 'Content-Type': 'application/json' };
}

// --- Chinvat WP Bridge companion plugin ---------------------------------------
// The Bridge exposes extended admin abilities (options RW, theme file I/O,
// RankMath, plugin management) through the WordPress Abilities API, plus an
// /info handshake. This adapter reaches them via the abilities "run" endpoint:
//   readonly      -> GET  .../abilities/{name}/run?input[key]=value
//   act|dangerous -> POST .../abilities/{name}/run  body {"input":{...}}
// Writes only take effect when Developer Mode + the matching per-capability
// toggle are enabled in the Bridge settings; otherwise the Bridge returns a
// clear error which surfaces here unchanged.

const BRIDGE_INFO_PATH = '/wp-json/chinvat-bridge/v1/info';
const ABILITIES_BASE = '/wp-json/wp-abilities/v1/abilities';

/** op name -> ability slug, risk, and declared input keys (POST for non-read). */
interface BridgeOp {
  op: string;
  ability: string;
  risk: Risk;
  /** Ability is annotated destructive:true — the Abilities run route requires DELETE for these. */
  destructive?: boolean;
  description: string;
  params: Record<string, { type: 'string' | 'number' | 'boolean' | 'object' | 'array'; description?: string; required?: boolean }>;
}

const BRIDGE_OPS: BridgeOp[] = [
  {
    op: 'bridge_info',
    ability: '', // special-cased: hits the /info handshake, not an ability
    risk: 'read',
    description: 'Bridge handshake: version, toggles, active theme, RankMath status.',
    params: {},
  },
  {
    op: 'bridge_option_get',
    ability: 'chinvat-bridge/options-get',
    risk: 'read',
    description: 'Read a single wp_options value (denylist-guarded).',
    params: { key: { type: 'string', required: true } },
  },
  {
    op: 'bridge_option_update',
    destructive: true,
    ability: 'chinvat-bridge/options-update',
    risk: 'act',
    description: 'Write a single wp_options value (denylist-guarded; needs options_update toggle).',
    params: {
      key: { type: 'string', required: true },
      value: { type: 'object', required: true, description: 'scalar or JSON-serialisable value' },
    },
  },
  {
    op: 'bridge_theme_list',
    ability: 'chinvat-bridge/theme-list',
    risk: 'read',
    description: 'List files in the active theme (symlinks not followed).',
    params: {},
  },
  {
    op: 'bridge_theme_read',
    ability: 'chinvat-bridge/theme-read',
    risk: 'read',
    description: 'Read a file from the active theme.',
    params: { path: { type: 'string', required: true } },
  },
  {
    op: 'bridge_theme_write',
    destructive: true,
    ability: 'chinvat-bridge/theme-write',
    risk: 'dangerous',
    description: 'Write a file into the active theme (confined, PHP-linted, backed up, atomic). Arbitrary PHP = RCE by design; needs theme_write toggle.',
    params: {
      path: { type: 'string', required: true },
      content: { type: 'string', required: true },
    },
  },
  {
    op: 'bridge_rankmath_get',
    ability: 'chinvat-bridge/rankmath-get',
    risk: 'read',
    description: 'Read RankMath SEO fields for a post.',
    params: { post_id: { type: 'number', required: true } },
  },
  {
    op: 'bridge_rankmath_update',
    ability: 'chinvat-bridge/rankmath-update',
    risk: 'act',
    description: 'Update RankMath SEO fields for a post.',
    params: {
      post_id: { type: 'number', required: true },
      title: { type: 'string' },
      description: { type: 'string' },
      focus_kw: { type: 'string' },
      robots: { type: 'string' },
      canonical: { type: 'string' },
    },
  },
  {
    op: 'bridge_plugins_list',
    ability: 'chinvat-bridge/plugins-list',
    risk: 'read',
    description: 'List installed plugins and their status.',
    params: {},
  },
  {
    op: 'bridge_plugins_toggle',
    destructive: true,
    ability: 'chinvat-bridge/plugins-toggle',
    risk: 'act',
    description: 'Activate or deactivate a plugin (protected plugins refused; needs plugins_toggle toggle).',
    params: {
      file: { type: 'string', required: true },
      action: { type: 'string', required: true, description: 'activate | deactivate' },
    },
  },
  {
    op: 'bridge_theme_scaffold_child',
    destructive: true,
    ability: 'chinvat-bridge/theme-scaffold-child',
    risk: 'dangerous',
    description: 'Create a block-aware child of the active theme (style.css, theme.json, header/footer parts, templates dir) and optionally activate it, giving theme-write an update-proof target. Needs child_scaffold toggle.',
    params: {
      slug: { type: 'string', description: 'child theme slug; defaults to {parent}-child' },
      name: { type: 'string', description: 'display name' },
      activate: { type: 'boolean', description: 'switch the live site to the child (default true)' },
    },
  },
  {
    op: 'bridge_db_state',
    ability: 'chinvat-bridge/db-state',
    risk: 'read',
    description: 'Which layer owns rendering right now: user Global Styles post, DB template/part overrides, active theme identity. Call before styling work to know where to write.',
    params: {},
  },
  {
    op: 'bridge_global_styles_get',
    ability: 'chinvat-bridge/global-styles-get',
    risk: 'read',
    description: 'Read the user Global Styles config (wp_global_styles post) — the DB styles layer that overrides theme.json at runtime.',
    params: {},
  },
  {
    op: 'bridge_global_styles_update',
    destructive: true,
    ability: 'chinvat-bridge/global-styles-update',
    risk: 'act',
    description: 'Write the user Global Styles config (theme.json-shaped). merge=true deep-merges; default replaces. Writes the layer that actually renders; needs db_layer toggle.',
    params: {
      styles: { type: 'object', required: true, description: 'theme.json-shaped config (settings/styles), object or JSON string' },
      merge: { type: 'boolean', description: 'deep-merge into existing config instead of replacing (default false)' },
    },
  },
  {
    op: 'bridge_global_styles_reset',
    destructive: true,
    ability: 'chinvat-bridge/global-styles-reset',
    risk: 'act',
    description: 'Remove the user Global Styles override so theme.json files render again. Trashes (recoverable) unless force=true; needs db_layer toggle.',
    params: {
      force: { type: 'boolean', description: 'permanently delete instead of trashing (default false)' },
    },
  },
  {
    op: 'bridge_template_list',
    ability: 'chinvat-bridge/template-list',
    risk: 'read',
    description: 'List block templates and template parts with source per item (theme file vs DB override).',
    params: {},
  },
  {
    op: 'bridge_template_get',
    ability: 'chinvat-bridge/template-get',
    risk: 'read',
    description: 'Read one template/part as it resolves at runtime (DB override wins over theme file).',
    params: {
      type: { type: 'string', required: true, description: 'wp_template | wp_template_part' },
      slug: { type: 'string', required: true },
    },
  },
  {
    op: 'bridge_template_update',
    destructive: true,
    ability: 'chinvat-bridge/template-update',
    risk: 'act',
    description: 'Write block markup to the DB layer for a template/part (updates or creates the override) — the write that actually renders. Needs db_layer toggle.',
    params: {
      type: { type: 'string', required: true, description: 'wp_template | wp_template_part' },
      slug: { type: 'string', required: true },
      content: { type: 'string', required: true, description: 'block markup (HTML comments syntax)' },
      title: { type: 'string' },
      area: { type: 'string', description: 'parts only: header|footer|uncategorized (create only)' },
    },
  },
  {
    op: 'bridge_template_reset',
    destructive: true,
    ability: 'chinvat-bridge/template-reset',
    risk: 'act',
    description: 'Remove the DB override for a template/part so the theme file renders again. Trashes (recoverable) unless force=true; needs db_layer toggle.',
    params: {
      type: { type: 'string', required: true, description: 'wp_template | wp_template_part' },
      slug: { type: 'string', required: true },
      force: { type: 'boolean', description: 'permanently delete instead of trashing (default false)' },
    },
  },
];

const BRIDGE_OP_BY_NAME = new Map(BRIDGE_OPS.map((b) => [b.op, b]));

/** Collect the declared input keys for an op into an input object, dropping undefined. */
function collectInput(spec: BridgeOp, args: Record<string, unknown>): Record<string, unknown> {
  const input: Record<string, unknown> = {};
  for (const key of Object.keys(spec.params)) {
    if (args[key] !== undefined) input[key] = args[key];
  }
  for (const [key, p] of Object.entries(spec.params)) {
    if (p.required && input[key] === undefined) {
      throw new AdapterError(`missing required arg '${key}' for ${spec.op}`);
    }
  }
  return input;
}

/** Invoke a Bridge ability via the WordPress Abilities API run endpoint. */
async function runBridgeAbility(
  config: Record<string, unknown>,
  spec: BridgeOp,
  input: Record<string, unknown>,
  signal?: AbortSignal
): Promise<unknown> {
  const headers = authHeader(config);
  const runUrl = `${wpBase(config)}${ABILITIES_BASE}/${spec.ability}/run`;
  if (spec.risk === 'read') {
    // Readonly abilities accept GET with nested input[...] query params.
    const q = new URLSearchParams();
    for (const [k, v] of Object.entries(input)) {
      q.set(`input[${k}]`, typeof v === 'object' ? JSON.stringify(v) : String(v));
    }
    // The Abilities run route requires an input object even on GET; send
    // a bare input= (empty string passes rest_is_object and sanitizes to []) when there are no keys.
    const qs = q.toString();
    return jsonFetch(`${runUrl}?${qs || 'input='}`, { headers, signal });
  }
  // act | dangerous -> POST { input }. Destructive-annotated abilities must run
  // as DELETE, but shared hosts (LiteSpeed) strip DELETE bodies — so send POST
  // with X-HTTP-Method-Override, which the WP REST server honors.
  return jsonFetch(runUrl, {
    method: 'POST',
    headers: spec.destructive ? { ...headers, 'X-HTTP-Method-Override': 'DELETE' } : headers,
    body: JSON.stringify({ input }),
    signal,
    timeoutMs: 120_000,
  });
}

const adapter: ChinvatAdapter = {
  name: 'wordpress',
  version: '0.3.0',
  description:
    'WordPress via REST API — posts, pages, media, taxonomy. Optional Chinvat WP Bridge companion plugin adds options, theme file I/O, DB-layer Global Styles and template overrides (the layer that wins at runtime), RankMath and plugin management (bridge_* ops). Publishing and theme writes are gated as dangerous.',
  configSchema: [
    { key: 'siteUrl', label: 'Site URL', type: 'string', required: true, placeholder: 'https://example.com' },
    { key: 'username', label: 'Username', type: 'string', required: true },
    {
      key: 'appPassword',
      label: 'Application password',
      type: 'secret',
      required: true,
      help: 'WP Admin → Users → Profile → Application Passwords',
    },
  ],

  capabilities: () => {
    const core: OperationSpec[] = [
      { name: 'site_info', description: 'Site name/description/URL.', risk: 'read', params: {} },
      {
        name: 'list_posts',
        description: 'List posts.',
        risk: 'read',
        params: {
          status: { type: 'string', description: 'publish|draft|any' },
          search: { type: 'string' },
          per_page: { type: 'number' },
        },
      },
      { name: 'get_post', description: 'One post with content.', risk: 'read', params: { id: { type: 'number', required: true } } },
      {
        name: 'create_post',
        description: 'Create a post (draft by default — publishing is a separate, dangerous op).',
        risk: 'act',
        params: {
          title: { type: 'string', required: true },
          content: { type: 'string', required: true, description: 'HTML or block markup' },
          excerpt: { type: 'string' },
          categories: { type: 'array', description: 'category IDs' },
          tags: { type: 'array', description: 'tag IDs' },
        },
      },
      {
        name: 'update_post',
        description: 'Update fields on an existing post (not status).',
        risk: 'act',
        params: {
          id: { type: 'number', required: true },
          title: { type: 'string' },
          content: { type: 'string' },
          excerpt: { type: 'string' },
        },
      },
      {
        name: 'publish_post',
        description: 'Set a post live.',
        risk: 'dangerous',
        params: { id: { type: 'number', required: true } },
      },
      {
        name: 'delete_post',
        description: 'Trash a post.',
        risk: 'dangerous',
        params: { id: { type: 'number', required: true } },
      },
      {
        name: 'upload_media',
        description: 'Sideload media from a URL.',
        risk: 'act',
        params: {
          source_url: { type: 'string', required: true },
          filename: { type: 'string' },
          alt_text: { type: 'string' },
        },
      },
      { name: 'list_categories', description: 'Categories with IDs.', risk: 'read', params: {} },
      { name: 'list_tags', description: 'Tags with IDs.', risk: 'read', params: {} },
      {
        name: 'create_page',
        description: 'Create a page (draft).',
        risk: 'act',
        params: { title: { type: 'string', required: true }, content: { type: 'string', required: true } },
      },
      {
        name: 'list_pages',
        description: 'List pages.',
        risk: 'read',
        params: {
          status: { type: 'string', description: 'publish|draft|any' },
          search: { type: 'string' },
          per_page: { type: 'number' },
        },
      },
      {
        name: 'publish_page',
        description: 'Set a page live.',
        risk: 'dangerous',
        params: { id: { type: 'number', required: true } },
      },
      {
        name: 'delete_page',
        description: 'Trash a page.',
        risk: 'dangerous',
        params: { id: { type: 'number', required: true } },
      },
    ];
    const bridge: OperationSpec[] = BRIDGE_OPS.map((b) => ({
      name: b.op,
      description: b.description,
      risk: b.risk,
      params: b.params,
    }));
    return [...core, ...bridge];
  },

  health: async (ctx) => {
    try {
      requireConfig(ctx.config, ['siteUrl', 'username', 'appPassword']);
      const me = await jsonFetch(`${wpBase(ctx.config)}/wp-json/wp/v2/users/me`, {
        headers: authHeader(ctx.config),
        timeoutMs: 8000,
      });
      // Best-effort Bridge detection — never fails health if the Bridge is absent.
      let bridge = '';
      try {
        const info = await jsonFetch(`${wpBase(ctx.config)}${BRIDGE_INFO_PATH}`, {
          headers: authHeader(ctx.config),
          timeoutMs: 6000,
        });
        if (info?.version) {
          bridge = ` · bridge v${info.version}${info.writes_enabled ? ' (writes on)' : ''}`;
        }
      } catch {
        // Bridge not installed / not reachable — ignore.
      }
      return { ok: true, detail: `authenticated as ${me.name ?? me.slug}${bridge}` };
    } catch (e) {
      return { ok: false, detail: msg(e) };
    }
  },

  invoke: async (op, args, ctx) => {
    const base = `${wpBase(ctx.config)}/wp-json/wp/v2`;
    const headers = authHeader(ctx.config);
    const slim = (p: any) => ({
      id: p.id,
      status: p.status,
      title: p.title?.rendered ?? p.title?.raw,
      link: p.link,
      date: p.date,
    });

    // --- Bridge ops -----------------------------------------------------------
    const bridgeSpec = BRIDGE_OP_BY_NAME.get(op);
    if (bridgeSpec) {
      if (bridgeSpec.op === 'bridge_info') {
        const info = await jsonFetch(`${wpBase(ctx.config)}${BRIDGE_INFO_PATH}`, {
          headers,
          signal: ctx.signal,
        });
        return { output: info };
      }
      const input = collectInput(bridgeSpec, args);
      const out = await runBridgeAbility(ctx.config, bridgeSpec, input, ctx.signal);
      return { output: out };
    }

    switch (op) {
      case 'site_info': {
        const r = await jsonFetch(`${wpBase(ctx.config)}/wp-json`, { headers, signal: ctx.signal });
        return { output: { name: r.name, description: r.description, url: r.url } };
      }
      case 'list_posts': {
        const q = new URLSearchParams();
        if (args.status) q.set('status', String(args.status));
        if (args.search) q.set('search', String(args.search));
        q.set('per_page', String(Math.min(Number(args.per_page ?? 10), 50)));
        const r = await jsonFetch(`${base}/posts?${q}`, { headers, signal: ctx.signal });
        return { output: (r as any[]).map(slim) };
      }
      case 'get_post': {
        const r = await jsonFetch(`${base}/posts/${Number(args.id)}?context=edit`, { headers, signal: ctx.signal });
        return {
          output: { ...slim(r), content: r.content?.raw ?? r.content?.rendered, excerpt: r.excerpt?.raw },
        };
      }
      case 'create_post': {
        const body: Record<string, unknown> = {
          title: args.title,
          content: args.content,
          status: 'draft',
        };
        if (args.excerpt) body.excerpt = args.excerpt;
        if (args.categories) body.categories = args.categories;
        if (args.tags) body.tags = args.tags;
        const r = await jsonFetch(`${base}/posts`, {
          method: 'POST',
          headers,
          body: JSON.stringify(body),
          signal: ctx.signal,
        });
        return { output: slim(r) };
      }
      case 'update_post': {
        const body: Record<string, unknown> = {};
        for (const k of ['title', 'content', 'excerpt'] as const) if (args[k] !== undefined) body[k] = args[k];
        if (!Object.keys(body).length) throw new AdapterError('nothing to update');
        const r = await jsonFetch(`${base}/posts/${Number(args.id)}`, {
          method: 'POST',
          headers,
          body: JSON.stringify(body),
          signal: ctx.signal,
        });
        return { output: slim(r) };
      }
      case 'publish_post': {
        const r = await jsonFetch(`${base}/posts/${Number(args.id)}`, {
          method: 'POST',
          headers,
          body: JSON.stringify({ status: 'publish' }),
          signal: ctx.signal,
        });
        return { output: slim(r) };
      }
      case 'delete_post': {
        const r = await jsonFetch(`${base}/posts/${Number(args.id)}`, {
          method: 'DELETE',
          headers,
          signal: ctx.signal,
        });
        return { output: { id: r.id, status: r.status } };
      }
      case 'upload_media': {
        const src = String(args.source_url);
        const fileRes = await fetch(src, { signal: ctx.signal });
        if (!fileRes.ok) throw new AdapterError(`could not fetch source_url (HTTP ${fileRes.status})`);
        const buf = Buffer.from(await fileRes.arrayBuffer());
        const filename = String(args.filename ?? src.split('/').pop() ?? 'upload.bin');
        const r = await jsonFetch(`${base}/media`, {
          method: 'POST',
          headers: {
            Authorization: headers.Authorization,
            'Content-Type': fileRes.headers.get('content-type') ?? 'application/octet-stream',
            'Content-Disposition': `attachment; filename="${filename}"`,
          },
          body: buf,
          signal: ctx.signal,
          timeoutMs: 120_000,
        });
        if (args.alt_text) {
          await jsonFetch(`${base}/media/${r.id}`, {
            method: 'POST',
            headers,
            body: JSON.stringify({ alt_text: args.alt_text }),
          }).catch(() => undefined);
        }
        return { output: { id: r.id, source_url: r.source_url } };
      }
      case 'list_categories': {
        const r = await jsonFetch(`${base}/categories?per_page=100`, { headers, signal: ctx.signal });
        return { output: (r as any[]).map((c) => ({ id: c.id, name: c.name, count: c.count })) };
      }
      case 'list_tags': {
        const r = await jsonFetch(`${base}/tags?per_page=100`, { headers, signal: ctx.signal });
        return { output: (r as any[]).map((t) => ({ id: t.id, name: t.name, count: t.count })) };
      }
      case 'create_page': {
        const r = await jsonFetch(`${base}/pages`, {
          method: 'POST',
          headers,
          body: JSON.stringify({ title: args.title, content: args.content, status: 'draft' }),
          signal: ctx.signal,
        });
        return { output: slim(r) };
      }
      case 'list_pages': {
        const q = new URLSearchParams();
        if (args.status) q.set('status', String(args.status));
        if (args.search) q.set('search', String(args.search));
        q.set('per_page', String(Math.min(Number(args.per_page ?? 10), 50)));
        const r = await jsonFetch(`${base}/pages?${q}`, { headers, signal: ctx.signal });
        return { output: (r as any[]).map(slim) };
      }
      case 'publish_page': {
        const r = await jsonFetch(`${base}/pages/${Number(args.id)}`, {
          method: 'POST',
          headers,
          body: JSON.stringify({ status: 'publish' }),
          signal: ctx.signal,
        });
        return { output: slim(r) };
      }
      case 'delete_page': {
        const r = await jsonFetch(`${base}/pages/${Number(args.id)}`, {
          method: 'DELETE',
          headers,
          signal: ctx.signal,
        });
        return { output: { id: r.id, status: r.status } };
      }
      default:
        unknownOp('wordpress', op);
    }
  },
};

export default adapter;
