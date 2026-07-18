import type { ChinvatAdapter } from '../types.js';
import { cfgStr, jsonFetch, msg, unknownOp } from './util.js';

const adapter: ChinvatAdapter = {
  name: 'ollama',
  version: '0.1.0',
  description: 'Local models via Ollama — chat, generation, embeddings, model management.',
  configSchema: [
    { key: 'baseUrl', label: 'Base URL', type: 'string', default: 'http://127.0.0.1:11434' },
    {
      key: 'defaultModel',
      label: 'Default model',
      type: 'string',
      default: 'qwen3',
      help: 'Used when a job omits args.model',
    },
  ],

  capabilities: () => [
    {
      name: 'chat',
      description: 'Chat completion (non-streaming). Provide messages[] or a prompt string.',
      risk: 'read',
      params: {
        model: { type: 'string', description: 'defaults to configured defaultModel' },
        prompt: { type: 'string' },
        messages: { type: 'array', description: '[{role, content}, …]' },
        think: { type: 'boolean', description: 'Enable or disable model thinking.' },
        format: { type: 'object', description: '"json" or a JSON schema object.' },
        options: { type: 'object', description: 'Ollama options (temperature, num_ctx, …)' },
      },
    },
    {
      name: 'generate',
      description: 'Raw completion for a single prompt.',
      risk: 'read',
      params: {
        model: { type: 'string' },
        prompt: { type: 'string', required: true },
        think: { type: 'boolean', description: 'Enable or disable model thinking.' },
        format: { type: 'object', description: '"json" or a JSON schema object.' },
        options: { type: 'object' },
      },
    },
    {
      name: 'embeddings',
      description: 'Embedding vector(s) for input text.',
      risk: 'read',
      params: {
        model: { type: 'string' },
        input: { type: 'string', required: true },
      },
    },
    { name: 'list_models', description: 'Locally available models.', risk: 'read', params: {} },
    {
      name: 'pull_model',
      description: 'Download a model from the Ollama library.',
      risk: 'act',
      params: { model: { type: 'string', required: true } },
    },
  ],

  health: async (ctx) => {
    try {
      const r = await jsonFetch<{ models?: unknown[] }>(
        `${cfgStr(ctx.config, 'baseUrl', 'http://127.0.0.1:11434')}/api/tags`,
        { timeoutMs: 3000 }
      );
      return { ok: true, detail: `${r.models?.length ?? 0} model(s) available` };
    } catch (e) {
      return { ok: false, detail: msg(e) };
    }
  },

  invoke: async (op, args, ctx) => {
    const baseUrl = cfgStr(ctx.config, 'baseUrl', 'http://127.0.0.1:11434');
    const model = String(args.model ?? ctx.config.defaultModel ?? 'qwen3');
    switch (op) {
      case 'chat': {
        const messages =
          (args.messages as unknown[]) ??
          [{ role: 'user', content: String(args.prompt ?? '') }];
        const r = await jsonFetch(`${baseUrl}/api/chat`, {
          method: 'POST',
          body: JSON.stringify({
            model,
            messages,
            stream: false,
            think: args.think,
            format: args.format,
            options: args.options,
          }),
          signal: ctx.signal,
          timeoutMs: 600_000,
        });
        return {
          output: {
            model: r.model,
            message: r.message,
            eval_count: r.eval_count,
            total_duration_ms: r.total_duration ? Math.round(r.total_duration / 1e6) : undefined,
          },
        };
      }
      case 'generate': {
        const r = await jsonFetch(`${baseUrl}/api/generate`, {
          method: 'POST',
          body: JSON.stringify({
            model,
            prompt: String(args.prompt),
            stream: false,
            think: args.think,
            format: args.format,
            options: args.options,
          }),
          signal: ctx.signal,
          timeoutMs: 600_000,
        });
        return { output: { model: r.model, response: r.response, eval_count: r.eval_count } };
      }
      case 'embeddings': {
        const r = await jsonFetch(`${baseUrl}/api/embed`, {
          method: 'POST',
          body: JSON.stringify({ model, input: String(args.input) }),
          signal: ctx.signal,
        });
        return { output: { model: r.model, embeddings: r.embeddings } };
      }
      case 'list_models': {
        const r = await jsonFetch(`${baseUrl}/api/tags`, { signal: ctx.signal });
        return { output: r.models ?? [] };
      }
      case 'pull_model': {
        ctx.log(`pulling model ${model} — may take a while`);
        const r = await jsonFetch(`${baseUrl}/api/pull`, {
          method: 'POST',
          body: JSON.stringify({ model, stream: false }),
          signal: ctx.signal,
          timeoutMs: 3_600_000,
        });
        return { output: r };
      }
      default:
        unknownOp('ollama', op);
    }
  },
};

export default adapter;
