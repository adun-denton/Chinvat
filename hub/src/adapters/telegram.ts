import { createHash } from 'node:crypto';
import { closeSync, mkdirSync, openSync, readFileSync, rmSync, statSync, writeFileSync, writeSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { AdapterError, type AdapterBootContext, type ChinvatAdapter } from '../types.js';
import { cfgStr, jsonFetch, msg, unknownOp } from './util.js';

const api = (token: string, method: string) => `https://api.telegram.org/bot${token}/${method}`;

let pollAbort: AbortController | null = null;

/**
 * Telegram allows exactly one live getUpdates call per bot token. A single MCP
 * client (Claude desktop, for one) can spawn several hub processes, so the
 * poll loop is fenced behind an OS-level lock file keyed on the bot token:
 * whichever process claims it polls, the rest stay quiet and keep serving
 * everything else. Without this, the losers spin on HTTP 409 forever.
 */
const LOCK_STALE_MS = 60_000;
const LOCK_HEARTBEAT_MS = 20_000;

let lockPath: string | null = null;
let lockHeartbeat: ReturnType<typeof setInterval> | null = null;

const lockFileFor = (token: string) =>
  join(tmpdir(), `chinvat-telegram-${createHash('sha256').update(token).digest('hex').slice(0, 16)}.lock`);

function stampLock(path: string): void {
  const fd = openSync(path, 'w');
  try {
    writeSync(fd, JSON.stringify({ pid: process.pid, at: Date.now() }));
  } finally {
    closeSync(fd);
  }
}

function releasePollLock(): void {
  if (lockHeartbeat) {
    clearInterval(lockHeartbeat);
    lockHeartbeat = null;
  }
  if (lockPath) {
    try {
      rmSync(lockPath, { force: true });
    } catch {
      /* best effort */
    }
    lockPath = null;
  }
}

/** Exclusive-create the lock; steal it only if the previous holder stopped refreshing. */
function tryAcquirePollLock(token: string, log: (m: string) => void): boolean {
  const path = lockFileFor(token);
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const fd = openSync(path, 'wx');
      try {
        writeSync(fd, JSON.stringify({ pid: process.pid, at: Date.now() }));
      } finally {
        closeSync(fd);
      }
      lockPath = path;
      lockHeartbeat = setInterval(() => {
        try {
          stampLock(path);
        } catch {
          /* best effort */
        }
      }, LOCK_HEARTBEAT_MS);
      lockHeartbeat.unref?.();
      process.once('exit', releasePollLock);
      return true;
    } catch {
      let age = LOCK_STALE_MS + 1;
      try {
        age = Date.now() - statSync(path).mtimeMs;
      } catch {
        /* vanished between calls — fall through and retry */
      }
      if (age <= LOCK_STALE_MS) {
        let holder = '';
        try {
          holder = ` (pid ${JSON.parse(readFileSync(path, 'utf8')).pid})`;
        } catch {
          /* unreadable lock body is not fatal */
        }
        log(`telegram: another hub instance${holder} owns the update poll; this one will not poll`);
        return false;
      }
      try {
        rmSync(path, { force: true });
      } catch {
        /* best effort */
      }
    }
  }
  return false;
}

/* ------------------------------------------------------------------ *
 * Durable state: poll offset + observed business connections.
 * ------------------------------------------------------------------ */

interface BusinessConnection {
  id: string;
  user_chat_id?: number;
  username?: string;
  date?: number;
  is_enabled?: boolean;
  /** Verbatim rights object from Telegram — the authoritative capability map. */
  rights?: Record<string, unknown>;
  /** Set when an older Bot API sends the deprecated flat flag instead of `rights`. */
  can_reply?: boolean;
  seen_at: number;
}

interface TelegramState {
  offset: number;
  connections: Record<string, BusinessConnection>;
}

let statePath: string | null = null;
let state: TelegramState = { offset: 0, connections: {} };

function loadState(dataDir: string): void {
  statePath = join(dataDir, 'telegram-state.json');
  try {
    const raw = JSON.parse(readFileSync(statePath, 'utf8')) as Partial<TelegramState>;
    state = {
      offset: typeof raw.offset === 'number' ? raw.offset : 0,
      connections: raw.connections ?? {},
    };
  } catch {
    state = { offset: 0, connections: {} };
  }
}

function saveState(): void {
  if (!statePath) return;
  try {
    mkdirSync(dirname(statePath), { recursive: true });
    writeFileSync(statePath, JSON.stringify(state, null, 2));
  } catch {
    /* state is an optimisation, never a hard dependency */
  }
}

/** Last updates seen by the poll loop, so get_updates still works while polling. */
const recentUpdates: any[] = [];

async function tg<T = any>(
  token: string,
  method: string,
  payload?: Record<string, unknown>,
  signal?: AbortSignal,
  timeoutMs = 30_000
): Promise<T> {
  const r = await jsonFetch<{ ok: boolean; result: T; description?: string }>(api(token, method), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload ?? {}),
    signal,
    timeoutMs,
  });
  if (!r.ok) throw new Error(`telegram ${method}: ${r.description ?? 'unknown error'}`);
  return r.result;
}

const summarise = (u: any) => ({
  update_id: u.update_id,
  kind: u.business_message
    ? 'business_message'
    : u.business_connection
      ? 'business_connection'
      : u.callback_query
        ? 'callback_query'
        : 'message',
  chat_id:
    u.message?.chat?.id ?? u.business_message?.chat?.id ?? u.callback_query?.message?.chat?.id,
  business_connection_id: u.business_message?.business_connection_id ?? u.business_connection?.id,
  from: u.message?.from?.username ?? u.business_message?.from?.username,
  text: u.message?.text ?? u.business_message?.text,
});

/** Split a Telegram rights object into granted / withheld, so the map survives new fields. */
function partitionRights(rights: Record<string, unknown> | undefined) {
  const granted: string[] = [];
  const withheld: string[] = [];
  for (const [k, v] of Object.entries(rights ?? {})) (v === true ? granted : withheld).push(k);
  return { granted: granted.sort(), withheld: withheld.sort() };
}

function recordConnection(bc: any, log: (m: string) => void): void {
  const entry: BusinessConnection = {
    id: String(bc.id),
    user_chat_id: bc.user_chat_id,
    username: bc.user?.username,
    date: bc.date,
    is_enabled: bc.is_enabled,
    rights: bc.rights,
    can_reply: bc.can_reply,
    seen_at: Date.now(),
  };
  state.connections[entry.id] = entry;
  saveState();
  const { granted, withheld } = partitionRights(entry.rights);
  log(
    `telegram business connection ${entry.id} (@${entry.username ?? '?'}) enabled=${entry.is_enabled} ` +
      `granted=[${granted.join(', ') || 'none'}] withheld=[${withheld.join(', ') || 'none'}]`
  );
}

const businessOn = (config: Record<string, unknown>) => config.businessMode === true;

function allowedUpdatesFor(config: Record<string, unknown>): string[] {
  const base = ['callback_query', 'message'];
  if (!businessOn(config)) return base;
  return [
    ...base,
    'business_connection',
    'business_message',
    'edited_business_message',
    'deleted_business_messages',
  ];
}

/** Long-poll loop: approvals, notifications, and (when enabled) business updates. */
async function pollLoop(ctx: AdapterBootContext): Promise<void> {
  const token = String(ctx.config.botToken);
  const allowed = allowedUpdatesFor(ctx.config);
  const signal = pollAbort!.signal;
  ctx.log(`telegram poll loop started (offset ${state.offset}, allowed_updates: ${allowed.join(', ')})`);
  try {
    while (!signal.aborted) {
      try {
        const updates = await tg<any[]>(
          token,
          'getUpdates',
          { timeout: 25, offset: state.offset, allowed_updates: allowed },
          signal,
          35_000
        );
        let advanced = false;
        for (const u of updates) {
          if (u.update_id + 1 > state.offset) {
            state.offset = u.update_id + 1;
            advanced = true;
          }
          recentUpdates.push(summarise(u));
          if (recentUpdates.length > 50) recentUpdates.splice(0, recentUpdates.length - 50);

          if (u.business_connection) recordConnection(u.business_connection, (m) => ctx.log(m));

          const cq = u.callback_query;
          if (cq?.data?.startsWith('chinvat:')) {
            const [, action, approvalId] = cq.data.split(':');
            const decision = action === 'approve' ? 'approved' : 'denied';
            const okResolve = ctx.hub.resolveApproval(approvalId, decision, 'telegram');
            await tg(token, 'answerCallbackQuery', {
              callback_query_id: cq.id,
              text: okResolve ? `Job ${decision}.` : 'Already decided.',
            }).catch(() => undefined);
            if (okResolve && cq.message) {
              await tg(token, 'editMessageText', {
                chat_id: cq.message.chat.id,
                message_id: cq.message.message_id,
                text: `${cq.message.text}\n\n➡ ${decision.toUpperCase()} via Telegram`,
              }).catch(() => undefined);
            }
          }
        }
        // Offset is persisted so a restart resumes instead of replaying up to 24h
        // of backlog in one burst.
        if (advanced) saveState();
      } catch (e) {
        if (signal.aborted) break;
        ctx.log(`telegram poll error (retrying in 5s): ${msg(e)}`);
        await new Promise((r) => setTimeout(r, 5000));
      }
    }
  } finally {
    releasePollLock();
  }
}

const adapter: ChinvatAdapter = {
  name: 'telegram',
  version: '0.2.0',
  description: 'Telegram bot — messages, job notifications, and approve/deny from your phone.',
  configSchema: [
    { key: 'botToken', label: 'Bot token', type: 'secret', required: true, help: 'From @BotFather' },
    {
      key: 'chatId',
      label: 'Default chat ID',
      type: 'string',
      help: 'Your numeric user/group chat ID for notifications & approvals. Send /start to the bot, then use get_updates to find it.',
    },
    { key: 'notifyJobs', label: 'Notify on job completion', type: 'boolean', default: false },
    { key: 'approvalButtons', label: 'Send approval requests with buttons', type: 'boolean', default: true },
    {
      key: 'businessMode',
      label: 'Observe Secretary Mode connections',
      type: 'boolean',
      default: false,
      help: 'Receive business_connection / business_message updates and record the granted rights. Read-only.',
    },
    {
      key: 'businessSend',
      label: 'Allow sending as the connected account',
      type: 'boolean',
      default: false,
      help: 'Arms business_send_message. Messages sent this way appear to come from you with no bot marker and cannot be recalled from the recipient.',
    },
  ],

  capabilities: () => [
    {
      name: 'send_message',
      description: 'Send a text message.',
      risk: 'act',
      params: {
        text: { type: 'string', required: true },
        chat_id: { type: 'string', description: 'defaults to configured chatId' },
        parse_mode: { type: 'string', description: 'MarkdownV2 | HTML' },
      },
    },
    {
      name: 'send_document',
      description: 'Send a small text document.',
      risk: 'act',
      params: {
        content: { type: 'string', required: true },
        filename: { type: 'string' },
        chat_id: { type: 'string' },
      },
    },
    { name: 'get_me', description: 'Bot identity check.', risk: 'read', params: {} },
    {
      name: 'get_updates',
      description: 'Recent updates (find your chat ID here).',
      risk: 'read',
      params: {},
    },
    {
      name: 'business_connections',
      description: 'Secretary Mode connections seen so far, with the granted/withheld rights map.',
      risk: 'read',
      params: {},
    },
    {
      name: 'business_send_message',
      description:
        'Send a message AS the connected account (Secretary Mode). Indistinguishable from the user; requires businessSend.',
      risk: 'dangerous',
      params: {
        text: { type: 'string', required: true },
        chat_id: { type: 'string', required: true },
        business_connection_id: {
          type: 'string',
          description: 'defaults to the only known connection',
        },
        parse_mode: { type: 'string', description: 'MarkdownV2 | HTML' },
      },
    },
  ],

  health: async (ctx) => {
    if (!ctx.config.botToken) return { ok: false, detail: 'botToken not configured' };
    try {
      const me = await tg<{ username: string }>(String(ctx.config.botToken), 'getMe', {}, undefined, 6000);
      const n = Object.keys(state.connections).length;
      return { ok: true, detail: `@${me.username}${n ? ` · ${n} business connection(s)` : ''}` };
    } catch (e) {
      return { ok: false, detail: msg(e) };
    }
  },

  invoke: async (op, args, ctx) => {
    const token = cfgStr(ctx.config, 'botToken');
    const chatId = String(args.chat_id ?? ctx.config.chatId ?? '');
    switch (op) {
      case 'send_message': {
        if (!chatId) throw new Error('no chat_id given and no default chatId configured');
        const payload: Record<string, unknown> = { chat_id: chatId, text: String(args.text) };
        if (args.parse_mode) payload.parse_mode = args.parse_mode;
        const r = await tg(token, 'sendMessage', payload, ctx.signal);
        return { output: { message_id: r.message_id, chat_id: chatId } };
      }
      case 'send_document': {
        if (!chatId) throw new Error('no chat_id given and no default chatId configured');
        const form = new FormData();
        form.set('chat_id', chatId);
        form.set(
          'document',
          new Blob([String(args.content)], { type: 'text/plain' }),
          String(args.filename ?? 'chinvat.txt')
        );
        const r = await jsonFetch<{ ok: boolean; result: any }>(api(token, 'sendDocument'), {
          method: 'POST',
          body: form,
          signal: ctx.signal,
        });
        return { output: { message_id: r.result?.message_id } };
      }
      case 'get_me': {
        return { output: await tg(token, 'getMe', {}, ctx.signal) };
      }
      case 'get_updates': {
        // The poll loop drains getUpdates, so serve its cache when this process owns it.
        if (lockPath) return { output: recentUpdates.slice(-10) };
        try {
          const updates = await tg<any[]>(
            token,
            'getUpdates',
            { timeout: 0, allowed_updates: allowedUpdatesFor(ctx.config) },
            ctx.signal
          );
          for (const u of updates) if (u.business_connection) recordConnection(u.business_connection, (m) => ctx.log(m));
          return { output: updates.slice(-10).map(summarise) };
        } catch (e) {
          const detail = msg(e);
          if (detail.includes('terminated by other getUpdates')) {
            throw new AdapterError(
              'another hub instance is polling this bot; disable "Send approval requests with buttons" to read updates directly, or check the hub log for the incoming chat ID'
            );
          }
          throw e;
        }
      }
      case 'business_connections': {
        return {
          output: Object.values(state.connections).map((c) => ({
            id: c.id,
            username: c.username,
            user_chat_id: c.user_chat_id,
            is_enabled: c.is_enabled,
            seen_at: new Date(c.seen_at).toISOString(),
            ...partitionRights(c.rights),
            ...(c.rights ? {} : { legacy_can_reply: c.can_reply }),
          })),
        };
      }
      case 'business_send_message': {
        if (ctx.config.businessSend !== true)
          throw new AdapterError(
            'business_send_message is disarmed — set "Allow sending as the connected account" (businessSend) in the dashboard to enable it'
          );
        const ids = Object.keys(state.connections);
        const connectionId = String(args.business_connection_id ?? (ids.length === 1 ? ids[0] : ''));
        if (!connectionId)
          throw new AdapterError(
            ids.length
              ? `business_connection_id required — known connections: ${ids.join(', ')}`
              : 'no business connection recorded yet; connect the bot in Telegram → Settings → Business → Chatbots'
          );
        if (!args.chat_id) throw new AdapterError('chat_id is required for business_send_message');
        const payload: Record<string, unknown> = {
          business_connection_id: connectionId,
          chat_id: String(args.chat_id),
          text: String(args.text),
        };
        if (args.parse_mode) payload.parse_mode = args.parse_mode;
        const r = await tg(token, 'sendMessage', payload, ctx.signal);
        ctx.log(`telegram business_send_message → chat ${args.chat_id} via ${connectionId}`);
        return { output: { message_id: r.message_id, chat_id: args.chat_id, business_connection_id: connectionId } };
      }
      default:
        unknownOp('telegram', op);
    }
  },

  onBoot: async (ctx) => {
    const token = ctx.config.botToken ? String(ctx.config.botToken) : '';
    if (!token) return;
    const chatId = ctx.config.chatId ? String(ctx.config.chatId) : '';
    loadState(ctx.dataDir);

    // Push approval requests & job notifications to the default chat.
    ctx.hub.onEvent((evt) => {
      if (!chatId) return;
      void (async () => {
        try {
          if (evt.type === 'approval.requested' && ctx.config.approvalButtons !== false) {
            const a = evt.approval as {
              id: string;
              module: string;
              operation: string;
              args: Record<string, unknown>;
            };
            await tg(token, 'sendMessage', {
              chat_id: chatId,
              text: `⚖️ Approval needed\n${a.module}.${a.operation}\n${JSON.stringify(a.args).slice(0, 500)}`,
              reply_markup: {
                inline_keyboard: [
                  [
                    { text: '✅ Approve', callback_data: `chinvat:approve:${a.id}` },
                    { text: '❌ Deny', callback_data: `chinvat:deny:${a.id}` },
                  ],
                ],
              },
            });
          } else if (evt.type === 'job.status' && ctx.config.notifyJobs === true) {
            const job = evt.job as { id: string; module: string; operation: string; status: string };
            if (['succeeded', 'failed'].includes(job.status)) {
              await tg(token, 'sendMessage', {
                chat_id: chatId,
                text: `${job.status === 'succeeded' ? '✅' : '💥'} ${job.module}.${job.operation} → ${job.status} (${job.id.slice(0, 8)})`,
              });
            }
          }
        } catch (e) {
          ctx.log(`telegram notify failed: ${msg(e)}`);
        }
      })();
    });

    pollAbort?.abort();
    pollAbort = null;
    releasePollLock();

    // Polling serves approval buttons and business observation; skip only if both are off.
    if (ctx.config.approvalButtons === false && !businessOn(ctx.config)) {
      ctx.log('telegram: approval buttons and business mode both off — not polling');
      return;
    }
    if (!tryAcquirePollLock(token, (m) => ctx.log(m))) return;

    pollAbort = new AbortController();
    void pollLoop(ctx);
  },
};

export default adapter;
