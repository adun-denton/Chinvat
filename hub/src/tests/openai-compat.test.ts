import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeOpenAiCompatAdapter, normalizeBaseUrl, redact } from '../adapters/openai-compat.js';
import type { AdapterContext } from '../types.js';

const KEY = 'sk-secret-abcdef123456';
const adapter = makeOpenAiCompatAdapter('test-oai');

function ctx(config: Record<string, unknown>): AdapterContext {
  return {
    config,
    dataDir: '/tmp',
    saveArtifact: async () => 'artifact',
    log: () => {},
    signal: undefined,
  };
}

interface Captured { url: string; init: any }
function mockFetch(handler: (url: string, init: any) => { status: number; body: unknown }): Captured[] {
  const calls: Captured[] = [];
  (globalThis as any).fetch = async (url: string, init: any) => {
    calls.push({ url, init });
    const { status, body } = handler(String(url), init);
    return new Response(typeof body === 'string' ? body : JSON.stringify(body), {
      status,
      headers: { 'content-type': 'application/json' },
    });
  };
  return calls;
}

test('normalizeBaseUrl: adds /v1 once, trims trailing slashes, never duplicates', () => {
  assert.equal(normalizeBaseUrl('https://integrate.api.nvidia.com/v1'), 'https://integrate.api.nvidia.com/v1');
  assert.equal(normalizeBaseUrl('https://integrate.api.nvidia.com/v1/'), 'https://integrate.api.nvidia.com/v1');
  assert.equal(normalizeBaseUrl('https://integrate.api.nvidia.com'), 'https://integrate.api.nvidia.com/v1');
  assert.equal(normalizeBaseUrl('https://api.groq.com/openai'), 'https://api.groq.com/openai/v1');
  assert.equal(normalizeBaseUrl('  https://x//  '), 'https://x/v1');
  assert.equal(normalizeBaseUrl(''), '');
});

test('redact: removes secrets of length >= 6, leaves short strings', () => {
  assert.equal(redact(`auth ${KEY} done`, KEY), 'auth *** done');
  assert.equal(redact('value=abc12', 'abc12'), 'value=abc12'); // too short to redact
});

test('chat: sends Bearer auth to /chat/completions and returns the assistant message', async () => {
  const calls = mockFetch((url) => {
    assert.ok(url.endsWith('/chat/completions'), `unexpected url ${url}`);
    return { status: 200, body: { model: 'm', choices: [{ message: { role: 'assistant', content: 'hi there' }, finish_reason: 'stop' }], usage: { total_tokens: 3 } } };
  });
  const res = await adapter.invoke('chat', { prompt: 'hello' }, ctx({ baseUrl: 'https://host/v1', apiKey: KEY, defaultModel: 'm' }));
  assert.equal((res.output as any).message.content, 'hi there');
  assert.equal(calls[0].url, 'https://host/v1/chat/completions');
  assert.equal(calls[0].init.headers.Authorization, `Bearer ${KEY}`);
  const body = JSON.parse(calls[0].init.body);
  assert.equal(body.model, 'm');
  assert.deepEqual(body.messages, [{ role: 'user', content: 'hello' }]);
});

test('chat: per-call model override wins over defaultModel', async () => {
  const calls = mockFetch(() => ({ status: 200, body: { choices: [{ message: { content: 'ok' } }] } }));
  await adapter.invoke('chat', { model: 'override-model', messages: [{ role: 'user', content: 'x' }] }, ctx({ baseUrl: 'https://host', apiKey: KEY, defaultModel: 'm' }));
  assert.equal(JSON.parse(calls[0].init.body).model, 'override-model');
});

test('list_models: GET /models mapped to ids', async () => {
  const calls = mockFetch((url) => {
    assert.ok(url.endsWith('/models'));
    return { status: 200, body: { data: [{ id: 'a', owned_by: 'x' }, { id: 'b' }] } };
  });
  const res = await adapter.invoke('list_models', {}, ctx({ baseUrl: 'https://host/v1', apiKey: KEY }));
  assert.deepEqual((res.output as any).map((m: any) => m.id), ['a', 'b']);
  assert.equal(calls[0].init.headers.Authorization, `Bearer ${KEY}`);
});

test('embeddings: unsupported endpoint (404) yields a clear capability error', async () => {
  mockFetch(() => ({ status: 404, body: { error: { message: 'not found' } } }));
  await assert.rejects(
    () => adapter.invoke('embeddings', { input: 'hi', model: 'm' }, ctx({ baseUrl: 'https://host/v1', apiKey: KEY })),
    /does not support embeddings/
  );
});

test('errors are sanitized: upstream body echoing the key is redacted', async () => {
  mockFetch(() => ({ status: 401, body: { error: { message: `invalid token ${KEY}` } } }));
  await assert.rejects(
    () => adapter.invoke('chat', { prompt: 'hi' }, ctx({ baseUrl: 'https://host/v1', apiKey: KEY, defaultModel: 'm' })),
    (e: Error) => {
      assert.ok(!e.message.includes(KEY), 'error message must not contain the API key');
      assert.match(e.message, /HTTP 401/);
      return true;
    }
  );
});

test('health: distinguishes missing config and invalid key', async () => {
  const missing = await adapter.health(ctx({}));
  assert.equal(missing.ok, false);
  assert.match(missing.detail!, /not configured/);

  mockFetch(() => ({ status: 401, body: {} }));
  const bad = await adapter.health(ctx({ baseUrl: 'https://host/v1', apiKey: KEY }));
  assert.equal(bad.ok, false);
  assert.match(bad.detail!, /authentication failed/);
});
