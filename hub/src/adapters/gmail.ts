/**
 * Gmail transport adapter — the mail carrier for the chat-relay lane
 * (docs/DESIGN-mail-relay.md §Mail transport). It is a generic Gmail worker,
 * usable beyond relay: send a message, poll the inbox by query, list/read
 * drafts (Gemini returns replies as drafts, ChatGPT sends them), and label a
 * message processed so the poller does not re-import it.
 *
 * Auth: OAuth2 installed-app flow. The operator runs the one-time consent
 * (loopback redirect, documented in the setup guide) and stores client_id,
 * client_secret and refresh_token in module config. The adapter mints a
 * short-lived access token per call and never persists it.
 *
 * Risk: read for polling/reading, act for send/label. Default tier `approve`
 * so a send pauses for one dashboard/Telegram click. The chat-relay adapter,
 * not this module, owns the relay lifecycle; gmail just moves bytes.
 */
import { Buffer } from 'node:buffer';
import { AdapterError } from '../types.js';
import type {
  AdapterContext,
  AdapterBootContext,
  ChinvatAdapter,
  InvokeResult,
} from '../types.js';
import { msg, requireConfig } from './util.js';

const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const API = 'https://gmail.googleapis.com/gmail/v1/users/me';

interface GmailCfg {
  clientId: string;
  clientSecret: string;
  refreshToken: string;
  pollSeconds: number;
  relayLabel: string;
}

function cfg(ctx: AdapterContext): GmailCfg {
  requireConfig(ctx.config, ['client_id', 'client_secret', 'refresh_token']);
  const pollSeconds = Number(ctx.config.poll_seconds ?? 30);
  return {
    clientId: String(ctx.config.client_id),
    clientSecret: String(ctx.config.client_secret),
    refreshToken: String(ctx.config.refresh_token),
    pollSeconds: Number.isFinite(pollSeconds) && pollSeconds >= 10 ? Math.floor(pollSeconds) : 30,
    relayLabel: String(ctx.config.relay_label ?? 'chinvat-processed'),
  };
}

async function accessToken(c: GmailCfg, signal?: AbortSignal): Promise<string> {
  const body = new URLSearchParams({
    client_id: c.clientId,
    client_secret: c.clientSecret,
    refresh_token: c.refreshToken,
    grant_type: 'refresh_token',
  });
  const res = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
    signal,
  });
  const text = await res.text();
  if (!res.ok) throw new AdapterError(`Gmail token refresh failed (HTTP ${res.status}): ${text.slice(0, 400)}`);
  const json = JSON.parse(text) as { access_token?: string };
  if (!json.access_token) throw new AdapterError('Gmail token refresh returned no access_token');
  return json.access_token;
}

async function api<T = any>(
  token: string,
  pathname: string,
  init: RequestInit = {},
  signal?: AbortSignal
): Promise<T> {
  const res = await fetch(`${API}${pathname}`, {
    ...init,
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', ...(init.headers ?? {}) },
    signal,
  });
  const text = await res.text();
  if (!res.ok) throw new AdapterError(`Gmail API ${pathname} → HTTP ${res.status}: ${text.slice(0, 500)}`);
  return (text ? JSON.parse(text) : null) as T;
}

function base64url(s: string): string {
  return Buffer.from(s, 'utf8').toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function buildRawMessage(to: string, subject: string, body: string): string {
  const headers = [
    `To: ${to}`,
    `Subject: ${subject}`,
    'MIME-Version: 1.0',
    'Content-Type: text/plain; charset="UTF-8"',
    'Content-Transfer-Encoding: 7bit',
  ];
  return base64url(`${headers.join('\r\n')}\r\n\r\n${body}`);
}

/** Decode a Gmail message payload to plain text (walks multipart, prefers text/plain). */
function decodeMessage(payload: any): string {
  if (!payload) return '';
  const collect = (part: any): string => {
    if (!part) return '';
    if (part.body?.data) {
      const buf = Buffer.from(String(part.body.data).replace(/-/g, '+').replace(/_/g, '/'), 'base64');
      return buf.toString('utf8');
    }
    if (Array.isArray(part.parts)) {
      const plain = part.parts.find((p: any) => p.mimeType === 'text/plain');
      if (plain) return collect(plain);
      return part.parts.map(collect).join('\n');
    }
    return '';
  };
  return collect(payload);
}

// Poller lifecycle (single loop per process, like telegram).
let pollAbort: AbortController | null = null;

const adapter: ChinvatAdapter = {
  name: 'gmail',
  version: '0.1.0',
  description:
    'Gmail transport (OAuth2 installed-app): send a message, poll the inbox by query, read drafts, label processed. Carrier for the chat-relay lane; usable standalone.',
  activation: {
    kind: 'service',
    note: 'One-time OAuth consent (loopback). Store client_id, client_secret, refresh_token in config. See app-bridges/gmail/SETUP.md.',
    guide: 'app-bridges/gmail/SETUP.md',
  },
  configSchema: [
    { key: 'client_id', label: 'OAuth client ID', type: 'string', required: true },
    { key: 'client_secret', label: 'OAuth client secret', type: 'secret', required: true },
    { key: 'refresh_token', label: 'OAuth refresh token', type: 'secret', required: true },
    { key: 'poll_seconds', label: 'Inbox poll interval (s)', type: 'number', default: 30 },
    { key: 'relay_label', label: 'Label applied to processed relay mail', type: 'string', default: 'chinvat-processed' },
  ],

  capabilities: () => [
    {
      name: 'send_mail',
      description: 'Send a plain-text email from the authenticated account.',
      risk: 'act',
      params: {
        to: { type: 'string', description: 'Recipient address', required: true },
        subject: { type: 'string', description: 'Subject line', required: true },
        body: { type: 'string', description: 'Plain-text body', required: true },
      },
    },
    {
      name: 'poll_matching',
      description:
        'List message summaries matching a Gmail search query (e.g. subject:[CHINVAT CR-...]). Read-only; returns id/subject/snippet.',
      risk: 'read',
      params: {
        query: { type: 'string', description: 'Gmail search query', required: true },
        max: { type: 'number', description: 'Max results (default 20)' },
      },
    },
    {
      name: 'read_message',
      description: 'Read the full plain-text body of a message by id.',
      risk: 'read',
      params: { id: { type: 'string', description: 'Gmail message id', required: true } },
    },
    {
      name: 'list_drafts',
      description: 'List drafts, optionally filtered by a subject substring (Gemini return path).',
      risk: 'read',
      params: { subject_contains: { type: 'string', description: 'Filter drafts by subject substring' } },
    },
    {
      name: 'read_draft',
      description: 'Read the full plain-text body of a draft by id.',
      risk: 'read',
      params: { id: { type: 'string', description: 'Gmail draft id', required: true } },
    },
    {
      name: 'label_processed',
      description: 'Apply the relay-processed label to a message so it is not re-imported.',
      risk: 'act',
      params: { id: { type: 'string', description: 'Gmail message id', required: true } },
    },
  ],

  async health(ctx) {
    try {
      const c = cfg(ctx);
      const token = await accessToken(c, ctx.signal);
      const prof = await api<{ emailAddress?: string }>(token, '/profile', {}, ctx.signal);
      return { ok: true, detail: `authenticated as ${prof.emailAddress ?? 'unknown'} · poll ${c.pollSeconds}s` };
    } catch (e) {
      return { ok: false, detail: msg(e) };
    }
  },

  async invoke(operation, args, ctx): Promise<InvokeResult> {
    const c = cfg(ctx);
    const token = await accessToken(c, ctx.signal);

    switch (operation) {
      case 'send_mail': {
        const to = String(args.to ?? '');
        const subject = String(args.subject ?? '');
        const body = String(args.body ?? '');
        if (!to || !subject) throw new AdapterError('send_mail requires to and subject');
        const raw = buildRawMessage(to, subject, body);
        const sent = await api<{ id: string }>(
          token,
          '/messages/send',
          { method: 'POST', body: JSON.stringify({ raw }) },
          ctx.signal
        );
        ctx.log(`sent mail to ${to} (${sent.id})`);
        return { output: { id: sent.id, to, subject } };
      }

      case 'poll_matching': {
        const query = String(args.query ?? '');
        if (!query) throw new AdapterError('poll_matching requires query');
        const max = Number.isInteger(Number(args.max)) ? Math.min(Number(args.max), 50) : 20;
        const list = await api<{ messages?: Array<{ id: string }> }>(
          token,
          `/messages?q=${encodeURIComponent(query)}&maxResults=${max}`,
          {},
          ctx.signal
        );
        const ids = (list.messages ?? []).map((m) => m.id);
        const summaries = [];
        for (const id of ids) {
          const m = await api<any>(
            token,
            `/messages/${id}?format=metadata&metadataHeaders=Subject&metadataHeaders=From`,
            {},
            ctx.signal
          );
          const headers: Array<{ name: string; value: string }> = m.payload?.headers ?? [];
          const subject = headers.find((h) => h.name === 'Subject')?.value ?? '';
          const from = headers.find((h) => h.name === 'From')?.value ?? '';
          summaries.push({ id, subject, from, snippet: m.snippet ?? '' });
        }
        return { output: { count: summaries.length, messages: summaries } };
      }

      case 'read_message': {
        const id = String(args.id ?? '');
        const m = await api<any>(token, `/messages/${id}?format=full`, {}, ctx.signal);
        return { output: { id, body: decodeMessage(m.payload), snippet: m.snippet ?? '' } };
      }

      case 'list_drafts': {
        const filter = args.subject_contains ? String(args.subject_contains).toLowerCase() : '';
        const list = await api<{ drafts?: Array<{ id: string; message: { id: string } }> }>(
          token,
          '/drafts?maxResults=50',
          {},
          ctx.signal
        );
        const out = [];
        for (const d of list.drafts ?? []) {
          const m = await api<any>(
            token,
            `/messages/${d.message.id}?format=metadata&metadataHeaders=Subject`,
            {},
            ctx.signal
          );
          const subject =
            (m.payload?.headers ?? []).find((h: any) => h.name === 'Subject')?.value ?? '';
          if (filter && !subject.toLowerCase().includes(filter)) continue;
          out.push({ draft_id: d.id, message_id: d.message.id, subject });
        }
        return { output: { count: out.length, drafts: out } };
      }

      case 'read_draft': {
        const id = String(args.id ?? '');
        const d = await api<any>(token, `/drafts/${id}?format=full`, {}, ctx.signal);
        return { output: { id, body: decodeMessage(d.message?.payload), snippet: d.message?.snippet ?? '' } };
      }

      case 'label_processed': {
        const id = String(args.id ?? '');
        const labelId = await ensureLabel(token, c.relayLabel, ctx.signal);
        await api(
          token,
          `/messages/${id}/modify`,
          { method: 'POST', body: JSON.stringify({ addLabelIds: [labelId] }) },
          ctx.signal
        );
        return { output: { id, labeled: c.relayLabel } };
      }

      default:
        throw new AdapterError(`unknown operation: ${operation}`);
    }
  },

  onBoot: async (ctx: AdapterBootContext) => {
    // The gmail module itself does not run a relay loop — chat-relay owns that
    // and calls gmail ops per task. We keep onBoot as a no-op placeholder so a
    // future standalone "watch and emit" mode has a home. Abort on shutdown.
    pollAbort?.abort();
    pollAbort = new AbortController();
    ctx.log('gmail adapter booted (transport only; chat-relay drives polling)');
  },
};

async function ensureLabel(token: string, name: string, signal?: AbortSignal): Promise<string> {
  const list = await api<{ labels?: Array<{ id: string; name: string }> }>(token, '/labels', {}, signal);
  const found = (list.labels ?? []).find((l) => l.name === name);
  if (found) return found.id;
  const created = await api<{ id: string }>(
    token,
    '/labels',
    {
      method: 'POST',
      body: JSON.stringify({ name, labelListVisibility: 'labelShow', messageListVisibility: 'show' }),
    },
    signal
  );
  return created.id;
}

export default adapter;
