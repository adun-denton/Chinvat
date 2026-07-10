import type { ChinvatAdapter } from '../types.js';
import { cfgStr, jsonFetch, msg, unknownOp } from './util.js';

const BASE = 'https://openrouter.ai/api/v1';

const adapter: ChinvatAdapter = {
  name: 'openrouter',
  version: '0.1.0',
  description: 'Remote specialist models via OpenRouter — one key, hundreds of models.',
  configSchema: [
    { key: 'apiKey', label: 'API key', type: 'secret', required: true },
    {
      key: 'defaultModel',
      label: 'Default model',
      type: 'string',
      default: 'openrouter/auto',
      help: 'openrouter/auto lets OpenRouter pick; or pin e.g. anthropic/claude-sonnet',
    },
  ],

  capabilities: () => [
    {
      name: 'chat',
      description: 'Chat completion via OpenRouter. Provide messages[] or a prompt string.',
      risk: 'read',
      params: {
        model: { type: 'string' },
        prompt: { type: 'string' },
        messages: { type: 'array' },
        temperature: { type: 'number' },
        max_tokens: { type: 'number' },
      },
    },
    { name: 'list_models', description: 'Available model catalog.', risk: 'read', params: {} },
    { name: 'key_info', description: 'Key usage/limits.', risk: 'read', params: {} },
  ],

  health: async (ctx) => {
    const apiKey = ctx.config.apiKey;
    if (!apiKey) return { ok: false, detail: 'apiKey not configured' };
    try {
      await jsonFetch(`${BASE}/key`, {
        headers: { Authorization: `Bearer ${apiKey}` },
        timeoutMs: 6000,
      });
      return { ok: true, detail: 'key valid' };
    } catch (e) {
      return { ok: false, detail: msg(e) };
    }
  },

  invoke: async (op, args, ctx) => {
    const headers = {
      Authorization: `Bearer ${cfgStr(ctx.config, 'apiKey')}`,
      'Content-Type': 'application/json',
      'HTTP-Referer': 'https://github.com/adun-denton/Chinvat',
      'X-Title': 'Chinvat',
    };
    switch (op) {
      case 'chat': {
        const model = String(args.model ?? ctx.config.defaultModel ?? 'openrouter/auto');
        const messages =
          (args.messages as unknown[]) ??
          [{ role: 'user', content: String(args.prompt ?? '') }];
        const body: Record<string, unknown> = { model, messages };
        if (args.temperature !== undefined) body.temperature = args.temperature;
        if (args.max_tokens !== undefined) body.max_tokens = args.max_tokens;
        const r = await jsonFetch(`${BASE}/chat/completions`, {
          method: 'POST',
          headers,
          body: JSON.stringify(body),
          signal: ctx.signal,
          timeoutMs: 600_000,
        });
        return {
          output: {
            model: r.model,
            message: r.choices?.[0]?.message,
            finish_reason: r.choices?.[0]?.finish_reason,
            usage: r.usage,
          },
        };
      }
      case 'list_models': {
        const r = await jsonFetch(`${BASE}/models`, { headers, signal: ctx.signal });
        const models = (r.data ?? []).map((m: any) => ({ id: m.id, context_length: m.context_length }));
        return { output: models };
      }
      case 'key_info': {
        const r = await jsonFetch(`${BASE}/key`, { headers, signal: ctx.signal });
        return { output: r.data ?? r };
      }
      default:
        unknownOp('openrouter', op);
    }
  },
};

export default adapter;
