/** Durable local store for Telegram updates — the only place ingestion/reads touch SQLite. */
import type { DB } from '../db.js';

export interface StoredMessage {
  update_id: number;
  update_type: string;
  chat_id: number | null;
  chat_type: string | null;
  chat_title: string | null;
  chat_username: string | null;
  message_id: number | null;
  message_date: number | null;
  sender_id: number | null;
  sender_username: string | null;
  sender_display_name: string | null;
  text: string | null;
  reply_to_message_id: number | null;
  thread_id: number | null;
  edited: boolean;
  ingested_at: number;
}

export interface ChatRecord {
  chat_id: number;
  type: string | null;
  title: string | null;
  username: string | null;
  first_seen: number;
  last_seen: number;
  migrated_to_chat_id: number | null;
  current_chat_id: number;
}

interface StoredMessageRow extends Omit<StoredMessage, 'edited'> {
  edited: number;
}

const MAX_LIMIT = 100;

function clampLimit(n: unknown, fallback: number): number {
  const v = typeof n === 'number' && Number.isFinite(n) ? Math.floor(n) : fallback;
  return Math.max(1, Math.min(MAX_LIMIT, v));
}

function rowToMessage(r: StoredMessageRow): StoredMessage {
  return { ...r, edited: !!r.edited };
}

function orderOf(order: unknown, fallback: 'ASC' | 'DESC' = 'DESC'): 'ASC' | 'DESC' {
  if (order === 'asc') return 'ASC';
  if (order === 'desc') return 'DESC';
  return fallback;
}

function displayName(from: { first_name?: string; last_name?: string } | undefined): string | null {
  if (!from) return null;
  const name = [from.first_name, from.last_name].filter(Boolean).join(' ').trim();
  return name || null;
}

interface ExtractedFields {
  update_id: number;
  update_type: string;
  chat_id: number | null;
  chat_type: string | null;
  chat_title: string | null;
  chat_username: string | null;
  message_id: number | null;
  message_date: number | null;
  sender_id: number | null;
  sender_username: string | null;
  sender_display_name: string | null;
  text: string | null;
  reply_to_message_id: number | null;
  thread_id: number | null;
  edited: 0 | 1;
  ingested_at: number;
}

/** Pulls the minimal, structured fields out of a raw Telegram update — never persists the raw JSON. */
function extractFields(u: any, now: number): ExtractedFields {
  let update_type = 'unknown';
  let m: any;
  let edited = false;
  if (u.message) {
    update_type = 'message';
    m = u.message;
  } else if (u.edited_message) {
    update_type = 'edited_message';
    m = u.edited_message;
    edited = true;
  } else if (u.channel_post) {
    update_type = 'channel_post';
    m = u.channel_post;
  } else if (u.edited_channel_post) {
    update_type = 'edited_channel_post';
    m = u.edited_channel_post;
    edited = true;
  } else if (u.callback_query) {
    update_type = 'callback_query';
    m = u.callback_query.message;
  }

  const chat = m?.chat;
  const from = u.callback_query?.from ?? m?.from;

  return {
    update_id: u.update_id,
    update_type,
    chat_id: chat?.id ?? null,
    chat_type: chat?.type ?? null,
    chat_title: chat?.title ?? null,
    chat_username: chat?.username ?? null,
    message_id: m?.message_id ?? null,
    message_date: typeof m?.date === 'number' ? m.date * 1000 : null,
    sender_id: from?.id ?? null,
    sender_username: from?.username ?? null,
    sender_display_name: displayName(from),
    text: m?.text ?? m?.caption ?? null,
    reply_to_message_id: m?.reply_to_message?.message_id ?? null,
    thread_id: m?.message_thread_id ?? null,
    edited: edited ? 1 : 0,
    ingested_at: now,
  };
}

export function getOffset(db: DB): number {
  const row = db.prepare(`SELECT next_offset FROM telegram_offset WHERE id = 1`).get() as
    | { next_offset: number }
    | undefined;
  return row?.next_offset ?? 0;
}

/**
 * Upserts every update/chat/migration and advances the offset in one
 * transaction. On failure, SQLite rolls back all three — the prior offset
 * stays intact and Telegram will redeliver on the next poll.
 */
export function persistUpdates(db: DB, rawUpdates: any[], nextOffset: number): number {
  const now = Date.now();

  const insertUpdate = db.prepare(`
    INSERT INTO telegram_updates
      (update_id, update_type, chat_id, chat_type, chat_title, chat_username,
       message_id, message_date, sender_id, sender_username, sender_display_name,
       text, reply_to_message_id, thread_id, edited, ingested_at)
    VALUES
      (@update_id, @update_type, @chat_id, @chat_type, @chat_title, @chat_username,
       @message_id, @message_date, @sender_id, @sender_username, @sender_display_name,
       @text, @reply_to_message_id, @thread_id, @edited, @ingested_at)
    ON CONFLICT(update_id) DO NOTHING
  `);

  const upsertChat = db.prepare(`
    INSERT INTO telegram_chats (chat_id, type, title, username, first_seen, last_seen)
    VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(chat_id) DO UPDATE SET
      type = COALESCE(excluded.type, telegram_chats.type),
      title = COALESCE(excluded.title, telegram_chats.title),
      username = COALESCE(excluded.username, telegram_chats.username),
      last_seen = excluded.last_seen
  `);

  const upsertMigration = db.prepare(`
    INSERT INTO telegram_chat_migrations (old_chat_id, new_chat_id, migrated_at)
    VALUES (?, ?, ?)
    ON CONFLICT(old_chat_id) DO UPDATE SET
      new_chat_id = excluded.new_chat_id,
      migrated_at = excluded.migrated_at
  `);

  const setOffset = db.prepare(`
    INSERT INTO telegram_offset (id, next_offset, updated_at) VALUES (1, ?, ?)
    ON CONFLICT(id) DO UPDATE SET next_offset = excluded.next_offset, updated_at = excluded.updated_at
  `);

  const txn = db.transaction((updates: any[]) => {
    let stored = 0;
    for (const u of updates) {
      const fields = extractFields(u, now);
      const info = insertUpdate.run(fields);
      if (info.changes > 0) stored++;

      if (fields.chat_id != null) {
        upsertChat.run(fields.chat_id, fields.chat_type, fields.chat_title, fields.chat_username, now, now);
      }

      const svc = u.message ?? u.edited_message ?? u.channel_post ?? u.edited_channel_post;
      if (svc?.chat?.id != null) {
        if (svc.migrate_to_chat_id != null) {
          upsertMigration.run(svc.chat.id, svc.migrate_to_chat_id, now);
          upsertChat.run(
            svc.migrate_to_chat_id,
            'supergroup',
            fields.chat_title,
            fields.chat_username,
            now,
            now
          );
        }
        if (svc.migrate_from_chat_id != null) {
          upsertMigration.run(svc.migrate_from_chat_id, svc.chat.id, now);
        }
      }
    }
    const priorOffset = getOffset(db);
    setOffset.run(Math.max(priorOffset, nextOffset), now);
    return stored;
  });

  return txn(rawUpdates);
}

/** Follows the migrate_from -> migrate_to chain to the current chat identity. */
export function resolveChatId(db: DB, requested: number): number {
  let current = requested;
  const seen = new Set<number>();
  const lookup = db.prepare(`SELECT new_chat_id FROM telegram_chat_migrations WHERE old_chat_id = ?`);
  for (let i = 0; i < 10 && !seen.has(current); i++) {
    seen.add(current);
    const row = lookup.get(current) as { new_chat_id: number } | undefined;
    if (!row) break;
    current = row.new_chat_id;
  }
  return current;
}

export interface ListOpts {
  chat_id?: number;
  limit?: number;
  order?: 'asc' | 'desc';
}

export function messagesList(db: DB, opts: ListOpts = {}): StoredMessage[] {
  const limit = clampLimit(opts.limit, 50);
  const order = orderOf(opts.order, 'DESC');
  const where: string[] = [];
  const params: unknown[] = [];
  if (opts.chat_id != null) {
    where.push('chat_id = ?');
    params.push(opts.chat_id);
  }
  const sql = `SELECT * FROM telegram_updates ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY update_id ${order} LIMIT ?`;
  params.push(limit);
  return (db.prepare(sql).all(...params) as StoredMessageRow[]).map(rowToMessage);
}

export interface SinceOpts extends ListOpts {
  since_ts?: number;
  since_update_id?: number;
}

export function messagesSince(db: DB, opts: SinceOpts): StoredMessage[] {
  if (opts.since_ts == null && opts.since_update_id == null) {
    throw new Error('messages_since requires since_ts or since_update_id');
  }
  const limit = clampLimit(opts.limit, 50);
  const order = orderOf(opts.order, 'ASC');
  const where: string[] = [];
  const params: unknown[] = [];
  if (opts.since_update_id != null) {
    where.push('update_id > ?');
    params.push(opts.since_update_id);
  } else {
    where.push('message_date >= ?');
    params.push(opts.since_ts);
  }
  if (opts.chat_id != null) {
    where.push('chat_id = ?');
    params.push(opts.chat_id);
  }
  const sql = `SELECT * FROM telegram_updates WHERE ${where.join(' AND ')} ORDER BY update_id ${order} LIMIT ?`;
  params.push(limit);
  return (db.prepare(sql).all(...params) as StoredMessageRow[]).map(rowToMessage);
}

export interface SearchOpts extends ListOpts {
  query: string;
}

export function messagesSearch(db: DB, opts: SearchOpts): StoredMessage[] {
  const q = (opts.query ?? '').trim();
  if (!q) throw new Error('messages_search requires a non-empty query');
  const escaped = q.replace(/[\\%_]/g, (c) => `\\${c}`);
  const limit = clampLimit(opts.limit, 50);
  const order = orderOf(opts.order, 'DESC');
  const where = [`text LIKE ? ESCAPE '\\'`];
  const params: unknown[] = [`%${escaped}%`];
  if (opts.chat_id != null) {
    where.push('chat_id = ?');
    params.push(opts.chat_id);
  }
  const sql = `SELECT * FROM telegram_updates WHERE ${where.join(' AND ')} ORDER BY update_id ${order} LIMIT ?`;
  params.push(limit);
  return (db.prepare(sql).all(...params) as StoredMessageRow[]).map(rowToMessage);
}

export function chatsList(db: DB, opts: { limit?: number; order?: 'asc' | 'desc' } = {}): ChatRecord[] {
  const limit = clampLimit(opts.limit, 50);
  const order = orderOf(opts.order, 'DESC');
  const sql = `
    SELECT c.*, m.new_chat_id AS migrated_to_chat_id
    FROM telegram_chats c
    LEFT JOIN telegram_chat_migrations m ON m.old_chat_id = c.chat_id
    ORDER BY c.last_seen ${order}
    LIMIT ?
  `;
  const rows = db.prepare(sql).all(limit) as Array<Omit<ChatRecord, 'current_chat_id'>>;
  return rows.map((row) => ({ ...row, current_chat_id: resolveChatId(db, row.chat_id) }));
}

/** Local-store compatibility view backing the get_updates operation. */
export function recentUpdatesView(
  db: DB,
  opts: { limit?: number; chat_id?: number } = {}
): { update_id: number; chat_id: number | null; from: string | null; text: string | null }[] {
  const limit = clampLimit(opts.limit, 10);
  const rows = messagesList(db, { chat_id: opts.chat_id, limit, order: 'desc' });
  return rows.reverse().map((r) => ({
    update_id: r.update_id,
    chat_id: r.chat_id,
    from: r.sender_username,
    text: r.text,
  }));
}
