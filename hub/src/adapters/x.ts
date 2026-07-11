import { AdapterError, type ChinvatAdapter } from '../types.js';
import { cfgStr, jsonFetch, msg, requireConfig, unknownOp } from './util.js';

const API = 'https://api.twitter.com/2';

const adapter: ChinvatAdapter = {
  name: 'x',
  version: '0.1.0',
  description: 'X (Twitter) via API v2 — post, reply, delete, read your account and search.',
  configSchema: [
    {
      key: 'accessToken',
      label: 'OAuth 2.0 user access token',
      type: 'secret',
      required: true,
      help: 'From an app at developer.x.com with scopes tweet.read, tweet.write, users.read. Posting requires a write-enabled access tier.',
    },
  ],

  capabilities: () => [
    {
      name: 'post_tweet',
      description: 'Publish a post (tweet). Up to 280 chars on standard access.',
      risk: 'act',
      params: {
        text: { type: 'string', required: true },
        reply_to: { type: 'string', description: 'tweet id to reply to' },
      },
    },
    {
      name: 'delete_tweet',
      description: 'Delete one of your posts.',
      risk: 'dangerous',
      params: { id: { type: 'string', required: true } },
    },
    { name: 'me', description: 'Authenticated account (id, username, name).', risk: 'read', params: {} },
    {
      name: 'search_recent',
      description: 'Recent posts matching a query (needs a read-enabled access tier).',
      risk: 'read',
      params: {
        query: { type: 'string', required: true },
        max_results: { type: 'number', description: 'default 10 (10-100)' },
      },
    },
  ],

  health: async (ctx) => {
    if (!ctx.config.accessToken) return { ok: false, detail: 'accessToken not configured' };
    try {
      const r = await jsonFetch<{ data?: { username?: string } }>(`${API}/users/me`, {
        headers: { Authorization: `Bearer ${ctx.config.accessToken}` },
        timeoutMs: 8000,
      });
      return { ok: true, detail: r.data?.username ? `@${r.data.username}` : 'token valid' };
    } catch (e) {
      return { ok: false, detail: msg(e) };
    }
  },

  invoke: async (op, args, ctx) => {
    requireConfig(ctx.config, ['accessToken']);
    const headers = {
      Authorization: `Bearer ${cfgStr(ctx.config, 'accessToken')}`,
      'Content-Type': 'application/json',
    };
    switch (op) {
      case 'post_tweet': {
        const body: Record<string, unknown> = { text: String(args.text) };
        if (args.reply_to) body.reply = { in_reply_to_tweet_id: String(args.reply_to) };
        const r = await jsonFetch(`${API}/tweets`, {
          method: 'POST',
          headers,
          body: JSON.stringify(body),
          signal: ctx.signal,
        });
        return { output: { id: r.data?.id, text: r.data?.text } };
      }
      case 'delete_tweet': {
        const r = await jsonFetch(`${API}/tweets/${String(args.id)}`, {
          method: 'DELETE',
          headers,
          signal: ctx.signal,
        });
        return { output: { deleted: r.data?.deleted ?? true, id: String(args.id) } };
      }
      case 'me': {
        const r = await jsonFetch(`${API}/users/me?user.fields=public_metrics`, { headers, signal: ctx.signal });
        return { output: r.data };
      }
      case 'search_recent': {
        const q = new URLSearchParams({
          query: String(args.query),
          max_results: String(Math.min(Math.max(Number(args.max_results ?? 10), 10), 100)),
        });
        const r = await jsonFetch(`${API}/tweets/search/recent?${q}`, { headers, signal: ctx.signal });
        return { output: r.data ?? [] };
      }
      default:
        unknownOp('x', op);
    }
  },
};

export default adapter;
