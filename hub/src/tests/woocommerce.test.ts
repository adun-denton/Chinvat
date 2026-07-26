import { test } from 'node:test';
import assert from 'node:assert/strict';
import woocommerce, {
  validateWooCommerceTarget,
  WOOCOMMERCE_OPERATIONS,
} from '../adapters/woocommerce.js';
import wordpress from '../adapters/wordpress.js';
import type { AdapterContext } from '../types.js';

const CONFIG = {
  siteUrl: 'https://127.0.0.1',
  username: 'store-admin',
  appPassword: 'secret-app-password',
  allowInsecureHttp: true,
};

function ctx(config: Record<string, unknown> = CONFIG): AdapterContext {
  return {
    config,
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

function mockFetch(handler: (call: Captured, index: number) => unknown | Promise<unknown> = () => ({ ok: true })): Captured[] {
  const calls: Captured[] = [];
  globalThis.fetch = async (input, init = {}) => {
    const call = { url: String(input), init };
    calls.push(call);
    const value = await handler(call, calls.length - 1);
    if (value instanceof Response) return value;
    return new Response(JSON.stringify(value), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  };
  return calls;
}

test('declares a fixed 144-operation surface with no arbitrary request escape hatch', () => {
  assert.equal(WOOCOMMERCE_OPERATIONS.length, 144);
  assert.equal(new Set(WOOCOMMERCE_OPERATIONS.map((operation) => operation.name)).size, 144);
  assert.equal(WOOCOMMERCE_OPERATIONS.some((operation) => /wc_(?:raw|request)/i.test(operation.name)), false);
  assert.equal(
    WOOCOMMERCE_OPERATIONS.filter((operation) => operation.risk !== 'read')
      .every((operation) => Boolean(operation.params.dry_run)),
    true,
  );
});

test('keeps WordPress separate and unchanged at 42 operations', () => {
  assert.equal(wordpress.capabilities().length, 42);
  assert.equal(woocommerce.name, 'woocommerce');
  assert.equal(woocommerce.version, '0.1.0');
});

test('assigns catalog, financial, publish, batch, and destructive risks deliberately', () => {
  const specs = new Map(WOOCOMMERCE_OPERATIONS.map((operation) => [operation.name, operation]));
  assert.equal(specs.get('wc_products_list')?.risk, 'read');
  assert.equal(specs.get('wc_products_update')?.risk, 'act');
  assert.equal(specs.get('wc_products_batch')?.risk, 'dangerous');
  assert.equal(specs.get('wc_orders_update')?.risk, 'dangerous');
  assert.equal(specs.get('wc_customers_create')?.risk, 'dangerous');
  assert.ok(specs.get('wc_order_refunds_create')?.params.force);
  assert.ok(specs.get('wc_order_refunds_create')?.params.confirm);
  assert.equal(specs.get('wc_product_publish')?.risk, 'dangerous');
  assert.equal(specs.get('wc_products_delete')?.risk, 'dangerous');
  assert.ok(specs.get('wc_products_delete')?.params.force);
  assert.ok(specs.get('wc_products_delete')?.params.confirm);
});

test('target validation rejects embedded credentials, metadata, private targets, and plain HTTP by default', async () => {
  await assert.rejects(() => validateWooCommerceTarget('https://user:pass@example.com'), /must not contain credentials/);
  await assert.rejects(() => validateWooCommerceTarget('https://169.254.169.254'), /link-local/);
  await assert.rejects(() => validateWooCommerceTarget('https://metadata.google.internal'), /metadata/);
  await assert.rejects(() => validateWooCommerceTarget('https://127.0.0.1'), /private or loopback/);
  await assert.rejects(() => validateWooCommerceTarget('https://0.0.0.0'), /private or loopback/);
  await assert.rejects(() => validateWooCommerceTarget('https://224.0.0.1'), /private or loopback/);
  await assert.rejects(() => validateWooCommerceTarget('http://8.8.8.8'), /must use https/);
});

test('explicit development opt-in allows loopback but never link-local', async () => {
  const loopback = await validateWooCommerceTarget('http://127.0.0.1:8080/', true);
  assert.equal(loopback.toString(), 'http://127.0.0.1:8080/');
  await assert.rejects(() => validateWooCommerceTarget('http://169.254.1.1', true), /link-local/);
});

test('list calls use Basic auth, cap pagination, and drop undeclared query keys', async () => {
  const calls = mockFetch(() => []);
  await woocommerce.invoke('wc_products_list', { per_page: 900, page: 2, evil: '../orders' }, ctx());
  assert.equal(calls.length, 1);
  const url = new URL(calls[0].url);
  assert.equal(url.pathname, '/wp-json/wc/v3/products');
  assert.equal(url.searchParams.get('per_page'), '100');
  assert.equal(url.searchParams.get('page'), '2');
  assert.equal(url.searchParams.has('evil'), false);
  assert.match(String((calls[0].init.headers as Record<string, string>).Authorization), /^Basic /);
});

test('product creation is forced to draft and performs a natural-key duplicate check first', async () => {
  const calls = mockFetch((call) => call.url.includes('?sku=SKU-1') ? [] : { id: 41, name: 'Bracket', sku: 'SKU-1', status: 'draft' });
  const result = await woocommerce.invoke(
    'wc_products_create',
    { fields: { name: 'Bracket', sku: 'SKU-1', status: 'publish' } },
    ctx(),
  );
  assert.equal(calls.length, 3);
  assert.match(calls[0].url, /\?sku=SKU-1&per_page=100$/);
  assert.equal(calls[1].init.method, 'POST');
  assert.deepEqual(JSON.parse(String(calls[1].init.body)), {
    name: 'Bracket',
    sku: 'SKU-1',
    status: 'draft',
  });
  assert.match(calls[2].url, /\/products\/41$/);
  assert.ok(result.output);
});

test('natural-key duplicate creation skips the write unless allow_duplicate is true', async () => {
  const calls = mockFetch(() => [{ id: 7, sku: 'SKU-1' }]);
  const result = await woocommerce.invoke('wc_products_create', { fields: { name: 'A', sku: 'SKU-1' } }, ctx());
  assert.equal(calls.length, 1);
  assert.equal((result.output as Record<string, unknown>).skipped, 'duplicate');
});

test('product and variation updates refuse status changes', async () => {
  const calls = mockFetch(() => ({ id: 3, status: 'draft' }));
  await assert.rejects(
    () => woocommerce.invoke('wc_products_update', { product_id: 3, fields: { status: 'publish' } }, ctx()),
    /dedicated publish\/unpublish/,
  );
  await assert.rejects(
    () => woocommerce.invoke('wc_product_variations_update', { product_id: 3, variation_id: 4, fields: { status: 'publish' } }, ctx()),
    /dedicated publish\/unpublish/,
  );
  assert.equal(calls.every((call) => call.init.method === undefined || call.init.method === 'GET'), true);
});

test('permanent deletion fails before any request unless both confirmations are exact', async () => {
  const calls = mockFetch();
  await assert.rejects(
    () => woocommerce.invoke('wc_products_delete', { product_id: 9, force: true, confirm: 'yes' }, ctx()),
    /PERMANENT_DELETE/,
  );
  assert.equal(calls.length, 0);
});

test('dry-run update captures before-state and issues no PUT', async () => {
  const calls = mockFetch(() => ({ id: 8, regular_price: '25.00' }));
  const result = await woocommerce.invoke(
    'wc_products_update',
    { product_id: 8, fields: { regular_price: '21.50' }, dry_run: true },
    ctx(),
  );
  assert.equal(calls.length, 1);
  assert.equal(calls[0].init.method, 'GET');
  assert.deepEqual(result.output, {
    dry_run: true,
    request: { method: 'PUT', path: '/products/8', body: { regular_price: '21.50' } },
    before_state: { id: 8, regular_price: '25.00' },
  });
});

test('update captures before-state, reads back, and verifies scalar fields', async () => {
  const calls = mockFetch((_call, index) => {
    if (index === 0) return { id: 8, regular_price: '25.00' };
    return { id: 8, regular_price: '21.50' };
  });
  const result = await woocommerce.invoke(
    'wc_products_update',
    { product_id: 8, fields: { regular_price: '21.50', meta_data: [{ key: '_x', value: 'y' }] } },
    ctx(),
  );
  assert.equal(calls.length, 3);
  assert.equal(calls[1].init.method, 'PUT');
  const output = result.output as Record<string, any>;
  assert.equal(output.verification.status, 'verified');
  assert.deepEqual(output.verification.not_compared, ['meta_data']);
});

test('batch arrays are capped at 25 and cannot publish through an update payload', async () => {
  const calls = mockFetch();
  await assert.rejects(
    () => woocommerce.invoke('wc_products_batch', { create: Array.from({ length: 26 }, () => ({ name: 'A' })) }, ctx()),
    /capped at 25/,
  );
  await assert.rejects(
    () => woocommerce.invoke('wc_products_batch', { update: [{ id: 5, status: 'publish' }] }, ctx()),
    /status is refused/,
  );
  await assert.rejects(
    () => woocommerce.invoke('wc_products_batch', { delete: [5] }, ctx()),
    /PERMANENT_DELETE/,
  );
  assert.equal(calls.length, 0);
});

test('refund creation requires adapter-level irreversible confirmation', async () => {
  const calls = mockFetch();
  await assert.rejects(
    () => woocommerce.invoke('wc_order_refunds_create', { order_id: 2, fields: { amount: '5.00' } }, ctx()),
    /PERMANENT_DELETE/,
  );
  assert.equal(calls.length, 0);
});

test('refund dry-run can preview the exact request without confirmation or a write', async () => {
  const calls = mockFetch();
  const result = await woocommerce.invoke(
    'wc_order_refunds_create',
    { order_id: 2, fields: { amount: '5.00' }, dry_run: true },
    ctx(),
  );
  assert.equal(calls.length, 0);
  assert.deepEqual(result.output, {
    dry_run: true,
    request: { method: 'POST', path: '/orders/2/refunds', body: { amount: '5.00' } },
    before_state: null,
  });
});

test('tax-class natural key skips duplicates and settings accept scalar values', async () => {
  const duplicateCalls = mockFetch(() => [{ slug: 'reduced-rate', name: 'Reduced rate' }]);
  const duplicate = await woocommerce.invoke(
    'wc_tax_class_create',
    { fields: { slug: 'reduced-rate', name: 'Reduced rate' } },
    ctx(),
  );
  assert.equal(duplicateCalls.length, 1);
  assert.equal((duplicate.output as Record<string, unknown>).skipped, 'duplicate');

  const settingCalls = mockFetch((_call, index) =>
    index === 0 ? { id: 'woocommerce_currency', value: 'USD' } : { id: 'woocommerce_currency', value: 'EUR' }
  );
  const setting = await woocommerce.invoke(
    'wc_settings_option_update',
    { group_id: 'general', option_id: 'woocommerce_currency', value: 'EUR' },
    ctx(),
  );
  assert.equal(JSON.parse(String(settingCalls[1].init.body)).value, 'EUR');
  assert.equal((setting.output as Record<string, any>).verification.status, 'verified');
});

test('nested route identifiers are validated and traversal-like slugs are refused', async () => {
  const calls = mockFetch(() => []);
  await assert.rejects(
    () => woocommerce.invoke('wc_product_attribute_terms_list', { attribute_id: '../orders' }, ctx()),
    /positive integer/,
  );
  await assert.rejects(
    () => woocommerce.invoke('wc_settings_options_list', { group_id: '../general' }, ctx()),
    /letters, digits/,
  );
  assert.equal(calls.length, 0);
});

test('route identifiers are stripped from fields and request bodies are bounded', async () => {
  const calls = mockFetch((_call, index) => index === 0 ? [] : { id: 12, name: 'Safe', status: 'draft' });
  await woocommerce.invoke(
    'wc_products_create',
    { fields: { name: 'Safe', sku: 'SAFE-1', order_id: 99, group_id: '../settings' } },
    ctx(),
  );
  const body = JSON.parse(String(calls[1].init.body));
  assert.equal('order_id' in body, false);
  assert.equal('group_id' in body, false);

  const boundedCalls = mockFetch(() => []);
  await assert.rejects(
    () => woocommerce.invoke(
      'wc_products_create',
      { fields: { name: 'Huge', description: 'x'.repeat(1_048_576) }, allow_duplicate: true },
      ctx(),
    ),
    /1 MiB safety limit/,
  );
  assert.equal(boundedCalls.length, 0);
});

test('connection and permissions probes are read-only and serialized', async () => {
  let active = 0;
  let maxActive = 0;
  const calls = mockFetch(async () => {
    active++;
    maxActive = Math.max(maxActive, active);
    await new Promise((resolve) => setTimeout(resolve, 2));
    active--;
    return {};
  });
  await woocommerce.invoke('wc_permissions_check', {}, ctx());
  assert.equal(calls.length, 12);
  assert.equal(maxActive, 1);
  assert.equal(calls.every((call) => call.init.method === 'GET'), true);
});

test('extension detection is read-only and exposes zero extension operations', async () => {
  const calls = mockFetch(() => ({ namespaces: ['wc/v3', 'wc-bookings/v1'] }));
  const result = await woocommerce.invoke('wc_extensions_detect', {}, ctx());
  assert.equal(calls.length, 1);
  assert.deepEqual(result.output, [
    { name: 'subscriptions', installed: false, operations_enabled: false },
    { name: 'bookings', installed: true, operations_enabled: false },
    { name: 'memberships', installed: false, operations_enabled: false },
  ]);
  assert.equal(WOOCOMMERCE_OPERATIONS.some((operation) => /subscription|booking|membership/.test(operation.name)), false);
});

test('upstream errors are truncated and scrub credentials and key-like values', async () => {
  const leak = `${CONFIG.username} ${CONFIG.appPassword} Basic QWxhZGRpbjpvcGVuIHNlc2FtZQ== ck_abcdefghijklmnopqrstuvwxyz cs_abcdefghijklmnopqrstuvwxyz ${'x'.repeat(800)}`;
  mockFetch(() => new Response(leak, { status: 500 }));
  await assert.rejects(
    () => woocommerce.invoke('wc_products_list', {}, ctx()),
    (error: Error) => {
      assert.equal(error.message.includes(CONFIG.username), false);
      assert.equal(error.message.includes(CONFIG.appPassword), false);
      assert.equal(error.message.includes('ck_'), false);
      assert.equal(error.message.includes('cs_'), false);
      assert.ok(error.message.length < 550);
      return true;
    },
  );
});
