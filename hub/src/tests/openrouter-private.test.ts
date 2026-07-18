import { test } from 'node:test';
import assert from 'node:assert/strict';
import openrouter from '../adapters/openrouter.js';
import type { AdapterContext } from '../types.js';

function ctx(overrides: Partial<AdapterContext> = {}): AdapterContext {
  return {
    config: {
      apiKey: 'sk-test-private',
      privateModels: 'openai/gpt-test',
      privateProviders: 'azure',
    },
    dataDir: '/tmp',
    saveArtifact: async () => 'artifact',
    log: () => undefined,
    ...overrides,
  };
}

test('private_chat requires ephemeral context', async () => {
  await assert.rejects(
    () => openrouter.invoke('private_chat', { model: 'openai/gpt-test', provider: 'azure' }, ctx({ jobId: 'tracked' })),
    /requires adapter_invoke with ephemeral=true/
  );
});

test('private_chat rejects routes outside server allowlists', async () => {
  await assert.rejects(
    () => openrouter.invoke('private_chat', { model: 'openai/not-allowed', provider: 'azure' }, ctx()),
    /model allowlist/
  );
  await assert.rejects(
    () => openrouter.invoke('private_chat', { model: 'openai/gpt-test', provider: 'other' }, ctx()),
    /provider allowlist/
  );
});

test('private_chat enforces live ZDR route and fail-closed provider controls', async () => {
  const originalFetch = globalThis.fetch;
  const calls: Array<{ url: string; body?: any }> = [];
  globalThis.fetch = async (url, init) => {
    const textUrl = String(url);
    calls.push({ url: textUrl, body: init?.body ? JSON.parse(String(init.body)) : undefined });
    if (textUrl.endsWith('/endpoints/zdr')) {
      return new Response(JSON.stringify({ data: [{
        model_id: 'openai/gpt-test',
        tag: 'azure',
        status: 0,
        supports_implicit_caching: false,
        supported_parameters: ['response_format', 'max_completion_tokens'],
      }] }), { status: 200 });
    }
    return new Response(JSON.stringify({
      model: 'openai/gpt-test',
      provider: 'azure',
      choices: [{ message: { role: 'assistant', content: '{"ok":true}' }, finish_reason: 'stop' }],
      usage: { total_tokens: 4 },
    }), { status: 200 });
  };
  const schema = { type: 'json_schema', json_schema: { name: 'answer', strict: true, schema: { type: 'object' } } };
  try {
    const result = await openrouter.invoke('private_chat', {
      model: 'openai/gpt-test',
      provider: 'azure',
      prompt: 'synthetic',
      response_format: schema,
      max_completion_tokens: 100,
    }, ctx());
    assert.equal(calls.length, 2);
    const body = calls[1].body;
    assert.deepEqual(body.provider, {
      zdr: true,
      data_collection: 'deny',
      only: ['azure'],
      allow_fallbacks: false,
      require_parameters: true,
    });
    assert.deepEqual(body.response_format, schema);
    assert.equal(body.max_completion_tokens, 100);
    assert.equal(body.temperature, undefined);
    assert.equal(body.tools, undefined);
    assert.equal((result.output as any).provider, 'azure');
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('private_chat rejects request parameters unsupported by the pinned endpoint', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(JSON.stringify({ data: [{
    model_id: 'openai/gpt-test',
    tag: 'azure',
    status: 0,
    supports_implicit_caching: false,
    supported_parameters: ['response_format', 'max_completion_tokens'],
  }] }), { status: 200 });
  try {
    await assert.rejects(
      () => openrouter.invoke('private_chat', {
        model: 'openai/gpt-test', provider: 'azure', temperature: 0,
      }, ctx()),
      /does not support temperature/
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('private_chat rejects unhealthy or caching ZDR endpoints', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(JSON.stringify({ data: [{
    model_id: 'openai/gpt-test',
    tag: 'azure',
    status: 0,
    supports_implicit_caching: true,
    supported_parameters: ['response_format'],
  }] }), { status: 200 });
  try {
    await assert.rejects(
      () => openrouter.invoke('private_chat', { model: 'openai/gpt-test', provider: 'azure' }, ctx()),
      /implicit caching is disabled/
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});
