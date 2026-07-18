import { test } from 'node:test';
import assert from 'node:assert/strict';
import ollama from '../adapters/ollama.js';
import type { AdapterContext } from '../types.js';

function ctx(): AdapterContext {
  return {
    config: { baseUrl: 'http://127.0.0.1:11434', defaultModel: 'qwen3.5:9b' },
    dataDir: '/tmp',
    saveArtifact: async () => 'artifact',
    log: () => undefined,
  };
}

test('chat forwards think=false and JSON format to Ollama HTTP API', async () => {
  let captured: Record<string, unknown> | undefined;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (_url, init) => {
    captured = JSON.parse(String(init?.body));
    return new Response(
      JSON.stringify({
        model: 'qwen3.5:9b',
        message: { role: 'assistant', content: '{"items":[]}' },
        eval_count: 12,
      }),
      { status: 200, headers: { 'content-type': 'application/json' } }
    );
  };
  try {
    const result = await ollama.invoke(
      'chat',
      {
        messages: [{ role: 'user', content: 'synthetic only' }],
        think: false,
        format: 'json',
        options: { temperature: 0, seed: 7 },
      },
      ctx()
    );
    assert.equal(captured?.think, false);
    assert.equal(captured?.format, 'json');
    assert.deepEqual(captured?.options, { temperature: 0, seed: 7 });
    assert.equal((result.output as any).message.content, '{"items":[]}');
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('chat forwards a JSON Schema object through format unchanged', async () => {
  let captured: Record<string, unknown> | undefined;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (_url, init) => {
    captured = JSON.parse(String(init?.body));
    return new Response(
      JSON.stringify({
        model: 'qwen3.5:9b',
        message: { role: 'assistant', content: '{"items":[{"id":"SYN-01","category":"identity"}]}' },
        eval_count: 3,
      }),
      { status: 200, headers: { 'content-type': 'application/json' } }
    );
  };
  const schema = {
    type: 'object',
    required: ['items'],
    properties: {
      items: {
        type: 'array',
        items: {
          type: 'object',
          required: ['id', 'category'],
          properties: {
            id: { type: 'string' },
            category: { type: 'string', enum: ['identity', 'education', 'employment'] },
            confidence: { type: 'number', minimum: 0, maximum: 1 },
          },
        },
      },
    },
  };
  try {
    await ollama.invoke(
      'chat',
      {
        messages: [{ role: 'user', content: 'synthetic only' }],
        think: false,
        format: schema,
        options: { temperature: 0 },
      },
      ctx()
    );
    // The upstream Ollama request must receive the schema deep-equal AND
    // byte-identical after serialization — no key reordering, coercion, or mutation.
    assert.deepEqual(captured?.format, schema);
    assert.equal(JSON.stringify(captured?.format), JSON.stringify(schema));
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('generate forwards JSON schema format and explicit thinking flag', async () => {
  let captured: Record<string, unknown> | undefined;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (_url, init) => {
    captured = JSON.parse(String(init?.body));
    return new Response(JSON.stringify({ model: 'm', response: '{}', eval_count: 1 }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  };
  const schema = { type: 'object', properties: { ok: { type: 'boolean' } } };
  try {
    await ollama.invoke('generate', { prompt: 'synthetic', think: false, format: schema }, ctx());
    assert.equal(captured?.think, false);
    assert.deepEqual(captured?.format, schema);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
