import type { ChinvatAdapter } from '../types.js';
import { cfgStr, jsonFetch, msg, requireConfig, unknownOp } from './util.js';

const GRAPH = 'https://graph.facebook.com';

const adapter: ChinvatAdapter = {
  name: 'whatsapp',
  version: '0.1.0',
  description:
    'WhatsApp Business Cloud API — send texts and templates. Requires a Meta app + phone number ID.',
  configSchema: [
    { key: 'accessToken', label: 'Access token', type: 'secret', required: true },
    { key: 'phoneNumberId', label: 'Phone number ID', type: 'string', required: true },
    { key: 'apiVersion', label: 'Graph API version', type: 'string', default: 'v21.0' },
  ],

  capabilities: () => [
    {
      name: 'send_text',
      description: 'Send a text message to a WhatsApp number (E.164, no +).',
      risk: 'act',
      params: {
        to: { type: 'string', required: true, description: 'e.g. 4915123456789' },
        text: { type: 'string', required: true },
        preview_url: { type: 'boolean' },
      },
    },
    {
      name: 'send_template',
      description: 'Send an approved template message (required outside the 24h window).',
      risk: 'act',
      params: {
        to: { type: 'string', required: true },
        template_name: { type: 'string', required: true },
        language: { type: 'string', description: 'default en_US' },
        components: { type: 'array', description: 'Graph API template components' },
      },
    },
    { name: 'phone_info', description: 'Registered phone number details.', risk: 'read', params: {} },
  ],

  health: async (ctx) => {
    try {
      requireConfig(ctx.config, ['accessToken', 'phoneNumberId']);
      const v = cfgStr(ctx.config, 'apiVersion', 'v21.0');
      const r = await jsonFetch(
        `${GRAPH}/${v}/${ctx.config.phoneNumberId}?fields=display_phone_number,verified_name`,
        { headers: { Authorization: `Bearer ${ctx.config.accessToken}` }, timeoutMs: 8000 }
      );
      return { ok: true, detail: `${r.verified_name ?? ''} ${r.display_phone_number ?? ''}`.trim() };
    } catch (e) {
      return { ok: false, detail: msg(e) };
    }
  },

  invoke: async (op, args, ctx) => {
    requireConfig(ctx.config, ['accessToken', 'phoneNumberId']);
    const v = cfgStr(ctx.config, 'apiVersion', 'v21.0');
    const url = `${GRAPH}/${v}/${ctx.config.phoneNumberId}/messages`;
    const headers = {
      Authorization: `Bearer ${ctx.config.accessToken}`,
      'Content-Type': 'application/json',
    };
    switch (op) {
      case 'send_text': {
        const r = await jsonFetch(url, {
          method: 'POST',
          headers,
          body: JSON.stringify({
            messaging_product: 'whatsapp',
            to: String(args.to),
            type: 'text',
            text: { body: String(args.text), preview_url: args.preview_url === true },
          }),
          signal: ctx.signal,
        });
        return { output: { message_id: r.messages?.[0]?.id } };
      }
      case 'send_template': {
        const r = await jsonFetch(url, {
          method: 'POST',
          headers,
          body: JSON.stringify({
            messaging_product: 'whatsapp',
            to: String(args.to),
            type: 'template',
            template: {
              name: String(args.template_name),
              language: { code: String(args.language ?? 'en_US') },
              components: args.components ?? [],
            },
          }),
          signal: ctx.signal,
        });
        return { output: { message_id: r.messages?.[0]?.id } };
      }
      case 'phone_info': {
        const r = await jsonFetch(
          `${GRAPH}/${v}/${ctx.config.phoneNumberId}?fields=display_phone_number,verified_name,quality_rating`,
          { headers, signal: ctx.signal }
        );
        return { output: r };
      }
      default:
        unknownOp('whatsapp', op);
    }
  },
};

export default adapter;
