import { test } from 'node:test';
import assert from 'node:assert/strict';
import coolify, { normalizeCoolifyBase } from '../adapters/coolify.js';
import type { AdapterContext } from '../types.js';

const TOKEN = '67|coolify-secret-token';

function ctx(config: Record<string, unknown> = { baseUrl: 'https://coolify.example.com', apiToken: TOKEN }): AdapterContext {
  return { config, dataDir: '/tmp', saveArtifact: async () => 'artifact', log: () => {}, signal: undefined };
}

interface Captured { url: string; init: RequestInit }
function mockFetch(body: unknown = { ok: true }): Captured[] {
  const calls: Captured[] = [];
  globalThis.fetch = async (input, init = {}) => {
    calls.push({ url: String(input), init });
    return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
  };
  return calls;
}

test('normalizes instance URLs without duplicating /api/v1', () => {
  assert.equal(normalizeCoolifyBase('https://coolify.example.com/'), 'https://coolify.example.com');
  assert.equal(normalizeCoolifyBase('https://coolify.example.com/api/v1'), 'https://coolify.example.com');
  assert.throws(() => normalizeCoolifyBase('ftp://coolify.example.com'), /http or https/);
});

test('declares read inventory and approval-gated lifecycle risks', () => {
  const specs = new Map(coolify.capabilities().map((spec) => [spec.name, spec]));
  assert.equal(specs.get('list_servers')?.risk, 'read');
  assert.equal(specs.get('deploy_application')?.risk, 'act');
  assert.equal(specs.get('stop_database')?.risk, 'dangerous');
  assert.equal(specs.get('cancel_deployment')?.risk, 'dangerous');
});

test('sends bearer auth to the exact Coolify API path', async () => {
  const calls = mockFetch([{ uuid: 'server-1' }]);
  const result = await coolify.invoke('list_servers', {}, ctx({ baseUrl: 'https://coolify.example.com/api/v1/', apiToken: TOKEN }));
  assert.equal(calls[0].url, 'https://coolify.example.com/api/v1/servers');
  assert.equal((calls[0].init.headers as Record<string, string>).Authorization, `Bearer ${TOKEN}`);
  assert.deepEqual(result.output, [{ uuid: 'server-1' }]);
});

test('uses fixed lifecycle endpoints and POST only for deployment cancellation', async () => {
  const calls = mockFetch();
  await coolify.invoke('restart_application', { uuid: 'app-123' }, ctx());
  await coolify.invoke('cancel_deployment', { uuid: 'deploy-123' }, ctx());
  assert.equal(calls[0].url, 'https://coolify.example.com/api/v1/applications/app-123/restart');
  assert.equal(calls[0].init.method, undefined);
  assert.equal(calls[1].url, 'https://coolify.example.com/api/v1/deployments/deploy-123/cancel');
  assert.equal(calls[1].init.method, 'POST');
});

test('deploy encodes UUID and force flag', async () => {
  const calls = mockFetch();
  await coolify.invoke('deploy_application', { uuid: 'app-123', force: true }, ctx());
  assert.equal(calls[0].url, 'https://coolify.example.com/api/v1/deploy?uuid=app-123&force=true');
});

test('health reports missing configuration', async () => {
  const health = await coolify.health(ctx({}));
  assert.equal(health.ok, false);
  assert.match(health.detail!, /not configured/);
});
