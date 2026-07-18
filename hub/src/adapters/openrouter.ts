import type { ChinvatAdapter } from '../types.js';
import { cfgStr, jsonFetch, msg, unknownOp } from './util.js';

const BASE = 'https://openrouter.ai/api/v1';

function csv(value: unknown): string[] {
  return String(value ?? '')
    .split(',')
    .map((item) => item.trim().toLowerCase())
    .filter(Boolean);
}

function requireAllowlisted(value: string, allowed: string[], kind: string): void {
  if (!allowed.includes(value.toLowerCase())) {
    throw new Error(`${kind} '${value}' is not in the configured private ${kind} allowlist`);
  }
}

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
    {
      key: 'privateModels',
      label: 'Private model allowlist',
      type: 'string',
      default: '',
      help: 'Comma-separated exact model IDs permitted for private_chat.',
    },
    {
      key: 'privateProviders',
      label: 'Private provider allowlist',
      type: 'string',
      default: '',
      help: 'Comma-separated exact provider slugs permitted for private_chat.',
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
    {
      name: 'private_chat',
      description:
        'Ephemeral-only hosted chat with server-side model/provider allowlists, live ZDR endpoint verification, data-collection denial, no fallback, and optional JSON Schema.',
      risk: 'read',
      params: {
        model: { type: 'string', required: true },
        provider: { type: 'string', required: true },
        prompt: { type: 'string' },
        messages: { type: 'array' },
        response_format: { type: 'object' },
        temperature: { type: 'number' },
        max_completion_tokens: { type: 'number' },
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
      case 'private_chat': {
        if (ctx.jobId) {
          throw new Error('openrouter.private_chat requires adapter_invoke with ephemeral=true');
        }
        const model = String(args.model ?? '').trim();
        const provider = String(args.provider ?? '').trim().toLowerCase();
        if (!model || !provider) throw new Error('private_chat requires exact model and provider');
        requireAllowlisted(model, csv(ctx.config.privateModels), 'model');
        requireAllowlisted(provider, csv(ctx.config.privateProviders), 'provider');

        const inventory = await jsonFetch<{ data?: any[] }>(`${BASE}/endpoints/zdr`, {
          headers,
          signal: ctx.signal,
          timeoutMs: 15_000,
        });
        const endpoint = (inventory.data ?? []).find((item: any) => {
          const slug = String(item.tag ?? '').split('/')[0].toLowerCase();
          return item.model_id === model && slug === provider && item.status === 0;
        });
        if (!endpoint) {
          throw new Error(`no healthy ZDR endpoint for allowlisted route ${provider}/${model}`);
        }
        if (endpoint.supports_implicit_caching !== false) {
          throw new Error(`ZDR endpoint ${provider}/${model} does not prove implicit caching is disabled`);
        }
        const supported = new Set<string>(
          Array.isArray(endpoint.supported_parameters)
            ? endpoint.supported_parameters.map(String)
            : []
        );
        for (const [argument, parameter] of [
          ['response_format', 'response_format'],
          ['temperature', 'temperature'],
          ['max_completion_tokens', 'max_completion_tokens'],
        ] as const) {
          if (args[argument] !== undefined && !supported.has(parameter)) {
            throw new Error(`ZDR endpoint ${provider}/${model} does not support ${parameter}`);
          }
        }

        const messages =
          (args.messages as unknown[]) ??
          [{ role: 'user', content: String(args.prompt ?? '') }];
        const body: Record<string, unknown> = {
          model,
          messages,
          stream: false,
          provider: {
            zdr: true,
            data_collection: 'deny',
            only: [provider],
            allow_fallbacks: false,
            require_parameters: true,
          },
        };
        if (args.response_format !== undefined) body.response_format = args.response_format;
        if (args.temperature !== undefined) body.temperature = args.temperature;
        if (args.max_completion_tokens !== undefined) {
          body.max_completion_tokens = args.max_completion_tokens;
        }
        const r = await jsonFetch(`${BASE}/chat/completions`, {
          method: 'POST',
          headers,
          body: JSON.stringify(body),
          signal: ctx.signal,
          timeoutMs: 600_000,
        });
        const actualProvider = String(r.provider ?? '').trim().toLowerCase();
        if (actualProvider && actualProvider !== provider) {
          throw new Error(`OpenRouter reported unexpected provider '${actualProvider}'`);
        }
        if (r.model && String(r.model) !== model) {
          throw new Error(`OpenRouter reported unexpected model '${r.model}'`);
        }
        return {
          output: {
            model: r.model ?? model,
            provider: actualProvider || provider,
            endpoint_tag: endpoint.tag,
            zdr_verified_at: new Date().toISOString(),
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
