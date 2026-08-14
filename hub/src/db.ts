import Database from 'better-sqlite3';
import path from 'node:path';

export type DB = Database.Database;

export function openDb(dataDir: string): DB {
  const db = new Database(path.join(dataDir, 'chinvat.db'));
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.exec(`
    CREATE TABLE IF NOT EXISTS jobs (
      id TEXT PRIMARY KEY,
      parent_id TEXT,
      module TEXT NOT NULL,
      operation TEXT NOT NULL,
      args_json TEXT NOT NULL DEFAULT '{}',
      status TEXT NOT NULL,
      mode TEXT NOT NULL DEFAULT 'async',
      result_json TEXT,
      error TEXT,
      created_at INTEGER NOT NULL,
      started_at INTEGER,
      finished_at INTEGER,
      source TEXT NOT NULL DEFAULT 'mcp'
    );
    CREATE INDEX IF NOT EXISTS idx_jobs_status ON jobs(status);
    CREATE INDEX IF NOT EXISTS idx_jobs_parent ON jobs(parent_id);
    CREATE INDEX IF NOT EXISTS idx_jobs_created ON jobs(created_at DESC);

    CREATE TABLE IF NOT EXISTS job_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      job_id TEXT NOT NULL,
      ts INTEGER NOT NULL,
      kind TEXT NOT NULL,
      data_json TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_events_job ON job_events(job_id);

    CREATE TABLE IF NOT EXISTS approvals (
      id TEXT PRIMARY KEY,
      job_id TEXT NOT NULL,
      requested_at INTEGER NOT NULL,
      decided_at INTEGER,
      decision TEXT,
      decided_via TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_approvals_open ON approvals(decision) WHERE decision IS NULL;

    CREATE TABLE IF NOT EXISTS telegram_updates (
      update_id INTEGER PRIMARY KEY,
      update_type TEXT NOT NULL,
      chat_id INTEGER,
      chat_type TEXT,
      chat_title TEXT,
      chat_username TEXT,
      message_id INTEGER,
      message_date INTEGER,
      sender_id INTEGER,
      sender_username TEXT,
      sender_display_name TEXT,
      text TEXT,
      reply_to_message_id INTEGER,
      thread_id INTEGER,
      edited INTEGER NOT NULL DEFAULT 0,
      ingested_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_telegram_updates_chat ON telegram_updates(chat_id, message_date);
    CREATE INDEX IF NOT EXISTS idx_telegram_updates_date ON telegram_updates(message_date);

    CREATE TABLE IF NOT EXISTS telegram_chats (
      chat_id INTEGER PRIMARY KEY,
      type TEXT,
      title TEXT,
      username TEXT,
      first_seen INTEGER NOT NULL,
      last_seen INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS telegram_chat_migrations (
      old_chat_id INTEGER PRIMARY KEY,
      new_chat_id INTEGER NOT NULL,
      migrated_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS telegram_offset (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      next_offset INTEGER NOT NULL DEFAULT 0,
      updated_at INTEGER
    );
  `);
  return db;
}
