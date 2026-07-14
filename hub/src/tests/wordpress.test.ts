import { afterEach, test } from 'node:test';
import assert from 'node:assert/strict';
import wordpress, {
  decodeMediaBase64,
  fetchPublicMedia,
  isAllowedMediaType,
  isPrivateAddress,
  mediaContentDisposition,
} from '../adapters/wordpress.js';
import type { AdapterContext } from '../types.js';

const originalFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = originalFetch;
});

function ctx(): AdapterContext {
  return {
    config: {
      siteUrl: 'https://wp.example',
      username: 'editor',
      appPassword: 'app-password',
    },
    dataDir: '/tmp',
    saveArtifact: async () => 'artifact',
    log: () => {},
    signal: undefined,
  };
}

interface Captured {
  url: string;
  init: RequestInit;
}

function mockJsonFetch(handler: (call: Captured) => unknown): Captured[] {
  const calls: Captured[] = [];
  globalThis.fetch = async (input, init = {}) => {
    const call = { url: String(input), init };
    calls.push(call);
    const body = handler(call);
    return new Response(JSON.stringify(body), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  };
  return calls;
}

test('capabilities expose editable pages, dual-source media and featured media', () => {
  const specs = new Map(wordpress.capabilities().map((spec) => [spec.name, spec]));
  assert.equal(specs.get('get_page')?.risk, 'read');
  assert.equal(specs.get('update_page')?.risk, 'act');
  assert.ok(specs.get('upload_media')?.params.content_base64);
  assert.ok(specs.get('upload_media')?.params.mime_type);
  assert.ok(specs.get('create_post')?.params.featured_media);
  assert.ok(specs.get('update_post')?.params.featured_media);
  assert.ok(specs.get('create_page')?.params.featured_media);
  assert.ok(specs.get('update_page')?.params.featured_media);
});

test('get_page retrieves raw editable fields with context=edit', async () => {
  const calls = mockJsonFetch(() => ({
    id: 42,
    status: 'draft',
    title: { raw: 'Raw title', rendered: 'Rendered title' },
    content: { raw: '<!-- wp:paragraph --><p>Draft</p><!-- /wp:paragraph -->' },
    excerpt: { raw: 'Summary' },
    slug: 'draft-page',
    parent: 7,
    template: 'page-wide',
    featured_media: 99,
  }));
  const result = await wordpress.invoke('get_page', { id: 42 }, ctx());
  assert.equal(calls[0].url, 'https://wp.example/wp-json/wp/v2/pages/42?context=edit');
  assert.equal((result.output as any).title, 'Raw title');
  assert.match((result.output as any).content, /wp:paragraph/);
  assert.equal((result.output as any).featured_media, 99);
});

test('update_page uses partial fields and never changes status implicitly', async () => {
  const calls = mockJsonFetch(() => ({ id: 42, status: 'draft', title: { rendered: 'Changed' } }));
  await wordpress.invoke(
    'update_page',
    { id: 42, title: 'Changed', featured_media: 0, parent: 3 },
    ctx()
  );
  const body = JSON.parse(String(calls[0].init.body));
  assert.deepEqual(body, { title: 'Changed', parent: 3, featured_media: 0 });
  assert.equal(calls[0].init.method, 'POST');
  assert.ok(!('status' in body));
  await assert.rejects(() => wordpress.invoke('update_page', { id: 42 }, ctx()), /nothing to update/);
});

test('featured_media passes through post and page draft operations', async () => {
  const calls = mockJsonFetch(() => ({ id: 1, status: 'draft', title: { rendered: 'Draft' } }));
  await wordpress.invoke('create_post', { title: 'Draft', content: 'Body', featured_media: 9 }, ctx());
  await wordpress.invoke('update_post', { id: 1, featured_media: 0 }, ctx());
  await wordpress.invoke('create_page', { title: 'Page', content: 'Body', featured_media: 8 }, ctx());
  assert.equal(JSON.parse(String(calls[0].init.body)).featured_media, 9);
  assert.equal(JSON.parse(String(calls[1].init.body)).featured_media, 0);
  assert.equal(JSON.parse(String(calls[2].init.body)).featured_media, 8);
});

test('upload_media accepts bounded base64 bytes for authenticated Drive workflows', async () => {
  const calls = mockJsonFetch(() => ({ id: 55, source_url: 'https://wp.example/uploads/photo.png' }));
  const result = await wordpress.invoke(
    'upload_media',
    {
      content_base64: Buffer.from('png-bytes').toString('base64'),
      filename: 'photo.png',
      mime_type: 'image/png',
    },
    ctx()
  );
  assert.equal(calls[0].url, 'https://wp.example/wp-json/wp/v2/media');
  assert.equal(calls[0].init.headers && (calls[0].init.headers as Record<string, string>)['Content-Type'], 'image/png');
  assert.equal(Buffer.from(calls[0].init.body as Uint8Array).toString(), 'png-bytes');
  assert.equal((result.output as any).id, 55);
});

test('media filenames remain header-safe when Drive supplies Unicode names', () => {
  const header = mediaContentDisposition('عکس نهایی.png');
  assert.match(header, /filename="[\x20-\x7e]+"/);
  assert.match(header, /filename\*=UTF-8''/);
  assert.ok(!/[\r\n]/.test(header));
});

test('upload_media rejects ambiguous or malformed byte sources', async () => {
  await assert.rejects(
    () => wordpress.invoke('upload_media', { source_url: 'https://example.com/a.png', content_base64: 'AAAA' }, ctx()),
    /exactly one/
  );
  await assert.rejects(
    () => wordpress.invoke('upload_media', { content_base64: 'not-base64', filename: 'a.png', mime_type: 'image/png' }, ctx()),
    /valid base64/
  );
  await assert.rejects(
    () => wordpress.invoke('update_page', { id: 42, parent: -1 }, ctx()),
    /parent must be a non-negative integer/
  );
  assert.throws(() => decodeMediaBase64(Buffer.alloc(8).toString('base64'), 4), /exceeds/);
});

test('media validation blocks private addresses and non-media responses', async () => {
  for (const address of ['127.0.0.1', '10.1.2.3', '169.254.169.254', '192.168.1.2', '::1', 'fd00::1'])
    assert.equal(isPrivateAddress(address), true, address);
  assert.equal(isPrivateAddress('8.8.8.8'), false);
  assert.equal(isAllowedMediaType('image/webp; charset=binary'), true);
  assert.equal(isAllowedMediaType('text/html'), false);
  await assert.rejects(() => fetchPublicMedia('http://127.0.0.1/file.png'), /private or non-routable/);
});

test('URL media validates redirects, MIME and streamed size', async () => {
  const resolveHost = async () => ['8.8.8.8'];
  const redirected = async () => new Response(null, { status: 302, headers: { location: 'http://127.0.0.1/private.png' } });
  await assert.rejects(
    () => fetchPublicMedia('https://public.example/photo.png', undefined, { fetchImpl: redirected, resolveHost }),
    /private or non-routable/
  );

  let redirectCalls = 0;
  const looping = async () => {
    redirectCalls++;
    return new Response(null, { status: 302, headers: { location: '/again' } });
  };
  await assert.rejects(
    () => fetchPublicMedia('https://public.example/photo.png', undefined, { fetchImpl: looping, resolveHost }),
    /redirect limit/
  );
  assert.equal(redirectCalls, 6);

  const html = async () => new Response('<html></html>', { headers: { 'content-type': 'text/html' } });
  await assert.rejects(
    () => fetchPublicMedia('https://public.example/share', undefined, { fetchImpl: html, resolveHost }),
    /unsupported media type/
  );

  const oversized = async () => new Response('12345', { headers: { 'content-type': 'image/png' } });
  await assert.rejects(
    () => fetchPublicMedia('https://public.example/photo.png', undefined, { fetchImpl: oversized, resolveHost, maxBytes: 4 }),
    /exceeds/
  );

  const image = async () => new Response('png', { headers: { 'content-type': 'image/png' } });
  const fetched = await fetchPublicMedia('https://public.example/photo.png', undefined, { fetchImpl: image, resolveHost });
  assert.equal(fetched.buffer.toString(), 'png');
  assert.equal(fetched.mediaType, 'image/png');
});
