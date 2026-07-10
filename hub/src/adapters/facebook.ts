import type { ChinvatAdapter } from '../types.js';
import { cfgStr, jsonFetch, msg, requireConfig, unknownOp } from './util.js';

const GRAPH = 'https://graph.facebook.com';

const adapter: ChinvatAdapter = {
  name: 'facebook',
  version: '0.1.0',
  description: 'Facebook Page publishing via Graph API. Requires a page access token.',
  configSchema: [
    { key: 'pageId', label: 'Page ID', type: 'string', required: true },
    {
      key: 'pageAccessToken',
      label: 'Page access token',
      type: 'secret',
      required: true,
      help: 'Long-lived page token with pages_manage_posts',
    },
    { key: 'apiVersion', label: 'Graph API version', type: 'string', default: 'v21.0' },
  ],

  capabilities: () => [
    {
      name: 'create_post',
      description: 'Publish a post on the page feed.',
      risk: 'act',
      params: { message: { type: 'string', required: true }, link: { type: 'string' } },
    },
    {
      name: 'list_posts',
      description: 'Recent page posts.',
      risk: 'read',
      params: { limit: { type: 'number', description: 'default 10' } },
    },
    {
      name: 'delete_post',
      description: 'Delete a page post.',
      risk: 'dangerous',
      params: { post_id: { type: 'string', required: true } },
    },
    { name: 'page_info', description: 'Page name, fans, link.', risk: 'read', params: {} },
  ],

  health: async (ctx) => {
    try {
      requireConfig(ctx.config, ['pageId', 'pageAccessToken']);
      const v = cfgStr(ctx.config, 'apiVersion', 'v21.0');
      const r = await jsonFetch(
        `${GRAPH}/${v}/${ctx.config.pageId}?fields=name&access_token=${ctx.config.pageAccessToken}`,
        { timeoutMs: 8000 }
      );
      return { ok: true, detail: r.name };
    } catch (e) {
      return { ok: false, detail: msg(e) };
    }
  },

  invoke: async (op, args, ctx) => {
    requireConfig(ctx.config, ['pageId', 'pageAccessToken']);
    const v = cfgStr(ctx.config, 'apiVersion', 'v21.0');
    const token = String(ctx.config.pageAccessToken);
    const pageId = String(ctx.config.pageId);
    switch (op) {
      case 'create_post': {
        const body: Record<string, unknown> = { message: String(args.message), access_token: token };
        if (args.link) body.link = String(args.link);
        const r = await jsonFetch(`${GRAPH}/${v}/${pageId}/feed`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
          signal: ctx.signal,
        });
        return { output: { post_id: r.id } };
      }
      case 'list_posts': {
        const limit = Math.min(Number(args.limit ?? 10), 50);
        const r = await jsonFetch(
          `${GRAPH}/${v}/${pageId}/posts?fields=id,message,created_time,permalink_url&limit=${limit}&access_token=${token}`,
          { signal: ctx.signal }
        );
        return { output: r.data ?? [] };
      }
      case 'delete_post': {
        const r = await jsonFetch(
          `${GRAPH}/${v}/${String(args.post_id)}?access_token=${token}`,
          { method: 'DELETE', signal: ctx.signal }
        );
        return { output: r };
      }
      case 'page_info': {
        const r = await jsonFetch(
          `${GRAPH}/${v}/${pageId}?fields=name,fan_count,link,about&access_token=${token}`,
          { signal: ctx.signal }
        );
        return { output: r };
      }
      default:
        unknownOp('facebook', op);
    }
  },
};

export default adapter;
