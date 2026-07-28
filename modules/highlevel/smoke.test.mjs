import assert from 'node:assert/strict';
import test from 'node:test';
import adapter, { API_ORIGIN, RESOURCE_FAMILIES } from './index.mjs';

function context(overrides = {}) {
  return {
    config: {
      accessToken: 'pit-test-secret-value',
      locationId: 'location1',
      apiVersion: 'v3',
      timeoutMs: 5000,
      ...overrides,
    },
    log() {},
  };
}

function response(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

test('adapter exposes maximum-surface operations and broad catalog', () => {
  const names = new Set(adapter.capabilities().map((operation) => operation.name));
  for (const required of [
    'capability_inventory', 'connection_health', 'resource_list', 'resource_get',
    'resource_create', 'resource_update', 'resource_delete',
    'api_get', 'api_post', 'api_put', 'api_patch', 'api_delete',
  ]) assert.ok(names.has(required), required);
  assert.ok(Object.keys(RESOURCE_FAMILIES).length >= 25);
});

test('health uses fixed host, configured location, token, and version without exposing token', async () => {
  const original = globalThis.fetch;
  let seen;
  globalThis.fetch = async (url, init) => {
    seen = { url: String(url), init };
    return response({ location: { id: 'location1', name: 'Example Gallery' } });
  };
  try {
    const result = await adapter.health(context());
    assert.deepEqual(result, { ok: true, detail: 'connected to sub-account Example Gallery' });
    assert.equal(seen.url, `${API_ORIGIN}/locations/location1`);
    assert.equal(seen.init.headers.Authorization, 'Bearer pit-test-secret-value');
    assert.equal(seen.init.headers.Version, 'v3');
    assert.doesNotMatch(JSON.stringify(result), /pit-test-secret-value/);
  } finally {
    globalThis.fetch = original;
  }
});

test('catalogued contact list injects location and preserves query', async () => {
  const original = globalThis.fetch;
  let seenUrl;
  globalThis.fetch = async (url) => {
    seenUrl = new URL(url);
    return response({ contacts: [] });
  };
  try {
    await adapter.invoke('resource_list', {
      family: 'contacts',
      query: { limit: 42, tags: ['buyer', 'artist'] },
    }, context());
    assert.equal(seenUrl.origin, API_ORIGIN);
    assert.equal(seenUrl.pathname, '/contacts/');
    assert.equal(seenUrl.searchParams.get('locationId'), 'location1');
    assert.equal(seenUrl.searchParams.get('limit'), '42');
    assert.deepEqual(seenUrl.searchParams.getAll('tags'), ['buyer', 'artist']);
  } finally {
    globalThis.fetch = original;
  }
});

test('catalogued social post create fills the location path and sends JSON', async () => {
  const original = globalThis.fetch;
  let seen;
  globalThis.fetch = async (url, init) => {
    seen = { url: String(url), init };
    return response({ id: 'post1' }, 201);
  };
  try {
    const result = await adapter.invoke('resource_create', {
      family: 'social_posts',
      body: { summary: 'Approved example draft', status: 'draft' },
    }, context());
    assert.equal(seen.url, `${API_ORIGIN}/social-media-posting/location1/posts`);
    assert.equal(seen.init.method, 'POST');
    assert.deepEqual(JSON.parse(seen.init.body), { summary: 'Approved example draft', status: 'draft' });
    assert.deepEqual(result.output, { id: 'post1' });
  } finally {
    globalThis.fetch = original;
  }
});

test('generic request permits v2 paths but cannot switch hosts', async () => {
  const original = globalThis.fetch;
  let seen;
  globalThis.fetch = async (url, init) => {
    seen = { url: String(url), init };
    return response({ ok: true });
  };
  try {
    await adapter.invoke('api_patch', {
      path: '/contacts/contact_123',
      body: { firstName: 'Mina' },
      version: '2023-02-21',
    }, context());
    assert.equal(seen.url, `${API_ORIGIN}/contacts/contact_123`);
    assert.equal(seen.init.method, 'PATCH');
    assert.equal(seen.init.headers.Version, '2023-02-21');
    await assert.rejects(
      adapter.invoke('api_get', { path: '//evil.example/steal' }, context()),
      /fixed HighLevel API host|absolute API path/,
    );
    await assert.rejects(
      adapter.invoke('api_get', { path: 'https://evil.example/steal' }, context()),
      /absolute API path/,
    );
  } finally {
    globalThis.fetch = original;
  }
});

test('catalogued routes apply empirically required list conventions', async () => {
  const original = globalThis.fetch;
  const seen = [];
  globalThis.fetch = async (url, init) => {
    seen.push({ url: new URL(url), init });
    return response({ ok: true });
  };
  try {
    await adapter.invoke('resource_list', { family: 'opportunities', query: { limit: 1 } }, context());
    await adapter.invoke('resource_list', { family: 'orders' }, context());
    await adapter.invoke('resource_list', { family: 'social_posts' }, context());
    assert.equal(seen[0].url.searchParams.get('locationId'), 'location1');
    assert.equal(seen[1].url.searchParams.get('altId'), 'location1');
    assert.equal(seen[1].url.searchParams.get('altType'), 'location');
    assert.equal(seen[2].url.pathname, '/social-media-posting/location1/posts/list');
    assert.equal(seen[2].init.method, 'POST');
    assert.equal(seen[2].init.body, '{}');
  } finally {
    globalThis.fetch = original;
  }
});

test('errors and returned objects redact tokens', async () => {
  const original = globalThis.fetch;
  globalThis.fetch = async () => response({
    message: 'authorization failed for pit-test-secret-value',
    accessToken: 'pit-test-secret-value',
  }, 401);
  try {
    await assert.rejects(
      adapter.invoke('api_get', { path: '/contacts/' }, context()),
      (error) => {
        assert.doesNotMatch(error.message, /pit-test-secret-value/);
        assert.match(error.message, /\[REDACTED\]/);
        return true;
      },
    );
  } finally {
    globalThis.fetch = original;
  }
});

test('inventory distinguishes API surfaces from account-bound controls', async () => {
  const result = await adapter.invoke('capability_inventory', {}, context());
  assert.equal(result.output.api.origin, API_ORIGIN);
  assert.equal(result.output.api.configuredContext, 'One selected sub-account/location');
  assert.ok(result.output.accountBound.length >= 6);
  assert.ok(result.output.families.social_posts);
  assert.ok(result.output.families.voice_ai_agents);
  assert.doesNotMatch(JSON.stringify(result), /pit-test-secret-value/);
});
