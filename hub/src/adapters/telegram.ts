import type { AdapterBootContext, AdapterContext, ChinvatAdapter } from '../types.js';
import type { DB } from '../db.js';
import { cfgStr, jsonFetch, msg, unknownOp } from './util.js';
import {
  chatsList,
  getOffset,
  messagesList,
  messagesSearch,
  messagesSince,
  persistUpdates,
  recentUpdatesView,
  resolveChatId,
} from './telegram-store.js';

const api = (token: string, method: string) => `https://api.telegram.org/bot${token}/${method}`;

let pollAbort: AbortController | null = null;

function requireDb(ctx: AdapterContext): DB {
  if (!ctx.db) throw new Error('telegram: database not available in this context');
  return ctx.db;
}

const INVITE_LINK_RE = /(^tg:\/\/join)|((?:t\.me|telegram\.me|telegram\.dog)\/(?:\+|joinchat\/))/i;

/** Bot API cannot resolve invite links to a chat_id — reject them outright rather than pretend. */
function rejectInviteLink(raw: string): void {
  if (INVITE_LINK_RE.test(raw.trim())) {
    throw new Error(
      `chat_id must not be an invite link ('${raw}') — invite links cannot be resolved via the Bot API; use the numeric chat ID or @username`
    );
  }
}

/** Resolves a stale, migrated numeric chat_id to its current identity. Non-numeric IDs (e.g. @username) pass through. */
function resolveChatArg(db: DB, raw: string): { requested: string; resolved: string } {
  const n = Number(raw);
  if (!Number.isInteger(n)) return { requested: raw, resolved: raw };
  return { requested: raw, resolved: String(resolveChatId(db, n)) };
}

function numericChatFilter(raw: unknown): number | undefined {
  if (raw == null) return undefined;
  const value = Number(raw);
  if (!Number.isInteger(value)) throw new Error('chat_id filter must be a numeric Telegram chat ID');
  return value;
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

/**
 * Long-poll loop: the sole Telegram getUpdates consumer. Every batch is
 * persisted (updates + chat registry + migrations + next offset) in one
 * transaction before the loop calls getUpdates with the advanced offset —
 * so an update is never acknowledged to Telegram before it is durable.
 * Also drives job notifications + approval inline buttons ("chinvat:approve:<id>").
 */
async function pollLoop(ctx: AdapterBootContext, signal: AbortSignal): Promise<void> {
  const token = String(ctx.config.botToken);
  const db = requireDb(ctx);
  let offset = getOffset(db);
  ctx.log('telegram approval/notification loop started');
  while (!signal.aborted) {
    try {
      const updates = await tg<any[]>(
        token,
        'getUpdates',
        {
          timeout: 25,
          offset,
          allowed_updates: ['callback_query', 'message', 'edited_message', 'channel_post', 'edited_channel_post'],
        },
        signal,
        35_000
      );
      if (updates.length > 0) {
        const nextOffset = updates.reduce((m, u) => Math.max(m, u.update_id + 1), offset);
        persistUpdates(db, updates, nextOffset);
        offset = nextOffset;
      }
      for (const u of updates) {
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
      help: 'Your user/group chat ID for notifications & approvals. Send /start to the bot, then use get_updates to find it.',
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
      description:
        'Recent updates from the local durable store (compatibility view; find your chat ID here). Never calls Telegram.',
      risk: 'read',
      params: {
        chat_id: { type: 'string', description: 'filter to one chat' },
        limit: { type: 'number', description: 'default 10, max 100' },
      },
    },
    {
      name: 'messages_list',
      description: 'List locally stored messages, most recent first by default.',
      risk: 'read',
      params: {
        chat_id: { type: 'string', description: 'filter to one chat' },
        limit: { type: 'number', description: 'default 50, max 100' },
        order: { type: 'string', description: "'asc' or 'desc' (default 'desc')" },
      },
    },
    {
      name: 'messages_since',
      description: 'List locally stored messages after an explicit timestamp or update_id boundary.',
      risk: 'read',
      params: {
        since_ts: { type: 'number', description: 'ms-epoch boundary on message date' },
        since_update_id: { type: 'number', description: 'update_id boundary (exclusive)' },
        chat_id: { type: 'string' },
        limit: { type: 'number', description: 'default 50, max 100' },
        order: { type: 'string', description: "'asc' or 'desc' (default 'asc')" },
      },
    },
    {
      name: 'messages_search',
      description: 'Search stored message/caption text.',
      risk: 'read',
      params: {
        query: { type: 'string', required: true },
        chat_id: { type: 'string' },
        limit: { type: 'number', description: 'default 50, max 100' },
        order: { type: 'string', description: "'asc' or 'desc' (default 'desc')" },
      },
    },
    {
      name: 'chats_list',
      description: 'List chats observed by the durable ingestion loop.',
      risk: 'read',
      params: {
        limit: { type: 'number', description: 'default 50, max 100' },
        order: { type: 'string', description: "'asc' or 'desc' (default 'desc')" },
      },
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
    const chatId = String(args.chat_id ?? ctx.config.chatId ?? '');
    switch (op) {
      case 'send_message': {
        if (!chatId) throw new Error('no chat_id given and no default chatId configured');
        rejectInviteLink(chatId);
        const token = cfgStr(ctx.config, 'botToken');
        const { requested, resolved } = resolveChatArg(requireDb(ctx), chatId);
        const payload: Record<string, unknown> = { chat_id: resolved, text: String(args.text) };
        if (args.parse_mode) payload.parse_mode = args.parse_mode;
        const r = await tg(token, 'sendMessage', payload, ctx.signal);
        const output: Record<string, unknown> = { message_id: r.message_id, chat_id: resolved };
        if (resolved !== requested) {
          output.requested_chat_id = requested;
          output.resolved_chat_id = resolved;
        }
        return { output };
      }
      case 'send_document': {
        if (!chatId) throw new Error('no chat_id given and no default chatId configured');
        rejectInviteLink(chatId);
        const token = cfgStr(ctx.config, 'botToken');
        const { requested, resolved } = resolveChatArg(requireDb(ctx), chatId);
        const form = new FormData();
        form.set('chat_id', resolved);
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
        const output: Record<string, unknown> = {
          message_id: r.result?.message_id,
          chat_id: resolved,
        };
        if (resolved !== requested) {
          output.requested_chat_id = requested;
          output.resolved_chat_id = resolved;
        }
        return { output };
      }
      case 'get_me': {
        const token = cfgStr(ctx.config, 'botToken');
        return { output: await tg(token, 'getMe', {}, ctx.signal) };
      }
      case 'get_updates': {
        const db = requireDb(ctx);
        const chat = numericChatFilter(args.chat_id);
        return {
          output: recentUpdatesView(db, {
            limit: typeof args.limit === 'number' ? args.limit : undefined,
            chat_id: chat != null && Number.isInteger(chat) ? chat : undefined,
          }),
        };
      }
      case 'messages_list': {
        const db = requireDb(ctx);
        const chat = numericChatFilter(args.chat_id);
        return {
          output: messagesList(db, {
            chat_id: chat != null && Number.isInteger(chat) ? chat : undefined,
            limit: typeof args.limit === 'number' ? args.limit : undefined,
            order: args.order === 'asc' ? 'asc' : args.order === 'desc' ? 'desc' : undefined,
          }),
        };
      }
      case 'messages_since': {
        const db = requireDb(ctx);
        const chat = numericChatFilter(args.chat_id);
        return {
          output: messagesSince(db, {
            since_ts: typeof args.since_ts === 'number' ? args.since_ts : undefined,
            since_update_id: typeof args.since_update_id === 'number' ? args.since_update_id : undefined,
            chat_id: chat != null && Number.isInteger(chat) ? chat : undefined,
            limit: typeof args.limit === 'number' ? args.limit : undefined,
            order: args.order === 'asc' ? 'asc' : args.order === 'desc' ? 'desc' : undefined,
          }),
        };
      }
      case 'messages_search': {
        const db = requireDb(ctx);
        const chat = numericChatFilter(args.chat_id);
        return {
          output: messagesSearch(db, {
            query: String(args.query ?? ''),
            chat_id: chat != null && Number.isInteger(chat) ? chat : undefined,
            limit: typeof args.limit === 'number' ? args.limit : undefined,
            order: args.order === 'asc' ? 'asc' : args.order === 'desc' ? 'desc' : undefined,
          }),
        };
      }
      case 'chats_list': {
        const db = requireDb(ctx);
        return {
          output: chatsList(db, {
            limit: typeof args.limit === 'number' ? args.limit : undefined,
            order: args.order === 'asc' ? 'asc' : args.order === 'desc' ? 'desc' : undefined,
          }),
        };
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
    const controller = new AbortController();
    pollAbort = controller;
    if (ctx.signal?.aborted) {
      controller.abort();
    } else {
      ctx.signal?.addEventListener('abort', () => controller.abort(), { once: true });
    }
    void pollLoop(ctx, controller.signal);
  },
};

export default adapter;
