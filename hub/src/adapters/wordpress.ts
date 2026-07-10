import { AdapterError, type ChinvatAdapter } from '../types.js';
import { cfgStr, jsonFetch, msg, requireConfig, unknownOp } from './util.js';

function wpBase(config: Record<string, unknown>): string {
  return cfgStr(config, 'siteUrl').replace(/\/+$/, '');
}

function authHeader(config: Record<string, unknown>): Record<string, string> {
  requireConfig(config, ['siteUrl', 'username', 'appPassword']);
  const basic = Buffer.from(`${config.username}:${config.appPassword}`).toString('base64');
  return { Authorization: `Basic ${basic}`, 'Content-Type': 'application/json' };
}

const adapter: ChinvatAdapter = {
  name: 'wordpress',
  version: '0.1.0',
  description: 'WordPress via REST API — posts, pages, media, taxonomy. Publishing is gated as dangerous.',
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

  capabilities: () => [
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
  ],

  health: async (ctx) => {
    try {
      requireConfig(ctx.config, ['siteUrl', 'username', 'appPassword']);
      const me = await jsonFetch(`${wpBase(ctx.config)}/wp-json/wp/v2/users/me`, {
        headers: authHeader(ctx.config),
        timeoutMs: 8000,
      });
      return { ok: true, detail: `authenticated as ${me.name ?? me.slug}` };
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
      default:
        unknownOp('wordpress', op);
    }
  },
};

export default adapter;
