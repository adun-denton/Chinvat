import { AdapterError, type ChinvatAdapter, type AdapterContext } from '../types.js';
import { msg, requireConfig } from './util.js';

/**
 * Reusable worker for any OpenAI-compatible API (NVIDIA NIM/Nemotron, Groq,
 * Together, LM Studio, vLLM, Azure, …). Built as a factory so additional named
 * instances (e.g. 'nvidia', 'groq') are one-line registrations once the module
 * registry supports multiple instances per provider; today one instance named
 * 'openai-compatible' is registered, configured via the dashboard.
 */

/** Trim trailing slashes and ensure a single `/v1` suffix (never duplicated). */
export function normalizeBaseUrl(raw: unknown): string {
  const base = String(raw ?? '').trim().replace(/\/+$/, '');
  if (!base) return '';
  return /\/v1$/.test(base) ? base : `${base}/v1`;
}

/** Remove any occurrence of the given secrets from a string (defensive redaction). */
export function redact(text: string, ...secrets: (string | undefined)[]): string {
  let out = text;
  for (const s of secrets) {
    if (s && s.length >= 6) out = out.split(s).join('***');
  }
  return out;
}

function parseCustomHeaders(raw: unknown, log?: (m: string) => void): Record<string, string> {
  if (!raw || typeof raw !== 'string' || !raw.trim()) return {};
  try {
    const obj = JSON.parse(raw);
    if (obj && typeof obj === 'object') {
      const out: Record<string, string> = {};
      for (const [k, v] of Object.entries(obj)) out[k] = String(v);
      return out;
    }
  } catch {
    log?.('customHeaders is not valid JSON — ignoring');
  }
  return {};
}

interface OaResponse {
  ok: boolean;
  status: number;
  json: any;
  text: string;
}

async function oaRequest(
  url: string,
  init: RequestInit,
  timeoutMs: number,
  signal?: AbortSignal
): Promise<OaResponse> {
  const timeout = AbortSignal.timeout(timeoutMs);
  const combined = signal ? AbortSignal.any([signal, timeout]) : timeout;
  const res = await fetch(url, { ...init, signal: combined });
  const text = await res.text();
  let json: any = null;
  if (text) {
    try {
      json = JSON.parse(text);
    } catch {
      /* non-JSON body */
    }
  }
  return { ok: res.ok, status: res.status, json, text };
}

function headersFor(config: Record<string, unknown>, log?: (m: string) => void): Record<string, string> {
  const key = String(config.apiKey ?? '');
  // customHeaders spread last so providers like Azure can override Authorization.
  return {
    'Content-Type': 'application/json',
    ...(key ? { Authorization: `Bearer ${key}` } : {}),
    ...parseCustomHeaders(config.customHeaders, log),
  };
}

/** Map a non-ok response to a sanitized AdapterError preserving the upstream status. */
function upstreamError(provider: string, r: OaResponse, apiKey: string): AdapterError {
  const detail = redact((r.json?.error?.message ?? r.text ?? '').toString(), apiKey).slice(0, 500);
  return new AdapterError(`${provider} HTTP ${r.status}${detail ? `: ${detail}` : ''}`);
}

export interface OaAdapterOpts {
  description?: string;
  baseUrlPlaceholder?: string;
}

export function makeOpenAiCompatAdapter(name: string, opts: OaAdapterOpts = {}): ChinvatAdapter {
  const description =
    opts.description ??
    'Any OpenAI-compatible API (NVIDIA NIM, Groq, Together, LM Studio, vLLM, …) — chat, model listing, embeddings.';

  const requireEndpoint = (ctx: AdapterContext): { base: string; key: string } => {
    requireConfig(ctx.config, ['baseUrl', 'apiKey']);
    const base = normalizeBaseUrl(ctx.config.baseUrl);
    if (!base) throw new AdapterError('baseUrl is empty after normalization');
    return { base, key: String(ctx.config.apiKey) };
  };

  return {
    name,
    version: '0.1.0',
    description,
    configSchema: [
      {
        key: 'baseUrl',
        label: 'Base URL',
        type: 'string',
        required: true,
        placeholder: opts.baseUrlPlaceholder ?? 'https://integrate.api.nvidia.com/v1',
        help: 'OpenAI-compatible base. `/v1` is added if you omit it; trailing slashes are trimmed.',
      },
      { key: 'apiKey', label: 'API key', type: 'secret', required: true, help: 'The provider’s own key. Sent only to this baseUrl.' },
      { key: 'defaultModel', label: 'Default model', type: 'string', help: 'Used when a call omits args.model. Run list_models to see valid ids.' },
      {
        key: 'customHeaders',
        label: 'Custom headers (JSON)',
        type: 'string',
        help: 'Optional JSON object of extra headers, e.g. {"api-key":"…"} for Azure. Merged last, so it can override Authorization.',
      },
    ],

    capabilities: () => [
      {
        name: 'chat',
        description: 'Chat completion via POST /chat/completions. Provide messages[] or a prompt string.',
        risk: 'read',
        params: {
          model: { type: 'string', description: 'defaults to configured defaultModel' },
          prompt: { type: 'string' },
          messages: { type: 'array', description: '[{role, content}, …]' },
          temperature: { type: 'number' },
          max_tokens: { type: 'number' },
        },
      },
      { name: 'list_models', description: 'List available models (GET /models).', risk: 'read', params: {} },
      {
        name: 'embeddings',
        description: 'Embedding vector(s) via POST /embeddings. Errors clearly if the provider has no embeddings endpoint.',
        risk: 'read',
        params: {
          input: { type: 'string', required: true },
          model: { type: 'string' },
        },
      },
    ],

    health: async (ctx) => {
      const base = normalizeBaseUrl(ctx.config.baseUrl);
      const key = String(ctx.config.apiKey ?? '');
      if (!base || !key) return { ok: false, detail: 'not configured — set baseUrl and apiKey' };
      let r: OaResponse;
      try {
        r = await oaRequest(`${base}/models`, { headers: headersFor(ctx.config) }, 8000);
      } catch (e) {
        return { ok: false, detail: `endpoint unreachable: ${redact(msg(e), key)}` };
      }
      if (r.status === 401 || r.status === 403) return { ok: false, detail: `authentication failed (HTTP ${r.status})` };
      if (!r.ok) return { ok: false, detail: `endpoint error (HTTP ${r.status})` };
      const models: string[] = Array.isArray(r.json?.data) ? r.json.data.map((m: any) => m.id).filter(Boolean) : [];
      const dm = ctx.config.defaultModel ? String(ctx.config.defaultModel) : '';
      const host = (() => {
        try {
          return new URL(base).host;
        } catch {
          return base;
        }
      })();
      if (dm && models.length && !models.includes(dm))
        return { ok: true, detail: `reachable · ${host} · ${models.length} models · default "${dm}" not listed` };
      return { ok: true, detail: `reachable · ${host} · ${models.length} models${dm ? ` · default ${dm}` : ''}` };
    },

    invoke: async (op, args, ctx) => {
      const { base, key } = requireEndpoint(ctx);
      const headers = headersFor(ctx.config, ctx.log);
      switch (op) {
        case 'chat': {
          const model = String(args.model ?? ctx.config.defaultModel ?? '');
          if (!model) throw new AdapterError('no model given and no defaultModel configured');
          const messages =
            (args.messages as unknown[]) ?? [{ role: 'user', content: String(args.prompt ?? '') }];
          const body: Record<string, unknown> = { model, messages };
          if (args.temperature !== undefined) body.temperature = args.temperature;
          if (args.max_tokens !== undefined) body.max_tokens = args.max_tokens;
          const r = await oaRequest(
            `${base}/chat/completions`,
            { method: 'POST', headers, body: JSON.stringify(body) },
            600_000,
            ctx.signal
          );
          if (!r.ok) throw upstreamError(name, r, key);
          return {
            output: {
              model: r.json?.model ?? model,
              message: r.json?.choices?.[0]?.message,
              finish_reason: r.json?.choices?.[0]?.finish_reason,
              usage: r.json?.usage,
            },
          };
        }
        case 'list_models': {
          const r = await oaRequest(`${base}/models`, { headers }, 20_000, ctx.signal);
          if (!r.ok) throw upstreamError(name, r, key);
          const data = Array.isArray(r.json?.data) ? r.json.data : Array.isArray(r.json) ? r.json : [];
          return { output: data.map((m: any) => ({ id: m.id, owned_by: m.owned_by })) };
        }
        case 'embeddings': {
          const model = String(args.model ?? ctx.config.defaultModel ?? '');
          if (!model) throw new AdapterError('no model given and no defaultModel configured');
          let r: OaResponse;
          try {
            r = await oaRequest(
              `${base}/embeddings`,
              { method: 'POST', headers, body: JSON.stringify({ model, input: String(args.input) }) },
              120_000,
              ctx.signal
            );
          } catch (e) {
            throw new AdapterError(`embeddings request failed: ${redact(msg(e), key)}`, true);
          }
          if (r.status === 404 || r.status === 405)
            throw new AdapterError(`this endpoint does not support embeddings (HTTP ${r.status})`);
          if (!r.ok) throw upstreamError(name, r, key);
          return { output: { model: r.json?.model ?? model, data: r.json?.data, usage: r.json?.usage } };
        }
        default:
          throw new AdapterError(`module '${name}' has no operation '${op}' (use capabilities_describe)`);
      }
    },
  };
}

const adapter = makeOpenAiCompatAdapter('openai-compatible');
export default adapter;
