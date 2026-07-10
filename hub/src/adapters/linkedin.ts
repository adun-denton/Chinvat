import type { ChinvatAdapter } from '../types.js';
import { cfgStr, jsonFetch, msg, requireConfig, unknownOp } from './util.js';

const API = 'https://api.linkedin.com';

const adapter: ChinvatAdapter = {
  name: 'linkedin',
  version: '0.1.0',
  description: 'LinkedIn member posting (Share on LinkedIn product, w_member_social scope).',
  configSchema: [
    { key: 'accessToken', label: 'Access token', type: 'secret', required: true, help: '3-legged OAuth token with w_member_social' },
    {
      key: 'authorUrn',
      label: 'Author URN',
      type: 'string',
      required: true,
      placeholder: 'urn:li:person:AbC123',
      help: 'GET /v2/userinfo → sub → urn:li:person:<sub>',
    },
  ],

  capabilities: () => [
    {
      name: 'create_post',
      description: 'Publish a text post as the member.',
      risk: 'act',
      params: {
        text: { type: 'string', required: true },
        visibility: { type: 'string', description: 'PUBLIC (default) or CONNECTIONS' },
      },
    },
    { name: 'me', description: 'Token identity check (OpenID userinfo).', risk: 'read', params: {} },
  ],

  health: async (ctx) => {
    try {
      requireConfig(ctx.config, ['accessToken', 'authorUrn']);
      const r = await jsonFetch(`${API}/v2/userinfo`, {
        headers: { Authorization: `Bearer ${ctx.config.accessToken}` },
        timeoutMs: 8000,
      });
      return { ok: true, detail: r.name ?? r.sub };
    } catch (e) {
      return { ok: false, detail: msg(e) };
    }
  },

  invoke: async (op, args, ctx) => {
    const token = cfgStr(ctx.config, 'accessToken');
    switch (op) {
      case 'create_post': {
        const authorUrn = cfgStr(ctx.config, 'authorUrn');
        const visibility = String(args.visibility ?? 'PUBLIC') === 'CONNECTIONS' ? 'CONNECTIONS' : 'PUBLIC';
        const r = await jsonFetch(`${API}/v2/ugcPosts`, {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${token}`,
            'Content-Type': 'application/json',
            'X-Restli-Protocol-Version': '2.0.0',
          },
          body: JSON.stringify({
            author: authorUrn,
            lifecycleState: 'PUBLISHED',
            specificContent: {
              'com.linkedin.ugc.ShareContent': {
                shareCommentary: { text: String(args.text) },
                shareMediaCategory: 'NONE',
              },
            },
            visibility: { 'com.linkedin.ugc.MemberNetworkVisibility': visibility },
          }),
          signal: ctx.signal,
        });
        return { output: { post_id: r.id ?? 'created' } };
      }
      case 'me': {
        const r = await jsonFetch(`${API}/v2/userinfo`, {
          headers: { Authorization: `Bearer ${token}` },
          signal: ctx.signal,
        });
        return { output: { sub: r.sub, name: r.name, urn_hint: `urn:li:person:${r.sub}` } };
      }
      default:
        unknownOp('linkedin', op);
    }
  },
};

export default adapter;
