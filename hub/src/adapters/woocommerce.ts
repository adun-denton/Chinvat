import dns from 'node:dns/promises';
import net from 'node:net';
import { AdapterError, type AdapterContext, type ChinvatAdapter, type OperationSpec, type ParamMap, type Risk } from '../types.js';
import { cfgStr, msg, requireConfig, unknownOp } from './util.js';

type HttpMethod = 'GET' | 'POST' | 'PUT' | 'DELETE';

interface ResourceDef {
  prefix: string;
  collection(args: Record<string, unknown>): string;
  idArg: string;
  parentArgs?: string[];
  create?: boolean;
  update?: boolean;
  remove?: boolean;
  batch?: boolean;
  writeRisk?: Risk;
  naturalKey?: string;
  forceDraft?: boolean;
  forbidStatusUpdate?: boolean;
  confirmCreate?: boolean;
}

interface GeneratedOperation extends OperationSpec {
  resource?: ResourceDef;
  action?: 'list' | 'get' | 'create' | 'update' | 'delete' | 'batch';
  irreversible?: boolean;
}

const READ_QUERY_KEYS = new Set([
  'context', 'page', 'per_page', 'search', 'after', 'before', 'exclude', 'include', 'offset',
  'order', 'orderby', 'parent', 'parent_exclude', 'slug', 'status', 'sku', 'featured',
  'category', 'tag', 'shipping_class', 'attribute', 'attribute_term', 'tax_class', 'on_sale',
  'min_price', 'max_price', 'stock_status', 'customer', 'product', 'dp', 'dates_are_gmt',
  'role', 'email', 'code', 'period', 'date_min', 'date_max',
]);
const RESERVED_FIELDS = new Set([
  'fields', 'dry_run', 'force', 'confirm', 'allow_duplicate', 'locations', 'value',
]);
const ROUTE_FIELD_KEYS = new Set([
  'product_id', 'variation_id', 'category_id', 'tag_id', 'attribute_id', 'term_id',
  'review_id', 'shipping_class_id', 'order_id', 'note_id', 'refund_id', 'customer_id',
  'coupon_id', 'zone_id', 'instance_id', 'tax_rate_id', 'webhook_id', 'delivery_id',
  'tool_id', 'method_id', 'gateway_id', 'group_id', 'option_id', 'country_code',
  'continent_code', 'currency_code',
]);
const MAX_BODY_BYTES = 1_048_576;
const PRIVATE_V4 = [
  ['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8],
  ['169.254.0.0', 16], ['172.16.0.0', 12], ['192.0.0.0', 24], ['192.0.2.0', 24],
  ['192.88.99.0', 24], ['192.168.0.0', 16], ['198.18.0.0', 15], ['198.51.100.0', 24],
  ['203.0.113.0', 24], ['224.0.0.0', 4], ['240.0.0.0', 4],
] as const;
const TARGET_CACHE_MS = 30_000;
const targetCache = new Map<string, { expires: number; url: URL }>();
const EXTENSION_REGISTRY = [
  { name: 'subscriptions', namespaces: ['wc/v1', 'wc-subscriptions'] },
  { name: 'bookings', namespaces: ['wc-bookings'] },
  { name: 'memberships', namespaces: ['wc-memberships'] },
] as const;

const requiredString = (description: string) => ({ type: 'string' as const, required: true, description });
const requiredNumber = (description: string) => ({ type: 'number' as const, required: true, description });
const fieldsParam = { type: 'object' as const, required: true, description: 'WooCommerce schema fields. Route identifiers are stripped.' };
const dryRunParam = { type: 'boolean' as const, description: 'Preview the exact request and before-state without issuing a write.' };
const confirmParams: ParamMap = {
  force: { type: 'boolean', required: true, description: 'Must be true for this irreversible operation.' },
  confirm: { type: 'string', required: true, description: 'Must equal PERMANENT_DELETE.' },
};
const conditionalConfirmParams: ParamMap = {
  force: { type: 'boolean', description: 'Required when the batch contains deletions.' },
  confirm: { type: 'string', description: 'Must equal PERMANENT_DELETE when the batch contains deletions.' },
};

function intArg(args: Record<string, unknown>, key: string): number {
  const value = Number(args[key]);
  if (!Number.isInteger(value) || value <= 0) throw new AdapterError(`${key} must be a positive integer`);
  return value;
}

function slugArg(args: Record<string, unknown>, key: string): string {
  const value = String(args[key] ?? '').trim();
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(value))
    throw new AdapterError(`${key} must contain only letters, digits, dot, underscore, or hyphen`);
  return value;
}

function codeArg(args: Record<string, unknown>, key: string, length: [number, number]): string {
  const value = String(args[key] ?? '').trim().toUpperCase();
  const pattern = new RegExp(`^[A-Z]{${length[0]},${length[1]}}$`);
  if (!pattern.test(value)) throw new AdapterError(`${key} must be ${length[0]}-${length[1]} letters`);
  return value;
}

function itemPath(resource: ResourceDef, args: Record<string, unknown>): string {
  return `${resource.collection(args)}/${encodeURIComponent(String(intArg(args, resource.idArg)))}`;
}

function routeParams(resource: ResourceDef): ParamMap {
  const params: ParamMap = {};
  for (const key of resource.parentArgs ?? []) params[key] = requiredNumber(`${key.replaceAll('_', ' ')}.`);
  return params;
}

function resourceOps(resource: ResourceDef): GeneratedOperation[] {
  const route = routeParams(resource);
  const id = { ...route, [resource.idArg]: requiredNumber(`${resource.idArg.replaceAll('_', ' ')}.`) };
  const writeRisk = resource.writeRisk ?? 'act';
  const ops: GeneratedOperation[] = [
    {
      name: `wc_${resource.prefix}_list`, description: `List ${resource.prefix.replaceAll('_', ' ')}.`,
      risk: 'read', params: { ...route, page: { type: 'number' }, per_page: { type: 'number' }, search: { type: 'string' } },
      resource, action: 'list',
    },
    {
      name: `wc_${resource.prefix}_get`, description: `Get one ${resource.prefix.replaceAll('_', ' ')} resource.`,
      risk: 'read', params: id, resource, action: 'get',
    },
  ];
  if (resource.create !== false) ops.push({
    name: `wc_${resource.prefix}_create`, description: `Create ${resource.prefix.replaceAll('_', ' ')}.`,
    risk: writeRisk, params: {
      ...route, fields: fieldsParam, dry_run: dryRunParam, allow_duplicate: { type: 'boolean' },
      ...(resource.confirmCreate ? confirmParams : {}),
    },
    resource, action: 'create',
  });
  if (resource.update !== false) ops.push({
    name: `wc_${resource.prefix}_update`, description: `Update ${resource.prefix.replaceAll('_', ' ')}.`,
    risk: writeRisk, params: { ...id, fields: fieldsParam, dry_run: dryRunParam },
    resource, action: 'update',
  });
  if (resource.remove !== false) ops.push({
    name: `wc_${resource.prefix}_delete`, description: `Permanently delete ${resource.prefix.replaceAll('_', ' ')}.`,
    risk: 'dangerous', params: { ...id, ...confirmParams, dry_run: dryRunParam },
    resource, action: 'delete', irreversible: true,
  });
  if (resource.batch) ops.push({
    name: `wc_${resource.prefix}_batch`, description: `Batch-create, update, or delete ${resource.prefix.replaceAll('_', ' ')} (25 each maximum).`,
    risk: 'dangerous',
    params: {
      ...route, create: { type: 'array' }, update: { type: 'array' }, delete: { type: 'array' },
      ...conditionalConfirmParams, dry_run: dryRunParam,
    },
    resource, action: 'batch',
  });
  return ops;
}

const resources: ResourceDef[] = [
  { prefix: 'products', collection: () => '/products', idArg: 'product_id', batch: true, naturalKey: 'sku', forceDraft: true, forbidStatusUpdate: true },
  { prefix: 'product_variations', collection: (a) => `/products/${intArg(a, 'product_id')}/variations`, idArg: 'variation_id', parentArgs: ['product_id'], batch: true, forceDraft: true, forbidStatusUpdate: true },
  { prefix: 'product_categories', collection: () => '/products/categories', idArg: 'category_id', batch: true, naturalKey: 'slug' },
  { prefix: 'product_tags', collection: () => '/products/tags', idArg: 'tag_id', batch: true, naturalKey: 'slug' },
  { prefix: 'product_attributes', collection: () => '/products/attributes', idArg: 'attribute_id', batch: true, naturalKey: 'slug' },
  { prefix: 'product_attribute_terms', collection: (a) => `/products/attributes/${intArg(a, 'attribute_id')}/terms`, idArg: 'term_id', parentArgs: ['attribute_id'], batch: true, naturalKey: 'slug' },
  { prefix: 'product_reviews', collection: () => '/products/reviews', idArg: 'review_id', batch: true },
  { prefix: 'product_shipping_classes', collection: () => '/products/shipping_classes', idArg: 'shipping_class_id', batch: true, naturalKey: 'slug' },
  { prefix: 'orders', collection: () => '/orders', idArg: 'order_id', batch: true, writeRisk: 'dangerous' },
  { prefix: 'order_notes', collection: (a) => `/orders/${intArg(a, 'order_id')}/notes`, idArg: 'note_id', parentArgs: ['order_id'], update: false, writeRisk: 'dangerous' },
  { prefix: 'order_refunds', collection: (a) => `/orders/${intArg(a, 'order_id')}/refunds`, idArg: 'refund_id', parentArgs: ['order_id'], update: false, writeRisk: 'dangerous', confirmCreate: true },
  { prefix: 'customers', collection: () => '/customers', idArg: 'customer_id', batch: true, naturalKey: 'email', writeRisk: 'dangerous' },
  { prefix: 'coupons', collection: () => '/coupons', idArg: 'coupon_id', batch: true, naturalKey: 'code', writeRisk: 'dangerous' },
  { prefix: 'shipping_zones', collection: () => '/shipping/zones', idArg: 'zone_id', writeRisk: 'dangerous' },
  { prefix: 'shipping_zone_methods', collection: (a) => `/shipping/zones/${intArg(a, 'zone_id')}/methods`, idArg: 'instance_id', parentArgs: ['zone_id'], writeRisk: 'dangerous' },
  { prefix: 'tax_rates', collection: () => '/taxes', idArg: 'tax_rate_id', batch: true, writeRisk: 'dangerous' },
  { prefix: 'webhooks', collection: () => '/webhooks', idArg: 'webhook_id', batch: true, naturalKey: 'delivery_url', writeRisk: 'dangerous' },
];

const generatedOperations = resources.flatMap(resourceOps);

function op(name: string, description: string, risk: Risk, params: ParamMap = {}): GeneratedOperation {
  return { name, description, risk, params };
}

const customOperations: GeneratedOperation[] = [
  op('wc_connection_check', 'Verify authenticated WooCommerce REST API access.', 'read'),
  op('wc_site_identity', 'Read WordPress site identity and WooCommerce namespaces.', 'read'),
  op('wc_permissions_check', 'Probe resource-family read permissions serially.', 'read'),
  op('wc_system_status', 'Read WooCommerce system status.', 'read'),
  op('wc_system_tools_list', 'List WooCommerce system tools.', 'read'),
  op('wc_system_tool_get', 'Get one WooCommerce system tool.', 'read', { tool_id: requiredString('Tool identifier.') }),
  op('wc_system_tool_run', 'Run a WooCommerce system tool.', 'dangerous', { tool_id: requiredString('Tool identifier.'), fields: { type: 'object' }, ...confirmParams, dry_run: dryRunParam }),
  op('wc_extensions_detect', 'Detect supported extension namespaces; no extension operations are enabled.', 'read'),
  op('wc_product_publish', 'Publish a draft product.', 'dangerous', { product_id: requiredNumber('Product ID.'), dry_run: dryRunParam }),
  op('wc_product_unpublish', 'Return a product to draft.', 'dangerous', { product_id: requiredNumber('Product ID.'), dry_run: dryRunParam }),
  op('wc_product_stock_set', 'Set product stock fields.', 'act', {
    product_id: requiredNumber('Product ID.'), stock_quantity: { type: 'number' },
    stock_status: { type: 'string' }, manage_stock: { type: 'boolean' }, dry_run: dryRunParam,
  }),
  op('wc_product_field_options', 'Return locally declared product field option values.', 'read'),
  op('wc_order_status_set', 'Change an order status.', 'dangerous', { order_id: requiredNumber('Order ID.'), status: requiredString('WooCommerce order status.'), dry_run: dryRunParam }),
  op('wc_order_status_counts', 'List order statuses and counts.', 'read'),
  op('wc_customer_downloads_list', 'List downloadable files available to a customer.', 'read', { customer_id: requiredNumber('Customer ID.') }),
  op('wc_shipping_zone_locations_get', 'Get all locations assigned to a shipping zone.', 'read', { zone_id: requiredNumber('Zone ID.') }),
  op('wc_shipping_zone_locations_update', 'Replace all locations assigned to a shipping zone.', 'dangerous', { zone_id: requiredNumber('Zone ID.'), locations: { type: 'array', required: true }, dry_run: dryRunParam }),
  op('wc_shipping_methods_list', 'List registered shipping methods.', 'read'),
  op('wc_shipping_method_get', 'Get a registered shipping method.', 'read', { method_id: requiredString('Shipping method ID.') }),
  op('wc_tax_classes_list', 'List tax classes.', 'read'),
  op('wc_tax_class_create', 'Create a tax class.', 'dangerous', { fields: fieldsParam, allow_duplicate: { type: 'boolean' }, dry_run: dryRunParam }),
  op('wc_tax_class_delete', 'Delete a tax class.', 'dangerous', { slug: requiredString('Tax class slug.'), ...confirmParams, dry_run: dryRunParam }),
  op('wc_payment_gateways_list', 'List payment gateways.', 'read'),
  op('wc_payment_gateway_get', 'Get one payment gateway.', 'read', { gateway_id: requiredString('Gateway ID.') }),
  op('wc_payment_gateway_update', 'Update one payment gateway.', 'dangerous', { gateway_id: requiredString('Gateway ID.'), fields: fieldsParam, dry_run: dryRunParam }),
  op('wc_settings_groups_list', 'List settings groups.', 'read'),
  op('wc_settings_options_list', 'List options in a settings group.', 'read', { group_id: requiredString('Settings group ID.') }),
  op('wc_settings_option_get', 'Get one settings option.', 'read', { group_id: requiredString('Settings group ID.'), option_id: requiredString('Settings option ID.') }),
  op('wc_settings_option_update', 'Update one settings option.', 'dangerous', { group_id: requiredString('Settings group ID.'), option_id: requiredString('Settings option ID.'), value: { type: 'object', required: true }, dry_run: dryRunParam }),
  op('wc_webhook_deliveries_list', 'List recent delivery records for a webhook when supported.', 'read', { webhook_id: requiredNumber('Webhook ID.') }),
  op('wc_webhook_delivery_get', 'Get one webhook delivery record when supported.', 'read', { webhook_id: requiredNumber('Webhook ID.'), delivery_id: requiredNumber('Delivery ID.') }),
  op('wc_reports_list', 'List available WooCommerce reports.', 'read'),
  op('wc_report_sales', 'Read sales report.', 'read', { period: { type: 'string' }, date_min: { type: 'string' }, date_max: { type: 'string' } }),
  op('wc_report_top_sellers', 'Read top-sellers report.', 'read', { period: { type: 'string' }, date_min: { type: 'string' }, date_max: { type: 'string' } }),
  op('wc_report_orders_totals', 'Read order totals report.', 'read'),
  op('wc_report_products_totals', 'Read product totals report.', 'read'),
  op('wc_report_customers_totals', 'Read customer totals report.', 'read'),
  op('wc_report_coupons_totals', 'Read coupon totals report.', 'read'),
  op('wc_report_reviews_totals', 'Read review totals report.', 'read'),
  op('wc_report_stock', 'Derive a stock report from products filtered by stock status.', 'read', { stock_status: { type: 'string' }, page: { type: 'number' }, per_page: { type: 'number' } }),
  op('wc_data_index', 'Read WooCommerce reference-data index.', 'read'),
  op('wc_data_countries', 'List countries.', 'read'),
  op('wc_data_country_get', 'Get one country.', 'read', { country_code: requiredString('Two-letter country code.') }),
  op('wc_data_continents', 'List continents.', 'read'),
  op('wc_data_continent_get', 'Get one continent.', 'read', { continent_code: requiredString('Two-letter continent code.') }),
  op('wc_data_currencies', 'List currencies.', 'read'),
  op('wc_data_currency_get', 'Get one currency.', 'read', { currency_code: requiredString('Three-letter currency code.') }),
  op('wc_data_currency_current', 'Read the store currency.', 'read'),
];

export const WOOCOMMERCE_OPERATIONS: GeneratedOperation[] = [...generatedOperations, ...customOperations];

function ipv4Number(ip: string): number {
  return ip.split('.').reduce((n, part) => ((n << 8) | Number(part)) >>> 0, 0);
}

function ipv4InCidr(ip: string, base: string, prefix: number): boolean {
  const mask = prefix === 0 ? 0 : (0xffffffff << (32 - prefix)) >>> 0;
  return (ipv4Number(ip) & mask) === (ipv4Number(base) & mask);
}

function addressClass(address: string): 'public' | 'private' | 'metadata' {
  address = address.toLowerCase();
  if (
    address === '::' || address === '::1' || address.startsWith('fc') || address.startsWith('fd') ||
    address.startsWith('fe80:') || address.startsWith('ff') || address.startsWith('2001:db8:')
  )
    return address.startsWith('fe80:') ? 'metadata' : 'private';
  if (address.startsWith('::ffff:')) return addressClass(address.slice(7));
  if (net.isIPv4(address)) {
    if (ipv4InCidr(address, '169.254.0.0', 16)) return 'metadata';
    if (PRIVATE_V4.some(([base, prefix]) => ipv4InCidr(address, base, prefix))) return 'private';
  }
  return 'public';
}

export async function validateWooCommerceTarget(siteUrl: string, allowInsecureHttp = false): Promise<URL> {
  let url: URL;
  try {
    url = new URL(siteUrl);
  } catch {
    throw new AdapterError('siteUrl must be a valid URL');
  }
  if (!['http:', 'https:'].includes(url.protocol)) throw new AdapterError('siteUrl must use https');
  if (url.username || url.password) throw new AdapterError('siteUrl must not contain credentials');
  if (url.protocol !== 'https:' && !allowInsecureHttp)
    throw new AdapterError('siteUrl must use https (allowInsecureHttp is only for a local development store)');
  const hostname = url.hostname.toLowerCase().replace(/^\[|\]$/g, '');
  if (hostname === 'metadata.google.internal') throw new AdapterError('cloud metadata hosts are forbidden');
  let addresses: string[];
  if (net.isIP(hostname)) addresses = [hostname];
  else {
    try {
      addresses = (await dns.lookup(hostname, { all: true, verbatim: true })).map((entry) => entry.address);
    } catch (error) {
      throw new AdapterError(`siteUrl host could not be resolved: ${msg(error)}`, true);
    }
  }
  for (const address of addresses) {
    const classification = addressClass(address);
    if (classification === 'metadata') throw new AdapterError('link-local and cloud-metadata targets are forbidden');
    if (classification === 'private' && !allowInsecureHttp)
      throw new AdapterError('private or loopback siteUrl requires allowInsecureHttp');
  }
  url.pathname = url.pathname.replace(/\/+$/, '');
  url.search = '';
  url.hash = '';
  return url;
}

async function validatedTarget(siteUrl: string, allowInsecureHttp: boolean): Promise<URL> {
  const key = `${allowInsecureHttp}\0${siteUrl}`;
  const cached = targetCache.get(key);
  if (cached && cached.expires > Date.now()) return new URL(cached.url);
  const url = await validateWooCommerceTarget(siteUrl, allowInsecureHttp);
  targetCache.set(key, { expires: Date.now() + TARGET_CACHE_MS, url: new URL(url) });
  return url;
}

function redact(text: string, config: Record<string, unknown>, basic: string): string {
  let clean = text.slice(0, 400);
  for (const secret of [String(config.appPassword ?? ''), String(config.username ?? ''), basic]) {
    if (secret.length > 0) clean = clean.split(secret).join('***');
  }
  return clean
    .replace(/Basic\s+[A-Za-z0-9+/=]+/gi, 'Basic ***')
    .replace(/\b(?:ck|cs)_[A-Za-z0-9_]{8,}\b/g, '***');
}

async function request(
  path: string,
  ctx: AdapterContext,
  method: HttpMethod = 'GET',
  body?: unknown,
  absolute = false,
): Promise<unknown> {
  requireConfig(ctx.config, ['siteUrl', 'username', 'appPassword']);
  const target = await validatedTarget(
    cfgStr(ctx.config, 'siteUrl'),
    ctx.config.allowInsecureHttp === true,
  );
  const base = target.toString().replace(/\/+$/, '');
  const url = absolute ? `${base}${path}` : `${base}/wp-json/wc/v3${path}`;
  const basic = Buffer.from(`${ctx.config.username}:${ctx.config.appPassword}`).toString('base64');
  const bodyText = body === undefined ? undefined : JSON.stringify(body);
  if (bodyText && Buffer.byteLength(bodyText, 'utf8') > MAX_BODY_BYTES)
    throw new AdapterError('WooCommerce request body exceeds the 1 MiB safety limit');
  let response: Response;
  try {
    response = await fetch(url, {
      method,
      headers: {
        Accept: 'application/json',
        Authorization: `Basic ${basic}`,
        ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
      },
      body: bodyText,
      redirect: 'manual',
      signal: ctx.signal
        ? AbortSignal.any([ctx.signal, AbortSignal.timeout(Number(ctx.config.timeoutMs ?? 60_000))])
        : AbortSignal.timeout(Number(ctx.config.timeoutMs ?? 60_000)),
    });
  } catch (error) {
    throw new AdapterError(`request to ${target.host} failed: ${msg(error)}`, true);
  }
  const text = await response.text();
  if (!response.ok) {
    throw new AdapterError(`HTTP ${response.status} from ${target.host}: ${redact(text, ctx.config, basic)}`);
  }
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

function queryFromArgs(args: Record<string, unknown>): string {
  const query = new URLSearchParams();
  for (const [key, raw] of Object.entries(args)) {
    if (!READ_QUERY_KEYS.has(key) || raw === undefined || raw === null || raw === '') continue;
    if (key === 'page' || key === 'per_page' || key === 'offset') {
      const value = Math.trunc(Number(raw));
      if (!Number.isFinite(value) || value < (key === 'page' ? 1 : 0)) throw new AdapterError(`${key} is invalid`);
      query.set(key, String(key === 'per_page' ? Math.min(value, 100) : value));
    } else {
      query.set(key, Array.isArray(raw) ? raw.join(',') : String(raw));
    }
  }
  const value = query.toString();
  return value ? `?${value}` : '';
}

function collectFields(args: Record<string, unknown>, resource?: ResourceDef, action?: string): Record<string, unknown> {
  const source = args.fields;
  if (!source || typeof source !== 'object' || Array.isArray(source))
    throw new AdapterError('fields must be an object');
  const fields = { ...(source as Record<string, unknown>) };
  for (const key of [...RESERVED_FIELDS, ...ROUTE_FIELD_KEYS, resource?.idArg ?? '', ...(resource?.parentArgs ?? [])]) delete fields[key];
  if (resource?.forbidStatusUpdate && action === 'update' && 'status' in fields)
    throw new AdapterError('fields.status is refused here; use the dedicated publish/unpublish operation');
  if (resource?.forceDraft && action === 'create') fields.status = 'draft';
  if (Object.keys(fields).length === 0) throw new AdapterError('fields must contain at least one writable field');
  return fields;
}

function requireConfirmation(args: Record<string, unknown>): void {
  if (args.dry_run === true) return;
  if (args.force !== true || args.confirm !== 'PERMANENT_DELETE')
    throw new AdapterError('irreversible operation requires force=true and confirm="PERMANENT_DELETE"');
}

function batchBody(args: Record<string, unknown>, resource: ResourceDef): Record<string, unknown[]> {
  const body: Record<string, unknown[]> = {};
  for (const key of ['create', 'update', 'delete'] as const) {
    if (args[key] === undefined) continue;
    if (!Array.isArray(args[key])) throw new AdapterError(`${key} must be an array`);
    if ((args[key] as unknown[]).length > 25) throw new AdapterError(`${key} is capped at 25 items`);
    if (key === 'delete' && (args[key] as unknown[]).length > 0) requireConfirmation(args);
    body[key] = (args[key] as unknown[]).map((item) => {
      if (key === 'delete') {
        const id = Number(item);
        if (!Number.isInteger(id) || id <= 0) throw new AdapterError('delete items must be positive integer IDs');
        return id;
      }
      if (!item || typeof item !== 'object' || Array.isArray(item)) throw new AdapterError(`${key} items must be objects`);
      const clean = { ...(item as Record<string, unknown>) };
      for (const routeKey of [...RESERVED_FIELDS, ...ROUTE_FIELD_KEYS, resource.idArg, ...(resource.parentArgs ?? [])]) delete clean[routeKey];
      if (resource.forbidStatusUpdate && key === 'update' && 'status' in clean)
        throw new AdapterError('batch update status is refused; use the dedicated publish/unpublish operation');
      if (resource.forceDraft && key === 'create') clean.status = 'draft';
      return clean;
    });
  }
  if (Object.keys(body).length === 0) throw new AdapterError('batch requires create, update, or delete');
  return body;
}

function scalarVerification(requested: Record<string, unknown>, actual: unknown): Record<string, unknown> {
  if (!actual || typeof actual !== 'object') return { status: 'unverified', compared: {}, not_compared: Object.keys(requested) };
  const compared: Record<string, boolean> = {};
  const notCompared: string[] = [];
  for (const [key, expected] of Object.entries(requested)) {
    if (expected === null || ['string', 'number', 'boolean'].includes(typeof expected))
      compared[key] = Object.is((actual as Record<string, unknown>)[key], expected);
    else notCompared.push(key);
  }
  const values = Object.values(compared);
  return {
    status: values.some((ok) => !ok) ? 'mismatch' : values.length ? 'verified' : 'unverified',
    compared,
    not_compared: notCompared,
  };
}

async function duplicateCheck(resource: ResourceDef, fields: Record<string, unknown>, args: Record<string, unknown>, ctx: AdapterContext): Promise<unknown | undefined> {
  if (!resource.naturalKey || fields[resource.naturalKey] === undefined) return undefined;
  const key = resource.naturalKey;
  const queryKey = key === 'delivery_url' ? undefined : key;
  const collection = resource.collection(args);
  if (queryKey) {
    const result = await request(`${collection}?${new URLSearchParams({ [queryKey]: String(fields[key]), per_page: '100' })}`, ctx);
    if (Array.isArray(result)) return result.find((item) => String(item?.[key] ?? '').toLowerCase() === String(fields[key]).toLowerCase());
    return undefined;
  }
  const result = await request(`${collection}?per_page=100`, ctx);
  if (Array.isArray(result)) return result.find((item) => String(item?.[key] ?? '').toLowerCase() === String(fields[key]).toLowerCase());
  return undefined;
}

async function writeWithVerification(
  path: string,
  method: HttpMethod,
  body: unknown,
  before: unknown,
  args: Record<string, unknown>,
  ctx: AdapterContext,
  verifyPath?: string,
): Promise<unknown> {
  if (args.dry_run === true) return { dry_run: true, request: { method, path, body }, before_state: before };
  const result = await request(path, ctx, method, body);
  let readbackPath = verifyPath;
  if (!readbackPath && method === 'POST' && result && typeof result === 'object' && !Array.isArray(result)) {
    const id = Number((result as Record<string, unknown>).id);
    if (Number.isInteger(id) && id > 0) readbackPath = `${path.replace(/\/+$/, '')}/${id}`;
  }
  if (!readbackPath || !body || typeof body !== 'object' || Array.isArray(body)) return { result, before_state: before };
  try {
    const readback = await request(readbackPath, ctx);
    return { result, before_state: before, readback, verification: scalarVerification(body as Record<string, unknown>, readback) };
  } catch (error) {
    return { result, before_state: before, verification: { status: 'unverified', error: msg(error) } };
  }
}

async function invokeGenerated(spec: GeneratedOperation, args: Record<string, unknown>, ctx: AdapterContext): Promise<unknown> {
  const resource = spec.resource!;
  const collection = resource.collection(args);
  switch (spec.action) {
    case 'list':
      return request(`${collection}${queryFromArgs(args)}`, ctx);
    case 'get':
      return request(itemPath(resource, args), ctx);
    case 'create': {
      if (resource.confirmCreate) requireConfirmation(args);
      const fields = collectFields(args, resource, 'create');
      const existing = args.allow_duplicate === true ? undefined : await duplicateCheck(resource, fields, args, ctx);
      if (existing) return { skipped: 'duplicate', existing };
      return writeWithVerification(collection, 'POST', fields, null, args, ctx, undefined);
    }
    case 'update': {
      const path = itemPath(resource, args);
      const before = await request(path, ctx);
      const fields = collectFields(args, resource, 'update');
      return writeWithVerification(path, 'PUT', fields, before, args, ctx, path);
    }
    case 'delete': {
      requireConfirmation(args);
      const path = itemPath(resource, args);
      const before = await request(path, ctx);
      return writeWithVerification(`${path}?force=true`, 'DELETE', undefined, before, args, ctx);
    }
    case 'batch': {
      const body = batchBody(args, resource);
      return writeWithVerification(`${collection}/batch`, 'POST', body, null, args, ctx);
    }
  }
}

async function customWrite(
  path: string,
  body: Record<string, unknown>,
  args: Record<string, unknown>,
  ctx: AdapterContext,
  options: { beforePath?: string; verifyPath?: string; irreversible?: boolean; method?: HttpMethod } = {},
): Promise<unknown> {
  if (options.irreversible) requireConfirmation(args);
  const before = options.beforePath ? await request(options.beforePath, ctx) : null;
  return writeWithVerification(path, options.method ?? 'PUT', body, before, args, ctx, options.verifyPath);
}

const PRODUCT_OPTIONS = {
  types: ['simple', 'grouped', 'external', 'variable'],
  statuses: ['draft', 'pending', 'private', 'publish'],
  catalog_visibility: ['visible', 'catalog', 'search', 'hidden'],
  stock_status: ['instock', 'outofstock', 'onbackorder'],
  backorders: ['no', 'notify', 'yes'],
  tax_status: ['taxable', 'shipping', 'none'],
};

const adapter: ChinvatAdapter = {
  name: 'woocommerce',
  version: '0.1.0',
  description: 'WooCommerce store management through the authenticated wc/v3 REST API with guarded writes and readback verification.',
  activation: { kind: 'service', note: 'WooCommerce active + HTTPS + WordPress user with manage_woocommerce.' },
  configSchema: [
    { key: 'siteUrl', label: 'Site URL', type: 'string', required: true, placeholder: 'https://example.com' },
    { key: 'username', label: 'WordPress username', type: 'string', required: true },
    { key: 'appPassword', label: 'Application password', type: 'secret', required: true },
    { key: 'allowInsecureHttp', label: 'Allow local/private development target', type: 'boolean', default: false, help: 'Required for HTTP or private/loopback targets. Link-local/cloud-metadata targets stay blocked.' },
    { key: 'timeoutMs', label: 'Request timeout (ms)', type: 'number', default: 60000 },
  ],
  capabilities: () => WOOCOMMERCE_OPERATIONS,

  async health(ctx) {
    if (!ctx.config.siteUrl || !ctx.config.username || !ctx.config.appPassword)
      return { ok: false, detail: 'not configured (siteUrl, username, and appPassword required)' };
    try {
      const status = await request('/system_status', ctx) as Record<string, unknown>;
      return { ok: true, detail: `connected · WooCommerce ${String(status?.environment && (status.environment as Record<string, unknown>).version || status?.version || 'wc/v3')}` };
    } catch (error) {
      return { ok: false, detail: msg(error) };
    }
  },

  async invoke(operation, args, ctx) {
    const spec = WOOCOMMERCE_OPERATIONS.find((candidate) => candidate.name === operation);
    if (!spec) unknownOp('woocommerce', operation);
    if (spec.resource) return { output: await invokeGenerated(spec, args, ctx) };

    switch (operation) {
      case 'wc_connection_check': {
        const status = await request('/system_status', ctx) as Record<string, unknown>;
        return { output: { connected: true, api: 'wc/v3', environment: status?.environment ?? null } };
      }
      case 'wc_site_identity': {
        const root = await request('/wp-json', ctx, 'GET', undefined, true) as Record<string, unknown>;
        return { output: {
          name: root?.name, url: root?.url, home: root?.home,
          namespaces: Array.isArray(root?.namespaces) ? root.namespaces.filter((value) => String(value).startsWith('wc')) : [],
        } };
      }
      case 'wc_permissions_check': {
        const probes = [
          '/products?per_page=1', '/orders?per_page=1', '/customers?per_page=1', '/coupons?per_page=1',
          '/shipping/zones?per_page=1', '/taxes?per_page=1', '/payment_gateways', '/settings',
          '/webhooks?per_page=1', '/reports', '/system_status', '/data',
        ];
        const permissions: Record<string, unknown> = {};
        for (const path of probes) {
          try {
            await request(path, ctx);
            permissions[path.split('?')[0]] = { readable: true };
          } catch (error) {
            permissions[path.split('?')[0]] = { readable: false, error: msg(error) };
          }
        }
        return { output: { write_tested: false, permissions } };
      }
      case 'wc_system_status': return { output: await request('/system_status', ctx) };
      case 'wc_system_tools_list': return { output: await request('/system_status/tools', ctx) };
      case 'wc_system_tool_get': return { output: await request(`/system_status/tools/${encodeURIComponent(slugArg(args, 'tool_id'))}`, ctx) };
      case 'wc_system_tool_run': return { output: await customWrite(
        `/system_status/tools/${encodeURIComponent(slugArg(args, 'tool_id'))}`,
        args.fields && typeof args.fields === 'object' ? args.fields as Record<string, unknown> : {},
        args, ctx, { beforePath: `/system_status/tools/${encodeURIComponent(slugArg(args, 'tool_id'))}`, irreversible: true },
      ) };
      case 'wc_extensions_detect': {
        const root = await request('/wp-json', ctx, 'GET', undefined, true) as Record<string, unknown>;
        const namespaces = Array.isArray(root?.namespaces) ? root.namespaces.map(String) : [];
        return { output: EXTENSION_REGISTRY.map((extension) => ({
          name: extension.name,
          installed: extension.namespaces.some((needle) => namespaces.some((namespace) => namespace.includes(needle))),
          operations_enabled: false,
        })) };
      }
      case 'wc_product_publish':
      case 'wc_product_unpublish': {
        const id = intArg(args, 'product_id');
        const status = operation.endsWith('unpublish') ? 'draft' : 'publish';
        return { output: await customWrite(`/products/${id}`, { status }, args, ctx, { beforePath: `/products/${id}`, verifyPath: `/products/${id}` }) };
      }
      case 'wc_product_stock_set': {
        const id = intArg(args, 'product_id');
        const body: Record<string, unknown> = {};
        for (const key of ['stock_quantity', 'stock_status', 'manage_stock']) if (args[key] !== undefined) body[key] = args[key];
        if (Object.keys(body).length === 0) throw new AdapterError('provide stock_quantity, stock_status, or manage_stock');
        return { output: await customWrite(`/products/${id}`, body, args, ctx, { beforePath: `/products/${id}`, verifyPath: `/products/${id}` }) };
      }
      case 'wc_product_field_options': return { output: PRODUCT_OPTIONS };
      case 'wc_order_status_set': {
        const id = intArg(args, 'order_id');
        const status = slugArg(args, 'status');
        return { output: await customWrite(`/orders/${id}`, { status }, args, ctx, { beforePath: `/orders/${id}`, verifyPath: `/orders/${id}` }) };
      }
      case 'wc_order_status_counts': return { output: await request('/orders/statuses', ctx) };
      case 'wc_customer_downloads_list': return { output: await request(`/customers/${intArg(args, 'customer_id')}/downloads`, ctx) };
      case 'wc_shipping_zone_locations_get': return { output: await request(`/shipping/zones/${intArg(args, 'zone_id')}/locations`, ctx) };
      case 'wc_shipping_zone_locations_update': {
        if (!Array.isArray(args.locations)) throw new AdapterError('locations must be an array');
        const path = `/shipping/zones/${intArg(args, 'zone_id')}/locations`;
        return { output: await customWrite(path, args.locations as unknown as Record<string, unknown>, args, ctx, { beforePath: path }) };
      }
      case 'wc_shipping_methods_list': return { output: await request('/shipping_methods', ctx) };
      case 'wc_shipping_method_get': return { output: await request(`/shipping_methods/${encodeURIComponent(slugArg(args, 'method_id'))}`, ctx) };
      case 'wc_tax_classes_list': return { output: await request('/taxes/classes', ctx) };
      case 'wc_tax_class_create': {
        const fields = collectFields(args);
        const naturalKey = String(fields.slug ?? fields.name ?? '').toLowerCase();
        if (naturalKey && args.allow_duplicate !== true) {
          const classes = await request('/taxes/classes', ctx);
          if (Array.isArray(classes)) {
            const existing = classes.find((item) =>
              [item?.slug, item?.name].some((value) => String(value ?? '').toLowerCase() === naturalKey)
            );
            if (existing) return { output: { skipped: 'duplicate', existing } };
          }
        }
        return { output: await customWrite('/taxes/classes', fields, args, ctx, { method: 'POST' }) };
      }
      case 'wc_tax_class_delete': {
        requireConfirmation(args);
        const path = `/taxes/classes/${encodeURIComponent(slugArg(args, 'slug'))}`;
        const before = await request('/taxes/classes', ctx);
        return { output: await writeWithVerification(path, 'DELETE', undefined, before, args, ctx) };
      }
      case 'wc_payment_gateways_list': return { output: await request('/payment_gateways', ctx) };
      case 'wc_payment_gateway_get': return { output: await request(`/payment_gateways/${encodeURIComponent(slugArg(args, 'gateway_id'))}`, ctx) };
      case 'wc_payment_gateway_update': {
        const path = `/payment_gateways/${encodeURIComponent(slugArg(args, 'gateway_id'))}`;
        return { output: await customWrite(path, collectFields(args), args, ctx, { beforePath: path, verifyPath: path }) };
      }
      case 'wc_settings_groups_list': return { output: await request('/settings', ctx) };
      case 'wc_settings_options_list': return { output: await request(`/settings/${encodeURIComponent(slugArg(args, 'group_id'))}`, ctx) };
      case 'wc_settings_option_get': return { output: await request(`/settings/${encodeURIComponent(slugArg(args, 'group_id'))}/${encodeURIComponent(slugArg(args, 'option_id'))}`, ctx) };
      case 'wc_settings_option_update': {
        const path = `/settings/${encodeURIComponent(slugArg(args, 'group_id'))}/${encodeURIComponent(slugArg(args, 'option_id'))}`;
        return { output: await customWrite(path, { value: args.value }, args, ctx, { beforePath: path, verifyPath: path }) };
      }
      case 'wc_webhook_deliveries_list': return { output: await request(`/webhooks/${intArg(args, 'webhook_id')}/deliveries`, ctx) };
      case 'wc_webhook_delivery_get': return { output: await request(`/webhooks/${intArg(args, 'webhook_id')}/deliveries/${intArg(args, 'delivery_id')}`, ctx) };
      case 'wc_reports_list': return { output: await request('/reports', ctx) };
      case 'wc_report_sales': return { output: await request(`/reports/sales${queryFromArgs(args)}`, ctx) };
      case 'wc_report_top_sellers': return { output: await request(`/reports/top_sellers${queryFromArgs(args)}`, ctx) };
      case 'wc_report_orders_totals': return { output: await request('/reports/orders/totals', ctx) };
      case 'wc_report_products_totals': return { output: await request('/reports/products/totals', ctx) };
      case 'wc_report_customers_totals': return { output: await request('/reports/customers/totals', ctx) };
      case 'wc_report_coupons_totals': return { output: await request('/reports/coupons/totals', ctx) };
      case 'wc_report_reviews_totals': return { output: await request('/reports/reviews/totals', ctx) };
      case 'wc_report_stock': return { output: {
        derived_from: 'products',
        items: await request(`/products${queryFromArgs({ ...args, stock_status: args.stock_status ?? 'outofstock' })}`, ctx),
      } };
      case 'wc_data_index': return { output: await request('/data', ctx) };
      case 'wc_data_countries': return { output: await request('/data/countries', ctx) };
      case 'wc_data_country_get': return { output: await request(`/data/countries/${codeArg(args, 'country_code', [2, 2])}`, ctx) };
      case 'wc_data_continents': return { output: await request('/data/continents', ctx) };
      case 'wc_data_continent_get': return { output: await request(`/data/continents/${codeArg(args, 'continent_code', [2, 2])}`, ctx) };
      case 'wc_data_currencies': return { output: await request('/data/currencies', ctx) };
      case 'wc_data_currency_get': return { output: await request(`/data/currencies/${codeArg(args, 'currency_code', [3, 3])}`, ctx) };
      case 'wc_data_currency_current': return { output: await request('/data/currencies/current', ctx) };
      default: unknownOp('woocommerce', operation);
    }
  },
};

export default adapter;
