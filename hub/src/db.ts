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
  `);
  return db;
}
