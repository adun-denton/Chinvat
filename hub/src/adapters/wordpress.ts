import { lookup as dnsLookup } from 'node:dns/promises';
import * as http from 'node:http';
import * as https from 'node:https';
import { isIP } from 'node:net';
import { Readable } from 'node:stream';
import { AdapterError, type ChinvatAdapter, type OperationSpec, type Risk } from '../types.js';
import { cfgStr, jsonFetch, msg, requireConfig, unknownOp } from './util.js';

export const MAX_MEDIA_BYTES = 20 * 1024 * 1024;
const MAX_MEDIA_REDIRECTS = 5;

type ResolveHost = (hostname: string) => Promise<string[]>;
type FetchMedia = (input: string | URL, init?: RequestInit) => Promise<Response>;

const defaultResolveHost: ResolveHost = async (hostname) =>
  (await dnsLookup(hostname, { all: true, verbatim: true })).map((entry) => entry.address);

export function isPrivateAddress(address: string): boolean {
  const lower = address.toLowerCase();
  if (lower.startsWith('::ffff:')) return isPrivateAddress(lower.slice(7));
  if (isIP(lower) === 6) {
    return (
      lower === '::' ||
      lower === '::1' ||
      lower.startsWith('fc') ||
      lower.startsWith('fd') ||
      /^fe[89ab]/.test(lower) ||
      lower.startsWith('ff')
    );
  }
  if (isIP(lower) !== 4) return true;
  const [a, b] = lower.split('.').map(Number);
  return (
    a === 0 ||
    a === 10 ||
    a === 127 ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 198 && (b === 18 || b === 19)) ||
    a >= 224
  );
}

async function publicAddresses(url: URL, resolveHost: ResolveHost): Promise<string[]> {
  if (!['http:', 'https:'].includes(url.protocol))
    throw new AdapterError('source_url must use http or https');
  if (url.username || url.password) throw new AdapterError('source_url must not contain credentials');
  const hostname = url.hostname.replace(/^\[|\]$/g, '');
  const addresses = isIP(hostname) ? [hostname] : await resolveHost(hostname);
  if (!addresses.length || addresses.some(isPrivateAddress))
    throw new AdapterError('source_url resolves to a private or non-routable address');
  return addresses;
}

function fetchPinnedMedia(url: URL, address: string, signal?: AbortSignal): Promise<Response> {
  return new Promise((resolve, reject) => {
    const client = url.protocol === 'https:' ? https : http;
    const request = client.request(
      {
        protocol: url.protocol,
        hostname: address,
        port: url.port || undefined,
        servername: url.protocol === 'https:' ? url.hostname.replace(/^\[|\]$/g, '') : undefined,
        method: 'GET',
        path: `${url.pathname}${url.search}`,
        headers: { Host: url.host, 'Accept-Encoding': 'identity' },
        signal,
      },
      (incoming) => {
        const headers = new Headers();
        for (const [key, value] of Object.entries(incoming.headers)) {
          if (value !== undefined) headers.set(key, Array.isArray(value) ? value.join(', ') : value);
        }
        resolve(
          new Response(Readable.toWeb(incoming) as unknown as BodyInit, {
            status: incoming.statusCode ?? 500,
            statusText: incoming.statusMessage,
            headers,
          })
        );
      }
    );
    request.setTimeout(60_000, () => request.destroy(new Error('request timed out')));
    request.once('error', reject);
    request.end();
  });
}

function normalizeMediaType(value: string | null | undefined): string {
  return String(value ?? '').split(';', 1)[0].trim().toLowerCase();
}

export function isAllowedMediaType(value: string): boolean {
  const type = normalizeMediaType(value);
  return (
    type.startsWith('image/') ||
    type.startsWith('audio/') ||
    type.startsWith('video/') ||
    [
      'application/pdf',
      'application/msword',
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    ].includes(type)
  );
}

function checkedFilename(value: unknown): string {
  const filename = String(value ?? '').trim();
  if (!filename || filename.length > 200 || /[\r\n"\\/]/.test(filename))
    throw new AdapterError('filename is required and must be a plain filename of at most 200 characters');
  return filename;
}

function nonNegativeInteger(value: unknown, field: string): number {
  const id = Number(value);
  if (!Number.isInteger(id) || id < 0) throw new AdapterError(`${field} must be a non-negative integer`);
  return id;
}

function positiveInteger(value: unknown, field: string): number {
  const id = Number(value);
  if (!Number.isInteger(id) || id < 1) throw new AdapterError(`${field} must be a positive integer`);
  return id;
}

function mediaId(value: unknown): number {
  return nonNegativeInteger(value, 'featured_media');
}

export function mediaContentDisposition(filename: string): string {
  const fallback = filename
    .normalize('NFKD')
    .replace(/[^\x20-\x7e]/g, '_')
    .replace(/["\\]/g, '_');
  return `attachment; filename="${fallback || 'upload.bin'}"; filename*=UTF-8''${encodeURIComponent(filename)}`;
}

function filenameFromUrl(url: URL): string {
  const last = url.pathname.split('/').pop() || 'upload.bin';
  try {
    return decodeURIComponent(last);
  } catch {
    throw new AdapterError('source_url contains an invalid encoded filename');
  }
}

async function readResponseCapped(res: Response, maxBytes: number): Promise<Buffer> {
  const declared = Number(res.headers.get('content-length') ?? 0);
  if (Number.isFinite(declared) && declared > maxBytes)
    throw new AdapterError(`media exceeds the ${maxBytes}-byte limit`);
  if (!res.body) return Buffer.alloc(0);
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel();
      throw new AdapterError(`media exceeds the ${maxBytes}-byte limit`);
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks.map((chunk) => Buffer.from(chunk)), total);
}

export async function fetchPublicMedia(
  sourceUrl: string,
  signal?: AbortSignal,
  deps: { fetchImpl?: FetchMedia; resolveHost?: ResolveHost; maxBytes?: number } = {}
): Promise<{ buffer: Buffer; mediaType: string; finalUrl: URL }> {
  const resolveHost = deps.resolveHost ?? defaultResolveHost;
  const maxBytes = deps.maxBytes ?? MAX_MEDIA_BYTES;
  let url: URL;
  try {
    url = new URL(sourceUrl);
  } catch {
    throw new AdapterError('source_url is not a valid URL');
  }
  for (let redirects = 0; redirects <= MAX_MEDIA_REDIRECTS; redirects++) {
    const addresses = await publicAddresses(url, resolveHost);
    let res: Response;
    try {
      res = deps.fetchImpl
        ? await deps.fetchImpl(url, { redirect: 'manual', signal })
        : await fetchPinnedMedia(url, addresses[0], signal);
    } catch (error) {
      throw new AdapterError(`could not fetch source_url: ${msg(error)}`);
    }
    if ([301, 302, 303, 307, 308].includes(res.status)) {
      if (redirects === MAX_MEDIA_REDIRECTS) throw new AdapterError('source_url exceeded the redirect limit');
      const location = res.headers.get('location');
      if (!location) throw new AdapterError('source_url redirect omitted the location header');
      url = new URL(location, url);
      continue;
    }
    if (!res.ok) throw new AdapterError(`could not fetch source_url (HTTP ${res.status})`);
    const mediaType = normalizeMediaType(res.headers.get('content-type'));
    if (!isAllowedMediaType(mediaType))
      throw new AdapterError(`unsupported media type '${mediaType || 'missing'}'`);
    return { buffer: await readResponseCapped(res, maxBytes), mediaType, finalUrl: url };
  }
  throw new AdapterError('source_url exceeded the redirect limit');
}

export function decodeMediaBase64(value: unknown, maxBytes = MAX_MEDIA_BYTES): Buffer {
  const encoded = String(value ?? '').replace(/\s+/g, '');
  if (!encoded || encoded.length > Math.ceil(maxBytes / 3) * 4 + 4)
    throw new AdapterError(`media exceeds the ${maxBytes}-byte limit`);
  if (encoded.length % 4 !== 0 || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(encoded))
    throw new AdapterError('content_base64 is not valid base64');
  const buffer = Buffer.from(encoded, 'base64');
  if (buffer.byteLength > maxBytes) throw new AdapterError(`media exceeds the ${maxBytes}-byte limit`);
  return buffer;
}

function wpBase(config: Record<string, unknown>): string {
  return cfgStr(config, 'siteUrl').replace(/\/+$/, '');
}

function authHeader(config: Record<string, unknown>): Record<string, string> {
  requireConfig(config, ['siteUrl', 'username', 'appPassword']);
  const basic = Buffer.from(`${config.username}:${config.appPassword}`).toString('base64');
  return { Authorization: `Basic ${basic}`, 'Content-Type': 'application/json' };
}

// --- Chinvat WP Bridge companion plugin ---------------------------------------
// The Bridge exposes extended admin abilities (options RW, theme file I/O,
// RankMath, plugin management) through the WordPress Abilities API, plus an
// /info handshake. This adapter reaches them via the abilities "run" endpoint:
//   readonly      -> GET  .../abilities/{name}/run?input[key]=value
//   act|dangerous -> POST .../abilities/{name}/run  body {"input":{...}}
// Writes only take effect when Developer Mode + the matching per-capability
// toggle are enabled in the Bridge settings; otherwise the Bridge returns a
// clear error which surfaces here unchanged.

const BRIDGE_INFO_PATH = '/wp-json/chinvat-bridge/v1/info';
const ABILITIES_BASE = '/wp-json/wp-abilities/v1/abilities';

/** op name -> ability slug, risk, and declared input keys (POST for non-read). */
interface BridgeOp {
  op: string;
  ability: string;
  risk: Risk;
  /** Ability is annotated destructive:true — the Abilities run route requires DELETE for these. */
  destructive?: boolean;
  description: string;
  params: Record<string, { type: 'string' | 'number' | 'boolean' | 'object' | 'array'; description?: string; required?: boolean }>;
}

const BRIDGE_OPS: BridgeOp[] = [
  {
    op: 'bridge_info',
    ability: '', // special-cased: hits the /info handshake, not an ability
    risk: 'read',
    description: 'Bridge handshake: version, toggles, active theme, RankMath status.',
    params: {},
  },
  {
    op: 'bridge_option_get',
    ability: 'chinvat-bridge/options-get',
    risk: 'read',
    description: 'Read a single wp_options value (denylist-guarded).',
    params: { key: { type: 'string', required: true } },
  },
  {
    op: 'bridge_option_update',
    ability: 'chinvat-bridge/options-update',
    risk: 'act',
    description: 'Write a single wp_options value (denylist-guarded; needs options_update toggle).',
    params: {
      key: { type: 'string', required: true },
      value: { type: 'object', required: true, description: 'scalar or JSON-serialisable value' },
    },
  },
  {
    op: 'bridge_theme_list',
    ability: 'chinvat-bridge/theme-list',
    risk: 'read',
    description: 'List files in the active theme (symlinks not followed).',
    params: {},
  },
  {
    op: 'bridge_theme_read',
    ability: 'chinvat-bridge/theme-read',
    risk: 'read',
    description: 'Read a file from the active theme.',
    params: { path: { type: 'string', required: true } },
  },
  {
    op: 'bridge_theme_write',
    ability: 'chinvat-bridge/theme-write',
    risk: 'dangerous',
    description: 'Write a file into the active theme (confined, PHP-linted, backed up, atomic). Arbitrary PHP = RCE by design; needs theme_write toggle.',
    params: {
      path: { type: 'string', required: true },
      content: { type: 'string', required: true },
    },
  },
  {
    op: 'bridge_rankmath_get',
    ability: 'chinvat-bridge/rankmath-get',
    risk: 'read',
    description: 'Read RankMath SEO fields for a post.',
    params: { post_id: { type: 'number', required: true } },
  },
  {
    op: 'bridge_rankmath_update',
    ability: 'chinvat-bridge/rankmath-update',
    risk: 'act',
    description: 'Update RankMath SEO fields for a post.',
    params: {
      post_id: { type: 'number', required: true },
      title: { type: 'string' },
      description: { type: 'string' },
      focus_kw: { type: 'string' },
      robots: { type: 'string' },
      canonical: { type: 'string' },
    },
  },
  {
    op: 'bridge_plugins_list',
    ability: 'chinvat-bridge/plugins-list',
    risk: 'read',
    description: 'List installed plugins and their status.',
    params: {},
  },
  {
    op: 'bridge_plugins_toggle',
    destructive: true,
    ability: 'chinvat-bridge/plugins-toggle',
    risk: 'act',
    description: 'Activate or deactivate a plugin (protected plugins refused; needs plugins_toggle toggle).',
    params: {
      file: { type: 'string', required: true },
      action: { type: 'string', required: true, description: 'activate | deactivate' },
    },
  },
  {
    op: 'bridge_theme_scaffold_child',
    destructive: true,
    ability: 'chinvat-bridge/theme-scaffold-child',
    risk: 'dangerous',
    description: 'Create a block-aware child of the active theme (style.css, theme.json, header/footer parts, templates dir) and optionally activate it, giving theme-write an update-proof target. Needs child_scaffold toggle.',
    params: {
      slug: { type: 'string', description: 'child theme slug; defaults to {parent}-child' },
      name: { type: 'string', description: 'display name' },
      activate: { type: 'boolean', description: 'switch the live site to the child (default true)' },
    },
  },
  {
    op: 'bridge_db_state',
    ability: 'chinvat-bridge/db-state',
    risk: 'read',
    description: 'Which layer owns rendering right now: user Global Styles post, DB template/part overrides, active theme identity. Call before styling work to know where to write.',
    params: {},
  },
  {
    op: 'bridge_global_styles_get',
    ability: 'chinvat-bridge/global-styles-get',
    risk: 'read',
    description: 'Read the user Global Styles config (wp_global_styles post) — the DB styles layer that overrides theme.json at runtime.',
    params: {},
  },
  {
    op: 'bridge_global_styles_update',
    ability: 'chinvat-bridge/global-styles-update',
    risk: 'act',
    description: 'Write the user Global Styles config (theme.json-shaped). merge=true deep-merges; default replaces. Writes the layer that actually renders; needs db_layer toggle.',
    params: {
      styles: { type: 'object', required: true, description: 'theme.json-shaped config (settings/styles), object or JSON string' },
      merge: { type: 'boolean', description: 'deep-merge into existing config instead of replacing (default false)' },
    },
  },
  {
    op: 'bridge_global_styles_reset',
    destructive: true,
    ability: 'chinvat-bridge/global-styles-reset',
    risk: 'act',
    description: 'Remove the user Global Styles override so theme.json files render again. Trashes (recoverable) unless force=true; needs db_layer toggle.',
    params: {
      force: { type: 'boolean', description: 'permanently delete instead of trashing (default false)' },
    },
  },
  {
    op: 'bridge_template_list',
    ability: 'chinvat-bridge/template-list',
    risk: 'read',
    description: 'List block templates and template parts with source per item (theme file vs DB override).',
    params: {},
  },
  {
    op: 'bridge_template_get',
    ability: 'chinvat-bridge/template-get',
    risk: 'read',
    description: 'Read one template/part as it resolves at runtime (DB override wins over theme file).',
    params: {
      type: { type: 'string', required: true, description: 'wp_template | wp_template_part' },
      slug: { type: 'string', required: true },
    },
  },
  {
    op: 'bridge_template_update',
    ability: 'chinvat-bridge/template-update',
    risk: 'act',
    description: 'Write block markup to the DB layer for a template/part (updates or creates the override) — the write that actually renders. Needs db_layer toggle.',
    params: {
      type: { type: 'string', required: true, description: 'wp_template | wp_template_part' },
      slug: { type: 'string', required: true },
      content: { type: 'string', required: true, description: 'block markup (HTML comments syntax)' },
      title: { type: 'string' },
      area: { type: 'string', description: 'parts only: header|footer|uncategorized (create only)' },
    },
  },
  {
    op: 'bridge_template_reset',
    destructive: true,
    ability: 'chinvat-bridge/template-reset',
    risk: 'act',
    description: 'Remove the DB override for a template/part so the theme file renders again. Trashes (recoverable) unless force=true; needs db_layer toggle.',
    params: {
      type: { type: 'string', required: true, description: 'wp_template | wp_template_part' },
      slug: { type: 'string', required: true },
      force: { type: 'boolean', description: 'permanently delete instead of trashing (default false)' },
    },
  },
];

const BRIDGE_OP_BY_NAME = new Map(BRIDGE_OPS.map((b) => [b.op, b]));

/** Collect the declared input keys for an op into an input object, dropping undefined. */
function collectInput(spec: BridgeOp, args: Record<string, unknown>): Record<string, unknown> {
  const input: Record<string, unknown> = {};
  for (const key of Object.keys(spec.params)) {
    if (args[key] !== undefined) input[key] = args[key];
  }
  for (const [key, p] of Object.entries(spec.params)) {
    if (p.required && input[key] === undefined) {
      throw new AdapterError(`missing required arg '${key}' for ${spec.op}`);
    }
  }
  return input;
}

/** Invoke a Bridge ability via the WordPress Abilities API run endpoint. */
async function runBridgeAbility(
  config: Record<string, unknown>,
  spec: BridgeOp,
  input: Record<string, unknown>,
  signal?: AbortSignal
): Promise<unknown> {
  const headers = authHeader(config);
  const runUrl = `${wpBase(config)}${ABILITIES_BASE}/${spec.ability}/run`;
  if (spec.risk === 'read') {
    // Readonly abilities accept GET with nested input[...] query params.
    const q = new URLSearchParams();
    for (const [k, v] of Object.entries(input)) {
      q.set(`input[${k}]`, typeof v === 'object' ? JSON.stringify(v) : String(v));
    }
    // The Abilities run route requires an input object even on GET; send
    // a bare input= (empty string passes rest_is_object and sanitizes to []) when there are no keys.
    const qs = q.toString();
    return jsonFetch(`${runUrl}?${qs || 'input='}`, { headers, signal });
  }
  // Destructive-annotated abilities run as DELETE, and this Abilities API
  // version reads DELETE input from the query string only (bodies ignored).
  // Keep destructive annotations to small-scalar ops; content-bearing writes
  // are annotated non-destructive plugin-side (>=0.4.1) and POST a JSON body.
  if (spec.destructive) {
    const q = new URLSearchParams();
    for (const [k, v] of Object.entries(input)) {
      q.set(`input[${k}]`, typeof v === 'object' ? JSON.stringify(v) : String(v));
    }
    const qs = q.toString();
    return jsonFetch(`${runUrl}?${qs || 'input='}`, {
      method: 'DELETE',
      headers,
      signal,
      timeoutMs: 120_000,
    });
  }
  // act (non-destructive) -> POST { input }
  return jsonFetch(runUrl, {
    method: 'POST',
    headers,
    body: JSON.stringify({ input }),
    signal,
    timeoutMs: 120_000,
  });
}

const adapter: ChinvatAdapter = {
  name: 'wordpress',
  version: '0.3.1',
  description:
    'WordPress via REST API — posts, pages, media, taxonomy and block navigation. Optional Chinvat WP Bridge companion plugin adds options, theme file I/O, DB-layer Global Styles and template overrides (the layer that wins at runtime), RankMath and plugin management (bridge_* ops). Publishing, deletion, live navigation and theme writes are gated as dangerous.',
  configSchema: [
    { key: 'siteUrl', label: 'Site URL', type: 'string', required: true, placeholder: 'https://example.com' },
    { key: 'username', label: 'Username', type: 'string', required: true },
    {
      key: 'appPassword',
      label: 'Application password',
      type: 'secret',
      required: true,
      help: 'WP Admin → Users → Profile → Application Passwords',
    },
  ],

  capabilities: () => {
    const core: OperationSpec[] = [
      { name: 'site_info', description: 'Site name/description/URL.', risk: 'read', params: {} },
      {
        name: 'list_posts',
        description: 'List posts.',
        risk: 'read',
        params: {
          status: { type: 'string', description: 'publish|draft|any' },
          search: { type: 'string' },
          per_page: { type: 'number' },
        },
      },
      { name: 'get_post', description: 'One post with content.', risk: 'read', params: { id: { type: 'number', required: true } } },
      {
        name: 'create_post',
        description: 'Create a post (draft by default — publishing is a separate, dangerous op).',
        risk: 'act',
        params: {
          title: { type: 'string', required: true },
          content: { type: 'string', required: true, description: 'HTML or block markup' },
          excerpt: { type: 'string' },
          categories: { type: 'array', description: 'category IDs' },
          tags: { type: 'array', description: 'tag IDs' },
          featured_media: { type: 'number', description: 'media ID; 0 clears it' },
        },
      },
      {
        name: 'update_post',
        description: 'Update fields on an existing post (not status).',
        risk: 'act',
        params: {
          id: { type: 'number', required: true },
          title: { type: 'string' },
          content: { type: 'string' },
          excerpt: { type: 'string' },
          featured_media: { type: 'number', description: 'media ID; 0 clears it' },
        },
      },
      {
        name: 'publish_post',
        description: 'Set a post live.',
        risk: 'dangerous',
        params: { id: { type: 'number', required: true } },
      },
      {
        name: 'delete_post',
        description: 'Trash a post.',
        risk: 'dangerous',
        params: { id: { type: 'number', required: true } },
      },
      {
        name: 'upload_media',
        description: 'Upload media from one public URL or base64 content. The two source forms are mutually exclusive.',
        risk: 'act',
        params: {
          source_url: { type: 'string', description: 'public http/https URL' },
          content_base64: { type: 'string', description: 'base64 file bytes for authenticated/local sources' },
          filename: { type: 'string' },
          mime_type: { type: 'string', description: 'required with content_base64' },
          alt_text: { type: 'string' },
        },
      },
      { name: 'list_categories', description: 'Categories with IDs.', risk: 'read', params: {} },
      { name: 'list_tags', description: 'Tags with IDs.', risk: 'read', params: {} },
      {
        name: 'create_page',
        description: 'Create a page (draft).',
        risk: 'act',
        params: {
          title: { type: 'string', required: true },
          content: { type: 'string', required: true },
          excerpt: { type: 'string' },
          slug: { type: 'string' },
          parent: { type: 'number' },
          template: { type: 'string' },
          featured_media: { type: 'number', description: 'media ID; 0 clears it' },
        },
      },
      {
        name: 'list_pages',
        description: 'List pages.',
        risk: 'read',
        params: {
          status: { type: 'string', description: 'publish|draft|any' },
          search: { type: 'string' },
          per_page: { type: 'number' },
        },
      },
      {
        name: 'list_media',
        description: 'List media-library attachments.',
        risk: 'read',
        params: {
          search: { type: 'string' },
          media_type: { type: 'string', description: 'image|video|audio|application' },
          mime_type: { type: 'string' },
          parent: { type: 'number', description: 'parent post/page ID; 0 means unattached' },
          page: { type: 'number' },
          per_page: { type: 'number' },
        },
      },
      { name: 'get_media', description: 'One media item with editable metadata.', risk: 'read', params: { id: { type: 'number', required: true } } },
      {
        name: 'update_media',
        description: 'Update media metadata; does not replace file bytes.',
        risk: 'act',
        params: {
          id: { type: 'number', required: true },
          title: { type: 'string' },
          caption: { type: 'string' },
          description: { type: 'string' },
          alt_text: { type: 'string' },
          parent: { type: 'number', description: 'parent post/page ID; 0 detaches' },
        },
      },
      {
        name: 'delete_media',
        description: 'Permanently delete media. Requires force=true because WordPress attachments do not support trash.',
        risk: 'dangerous',
        params: {
          id: { type: 'number', required: true },
          force: { type: 'boolean', required: true, description: 'must be true' },
        },
      },
      { name: 'get_page', description: 'One page with raw editable content.', risk: 'read', params: { id: { type: 'number', required: true } } },
      {
        name: 'update_page',
        description: 'Update fields on an existing page (not status).',
        risk: 'act',
        params: {
          id: { type: 'number', required: true },
          title: { type: 'string' },
          content: { type: 'string' },
          excerpt: { type: 'string' },
          slug: { type: 'string' },
          parent: { type: 'number' },
          template: { type: 'string' },
          featured_media: { type: 'number', description: 'media ID; 0 clears it' },
        },
      },
      {
        name: 'publish_page',
        description: 'Set a page live.',
        risk: 'dangerous',
        params: { id: { type: 'number', required: true } },
      },
      {
        name: 'delete_page',
        description: 'Trash a page.',
        risk: 'dangerous',
        params: { id: { type: 'number', required: true } },
      },
      {
        name: 'list_navigation',
        description: 'List block-theme wp_navigation records.',
        risk: 'read',
        params: { search: { type: 'string' }, page: { type: 'number' }, per_page: { type: 'number' } },
      },
      { name: 'get_navigation', description: 'One navigation record with raw editable block markup.', risk: 'read', params: { id: { type: 'number', required: true } } },
      {
        name: 'update_navigation',
        description: 'Update an existing navigation record. Changes to a published menu can affect the live site immediately.',
        risk: 'dangerous',
        params: {
          id: { type: 'number', required: true },
          title: { type: 'string' },
          content: { type: 'string', description: 'navigation block markup' },
          slug: { type: 'string' },
        },
      },
    ];
    const bridge: OperationSpec[] = BRIDGE_OPS.map((b) => ({
      name: b.op,
      description: b.description,
      risk: b.risk,
      params: b.params,
    }));
    return [...core, ...bridge];
  },

  health: async (ctx) => {
    try {
      requireConfig(ctx.config, ['siteUrl', 'username', 'appPassword']);
      const me = await jsonFetch(`${wpBase(ctx.config)}/wp-json/wp/v2/users/me`, {
        headers: authHeader(ctx.config),
        timeoutMs: 8000,
      });
      // Best-effort Bridge detection — never fails health if the Bridge is absent.
      let bridge = '';
      try {
        const info = await jsonFetch(`${wpBase(ctx.config)}${BRIDGE_INFO_PATH}`, {
          headers: authHeader(ctx.config),
          timeoutMs: 6000,
        });
        if (info?.version) {
          bridge = ` · bridge v${info.version}${info.writes_enabled ? ' (writes on)' : ''}`;
        }
      } catch {
        // Bridge not installed / not reachable — ignore.
      }
      return { ok: true, detail: `authenticated as ${me.name ?? me.slug}${bridge}` };
    } catch (e) {
      return { ok: false, detail: msg(e) };
    }
  },

  invoke: async (op, args, ctx) => {
    const base = `${wpBase(ctx.config)}/wp-json/wp/v2`;
    const headers = authHeader(ctx.config);
    const slim = (p: any) => ({
      id: p.id,
      status: p.status,
      title: p.title?.rendered ?? p.title?.raw,
      link: p.link,
      date: p.date,
    });

    // --- Bridge ops -----------------------------------------------------------
    const bridgeSpec = BRIDGE_OP_BY_NAME.get(op);
    if (bridgeSpec) {
      if (bridgeSpec.op === 'bridge_info') {
        const info = await jsonFetch(`${wpBase(ctx.config)}${BRIDGE_INFO_PATH}`, {
          headers,
          signal: ctx.signal,
        });
        return { output: info };
      }
      const input = collectInput(bridgeSpec, args);
      const out = await runBridgeAbility(ctx.config, bridgeSpec, input, ctx.signal);
      return { output: out };
    }

    switch (op) {
      case 'site_info': {
        const r = await jsonFetch(`${wpBase(ctx.config)}/wp-json`, { headers, signal: ctx.signal });
        return { output: { name: r.name, description: r.description, url: r.url } };
      }
      case 'list_posts': {
        const q = new URLSearchParams();
        if (args.status) q.set('status', String(args.status));
        if (args.search) q.set('search', String(args.search));
        q.set('per_page', String(Math.min(Number(args.per_page ?? 10), 50)));
        const r = await jsonFetch(`${base}/posts?${q}`, { headers, signal: ctx.signal });
        return { output: (r as any[]).map(slim) };
      }
      case 'get_post': {
        const r = await jsonFetch(`${base}/posts/${Number(args.id)}?context=edit`, { headers, signal: ctx.signal });
        return {
          output: { ...slim(r), content: r.content?.raw ?? r.content?.rendered, excerpt: r.excerpt?.raw },
        };
      }
      case 'create_post': {
        const body: Record<string, unknown> = {
          title: args.title,
          content: args.content,
          status: 'draft',
        };
        if (args.excerpt) body.excerpt = args.excerpt;
        if (args.categories) body.categories = args.categories;
        if (args.tags) body.tags = args.tags;
        if (args.featured_media !== undefined) body.featured_media = mediaId(args.featured_media);
        const r = await jsonFetch(`${base}/posts`, {
          method: 'POST',
          headers,
          body: JSON.stringify(body),
          signal: ctx.signal,
        });
        return { output: slim(r) };
      }
      case 'update_post': {
        const body: Record<string, unknown> = {};
        for (const k of ['title', 'content', 'excerpt', 'featured_media'] as const)
          if (args[k] !== undefined) body[k] = k === 'featured_media' ? mediaId(args[k]) : args[k];
        if (!Object.keys(body).length) throw new AdapterError('nothing to update');
        const r = await jsonFetch(`${base}/posts/${Number(args.id)}`, {
          method: 'POST',
          headers,
          body: JSON.stringify(body),
          signal: ctx.signal,
        });
        return { output: slim(r) };
      }
      case 'publish_post': {
        const r = await jsonFetch(`${base}/posts/${Number(args.id)}`, {
          method: 'POST',
          headers,
          body: JSON.stringify({ status: 'publish' }),
          signal: ctx.signal,
        });
        return { output: slim(r) };
      }
      case 'delete_post': {
        const r = await jsonFetch(`${base}/posts/${Number(args.id)}`, {
          method: 'DELETE',
          headers,
          signal: ctx.signal,
        });
        return { output: { id: r.id, status: r.status } };
      }
      case 'upload_media': {
        const hasUrl = args.source_url !== undefined;
        const hasBase64 = args.content_base64 !== undefined;
        if (hasUrl === hasBase64)
          throw new AdapterError('provide exactly one of source_url or content_base64');
        let buf: Buffer;
        let mediaType: string;
        let filename: string;
        if (hasUrl) {
          const fetched = await fetchPublicMedia(String(args.source_url), ctx.signal);
          buf = fetched.buffer;
          mediaType = fetched.mediaType;
          const fallback = filenameFromUrl(fetched.finalUrl);
          filename = checkedFilename(args.filename ?? fallback);
        } else {
          buf = decodeMediaBase64(args.content_base64);
          mediaType = normalizeMediaType(String(args.mime_type ?? ''));
          if (!isAllowedMediaType(mediaType))
            throw new AdapterError(`unsupported media type '${mediaType || 'missing'}'`);
          filename = checkedFilename(args.filename);
        }
        const r = await jsonFetch(`${base}/media`, {
          method: 'POST',
          headers: {
            Authorization: headers.Authorization,
            'Content-Type': mediaType,
            'Content-Disposition': mediaContentDisposition(filename),
          },
          body: new Uint8Array(buf),
          signal: ctx.signal,
          timeoutMs: 120_000,
        });
        if (args.alt_text) {
          await jsonFetch(`${base}/media/${r.id}`, {
            method: 'POST',
            headers,
            body: JSON.stringify({ alt_text: args.alt_text }),
            signal: ctx.signal,
          }).catch(() => undefined);
        }
        return { output: { id: r.id, source_url: r.source_url } };
      }
      case 'list_media': {
        const q = new URLSearchParams();
        if (args.search) q.set('search', String(args.search));
        if (args.media_type) q.set('media_type', String(args.media_type));
        if (args.mime_type) q.set('mime_type', String(args.mime_type));
        if (args.parent !== undefined) q.set('parent', String(nonNegativeInteger(args.parent, 'parent')));
        if (args.page !== undefined) q.set('page', String(positiveInteger(args.page, 'page')));
        q.set('per_page', String(Math.min(Math.max(Number(args.per_page ?? 10), 1), 50)));
        const r = await jsonFetch(`${base}/media?${q}`, { headers, signal: ctx.signal });
        return {
          output: (r as any[]).map((m) => ({
            id: m.id,
            date: m.date,
            title: m.title?.rendered,
            alt_text: m.alt_text,
            media_type: m.media_type,
            mime_type: m.mime_type,
            source_url: m.source_url,
            parent: m.post,
          })),
        };
      }
      case 'get_media': {
        const id = positiveInteger(args.id, 'id');
        const r = await jsonFetch(`${base}/media/${id}?context=edit`, { headers, signal: ctx.signal });
        return {
          output: {
            id: r.id,
            date: r.date,
            title: r.title?.raw ?? r.title?.rendered,
            caption: r.caption?.raw ?? r.caption?.rendered,
            description: r.description?.raw ?? r.description?.rendered,
            alt_text: r.alt_text,
            media_type: r.media_type,
            mime_type: r.mime_type,
            source_url: r.source_url,
            parent: r.post,
          },
        };
      }
      case 'update_media': {
        const id = positiveInteger(args.id, 'id');
        const body: Record<string, unknown> = {};
        for (const k of ['title', 'caption', 'description', 'alt_text'] as const)
          if (args[k] !== undefined) body[k] = args[k];
        if (args.parent !== undefined) body.post = nonNegativeInteger(args.parent, 'parent');
        if (!Object.keys(body).length) throw new AdapterError('nothing to update');
        const r = await jsonFetch(`${base}/media/${id}`, {
          method: 'POST',
          headers,
          body: JSON.stringify(body),
          signal: ctx.signal,
        });
        return { output: { id: r.id, title: r.title?.rendered, alt_text: r.alt_text, source_url: r.source_url, parent: r.post } };
      }
      case 'delete_media': {
        const id = positiveInteger(args.id, 'id');
        if (args.force !== true) throw new AdapterError('delete_media requires force=true');
        const r = await jsonFetch(`${base}/media/${id}?force=true`, {
          method: 'DELETE',
          headers,
          signal: ctx.signal,
        });
        return { output: { id: r.previous?.id ?? id, deleted: r.deleted === true } };
      }
      case 'list_categories': {
        const r = await jsonFetch(`${base}/categories?per_page=100`, { headers, signal: ctx.signal });
        return { output: (r as any[]).map((c) => ({ id: c.id, name: c.name, count: c.count })) };
      }
      case 'list_tags': {
        const r = await jsonFetch(`${base}/tags?per_page=100`, { headers, signal: ctx.signal });
        return { output: (r as any[]).map((t) => ({ id: t.id, name: t.name, count: t.count })) };
      }
      case 'create_page': {
        const body: Record<string, unknown> = { title: args.title, content: args.content, status: 'draft' };
        for (const k of ['excerpt', 'slug', 'parent', 'template', 'featured_media'] as const)
          if (args[k] !== undefined)
            body[k] =
              k === 'featured_media'
                ? mediaId(args[k])
                : k === 'parent'
                  ? nonNegativeInteger(args[k], 'parent')
                  : args[k];
        const r = await jsonFetch(`${base}/pages`, {
          method: 'POST',
          headers,
          body: JSON.stringify(body),
          signal: ctx.signal,
        });
        return { output: slim(r) };
      }
      case 'list_pages': {
        const q = new URLSearchParams();
        if (args.status) q.set('status', String(args.status));
        if (args.search) q.set('search', String(args.search));
        q.set('per_page', String(Math.min(Number(args.per_page ?? 10), 50)));
        const r = await jsonFetch(`${base}/pages?${q}`, { headers, signal: ctx.signal });
        return { output: (r as any[]).map(slim) };
      }
      case 'get_page': {
        const r = await jsonFetch(`${base}/pages/${Number(args.id)}?context=edit`, { headers, signal: ctx.signal });
        return {
          output: {
            ...slim(r),
            title: r.title?.raw ?? r.title?.rendered,
            content: r.content?.raw ?? r.content?.rendered,
            excerpt: r.excerpt?.raw ?? r.excerpt?.rendered,
            slug: r.slug,
            parent: r.parent,
            template: r.template,
            featured_media: r.featured_media,
          },
        };
      }
      case 'update_page': {
        const body: Record<string, unknown> = {};
        for (const k of ['title', 'content', 'excerpt', 'slug', 'parent', 'template', 'featured_media'] as const)
          if (args[k] !== undefined)
            body[k] =
              k === 'featured_media'
                ? mediaId(args[k])
                : k === 'parent'
                  ? nonNegativeInteger(args[k], 'parent')
                  : args[k];
        if (!Object.keys(body).length) throw new AdapterError('nothing to update');
        const r = await jsonFetch(`${base}/pages/${Number(args.id)}`, {
          method: 'POST',
          headers,
          body: JSON.stringify(body),
          signal: ctx.signal,
        });
        return { output: slim(r) };
      }
      case 'publish_page': {
        const r = await jsonFetch(`${base}/pages/${Number(args.id)}`, {
          method: 'POST',
          headers,
          body: JSON.stringify({ status: 'publish' }),
          signal: ctx.signal,
        });
        return { output: slim(r) };
      }
      case 'delete_page': {
        const r = await jsonFetch(`${base}/pages/${Number(args.id)}`, {
          method: 'DELETE',
          headers,
          signal: ctx.signal,
        });
        return { output: { id: r.id, status: r.status } };
      }
      case 'list_navigation': {
        const q = new URLSearchParams({ context: 'edit' });
        if (args.search) q.set('search', String(args.search));
        if (args.page !== undefined) q.set('page', String(positiveInteger(args.page, 'page')));
        q.set('per_page', String(Math.min(Math.max(Number(args.per_page ?? 10), 1), 50)));
        const r = await jsonFetch(`${base}/navigation?${q}`, { headers, signal: ctx.signal });
        return { output: (r as any[]).map(slim) };
      }
      case 'get_navigation': {
        const id = positiveInteger(args.id, 'id');
        const r = await jsonFetch(`${base}/navigation/${id}?context=edit`, { headers, signal: ctx.signal });
        return {
          output: {
            ...slim(r),
            title: r.title?.raw ?? r.title?.rendered,
            content: r.content?.raw ?? r.content?.rendered,
            slug: r.slug,
          },
        };
      }
      case 'update_navigation': {
        const id = positiveInteger(args.id, 'id');
        const body: Record<string, unknown> = {};
        for (const k of ['title', 'content', 'slug'] as const) if (args[k] !== undefined) body[k] = args[k];
        if (!Object.keys(body).length) throw new AdapterError('nothing to update');
        const r = await jsonFetch(`${base}/navigation/${id}`, {
          method: 'POST',
          headers,
          body: JSON.stringify(body),
          signal: ctx.signal,
        });
        return { output: slim(r) };
      }
      default:
        unknownOp('wordpress', op);
    }
  },
};

export default adapter;
