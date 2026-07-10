import { AdapterError, type ChinvatAdapter } from '../types.js';
import { cfgStr, jsonFetch, msg, requireConfig, unknownOp } from './util.js';

const GRAPH = 'https://graph.facebook.com';

const adapter: ChinvatAdapter = {
  name: 'instagram',
  version: '0.1.0',
  description:
    'Instagram Graph API (business/creator accounts) — publish photos, list media.',
  configSchema: [
    { key: 'igUserId', label: 'IG user ID', type: 'string', required: true, help: 'Business account ID from Graph API' },
    { key: 'accessToken', label: 'Access token', type: 'secret', required: true },
    { key: 'apiVersion', label: 'Graph API version', type: 'string', default: 'v21.0' },
  ],

  capabilities: () => [
    {
      name: 'publish_photo',
      description: 'Two-step container publish of a photo from a public image URL.',
      risk: 'act',
      params: {
        image_url: { type: 'string', required: true, description: 'must be publicly reachable' },
        caption: { type: 'string' },
      },
    },
    {
      name: 'list_media',
      description: 'Recent media with permalinks.',
      risk: 'read',
      params: { limit: { type: 'number' } },
    },
    { name: 'account_info', description: 'Username, followers, media count.', risk: 'read', params: {} },
  ],

  health: async (ctx) => {
    try {
      requireConfig(ctx.config, ['igUserId', 'accessToken']);
      const v = cfgStr(ctx.config, 'apiVersion', 'v21.0');
      const r = await jsonFetch(
        `${GRAPH}/${v}/${ctx.config.igUserId}?fields=username&access_token=${ctx.config.accessToken}`,
        { timeoutMs: 8000 }
      );
      return { ok: true, detail: `@${r.username}` };
    } catch (e) {
      return { ok: false, detail: msg(e) };
    }
  },

  invoke: async (op, args, ctx) => {
    requireConfig(ctx.config, ['igUserId', 'accessToken']);
    const v = cfgStr(ctx.config, 'apiVersion', 'v21.0');
    const token = String(ctx.config.accessToken);
    const igId = String(ctx.config.igUserId);
    switch (op) {
      case 'publish_photo': {
        const container = await jsonFetch(`${GRAPH}/${v}/${igId}/media`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            image_url: String(args.image_url),
            caption: args.caption ? String(args.caption) : undefined,
            access_token: token,
          }),
          signal: ctx.signal,
        });
        if (!container.id) throw new AdapterError('container creation failed');
        ctx.log(`media container ${container.id} created, publishing…`);
        const published = await jsonFetch(`${GRAPH}/${v}/${igId}/media_publish`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ creation_id: container.id, access_token: token }),
          signal: ctx.signal,
          timeoutMs: 120_000,
        });
        return { output: { media_id: published.id } };
      }
      case 'list_media': {
        const limit = Math.min(Number(args.limit ?? 10), 50);
        const r = await jsonFetch(
          `${GRAPH}/${v}/${igId}/media?fields=id,caption,media_type,permalink,timestamp&limit=${limit}&access_token=${token}`,
          { signal: ctx.signal }
        );
        return { output: r.data ?? [] };
      }
      case 'account_info': {
        const r = await jsonFetch(
          `${GRAPH}/${v}/${igId}?fields=username,followers_count,media_count,biography&access_token=${token}`,
          { signal: ctx.signal }
        );
        return { output: r };
      }
      default:
        unknownOp('instagram', op);
    }
  },
};

export default adapter;
