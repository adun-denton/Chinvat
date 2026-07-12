import { test } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';
import { openDb } from '../db.js';

// Guards against double execution when two hub instances share one WAL database
// (e.g. a client-spawned stdio hub alongside the running dashboard hub).
test('atomic claim: a queued job flips to running exactly once', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'chinvat-claim-'));
  const db = openDb(dir);
  db.prepare(`INSERT INTO jobs (id, module, operation, status, created_at) VALUES (?,?,?,?,?)`).run(
    'j1', 'system', 'system_info', 'queued', Date.now()
  );
  const claim = () =>
    db.prepare(`UPDATE jobs SET status='running', started_at=? WHERE id=? AND status='queued'`).run(Date.now(), 'j1').changes;
  assert.equal(claim(), 1); // first dispatcher wins
  assert.equal(claim(), 0); // any other instance gets nothing
  db.close();
  fs.rmSync(dir, { recursive: true, force: true });
});
