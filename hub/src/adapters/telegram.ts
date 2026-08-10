import { createHash } from 'node:crypto';
import { closeSync, openSync, readFileSync, rmSync, statSync, writeSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AdapterBootContext, ChinvatAdapter } from '../types.js';
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

/** Last updates seen by the poll loop, so get_updates still works while polling. */
const recentUpdates: any[] = [];

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
  chat_id: u.message?.chat?.id ?? u.callback_query?.message?.chat?.id,
  from: u.message?.from?.username,
  text: u.message?.text,
});

/** Long-poll loop: job notifications + approval inline buttons ("chinvat:approve:<id>"). */
async function pollLoop(ctx: AdapterBootContext): Promise<void> {
  const token = String(ctx.config.botToken);
  let offset = 0;
  const signal = pollAbort!.signal;
  ctx.log('telegram approval/notification loop started');
  try {
    while (!signal.aborted) {
      try {
        const updates = await tg<any[]>(
          token,
          'getUpdates',
          { timeout: 25, offset, allowed_updates: ['callback_query', 'message'] },
          signal,
          35_000
        );
        for (const u of updates) {
          offset = Math.max(offset, u.update_id + 1);
          recentUpdates.push(summarise(u));
          if (recentUpdates.length > 20) recentUpdates.splice(0, recentUpdates.length - 20);
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
  version: '0.1.0',
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
  ],

  health: async (ctx) => {
    if (!ctx.config.botToken) return { ok: false, detail: 'botToken not configured' };
    try {
      const me = await tg<{ username: string }>(String(ctx.config.botToken), 'getMe', {}, undefined, 6000);
      return { ok: true, detail: `@${me.username}` };
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
          const updates = await tg<any[]>(token, 'getUpdates', { timeout: 0 }, ctx.signal);
          return { output: updates.slice(-10).map(summarise) };
        } catch (e) {
          const detail = msg(e);
          if (detail.includes('terminated by other getUpdates')) {
            throw new Error(
              'another hub instance is polling this bot; disable "Send approval requests with buttons" to read updates directly, or check the hub log for the incoming chat ID'
            );
          }
          throw e;
        }
      }
      default:
        unknownOp('telegram', op);
    }
  },

  onBoot: async (ctx) => {
    const token = ctx.config.botToken ? String(ctx.config.botToken) : '';
    if (!token) return;
    const chatId = ctx.config.chatId ? String(ctx.config.chatId) : '';

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

    // Polling exists to serve the approval buttons; skip it when they are off.
    if (ctx.config.approvalButtons === false) {
      ctx.log('telegram: approval buttons disabled — not polling for updates');
      return;
    }
    if (!tryAcquirePollLock(token, (m) => ctx.log(m))) return;

    pollAbort = new AbortController();
    void pollLoop(ctx);
  },
};

export default adapter;
