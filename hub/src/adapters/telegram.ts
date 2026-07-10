import type { AdapterBootContext, ChinvatAdapter } from '../types.js';
import { cfgStr, jsonFetch, msg, unknownOp } from './util.js';

const api = (token: string, method: string) => `https://api.telegram.org/bot${token}/${method}`;

let pollAbort: AbortController | null = null;

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

/** Long-poll loop: job notifications + approval inline buttons ("chinvat:approve:<id>"). */
async function pollLoop(ctx: AdapterBootContext): Promise<void> {
  const token = String(ctx.config.botToken);
  let offset = 0;
  const signal = pollAbort!.signal;
  ctx.log('telegram approval/notification loop started');
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
        const updates = await tg<any[]>(token, 'getUpdates', { timeout: 0 }, ctx.signal);
        return {
          output: updates.slice(-10).map((u) => ({
            update_id: u.update_id,
            chat_id: u.message?.chat?.id ?? u.callback_query?.message?.chat?.id,
            from: u.message?.from?.username,
            text: u.message?.text,
          })),
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
    pollAbort = new AbortController();
    void pollLoop(ctx);
  },
};

export default adapter;
