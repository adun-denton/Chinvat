import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import telegram from '../adapters/telegram.js';
import {
  chatsList,
  getOffset,
  messagesList,
  messagesSearch,
  messagesSince,
  persistUpdates,
  resolveChatId,
} from '../adapters/telegram-store.js';
import { openDb, type DB } from '../db.js';
import type { AdapterContext } from '../types.js';

function fixture(): { dir: string; db: DB; close(): void } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'chinvat-telegram-'));
  const db = openDb(dir);
  return {
    dir,
    db,
    close() {
      if (db.open) db.close();
      fs.rmSync(dir, { recursive: true, force: true });
    },
  };
}

function ctx(db: DB, config: Record<string, unknown> = {}): AdapterContext {
  return {
    config,
    dataDir: '',
    db,
    saveArtifact: async () => 'unused',
    log: () => undefined,
  };
}

const message = {
  update_id: 100,
  message: {
    message_id: 10,
    date: 1_700_000_000,
    chat: { id: -200, type: 'group', title: 'Synthetic Group' },
    from: { id: 7, username: 'tester', first_name: 'Test', last_name: 'User' },
    text: 'durable hello',
  },
};

test('Telegram ingestion is transactional, idempotent, and resumes its persisted offset', () => {
  const f = fixture();
  try {
    const migration = {
      update_id: 101,
      message: {
        message_id: 11,
        date: 1_700_000_001,
        chat: { id: -200, type: 'group', title: 'Synthetic Group' },
        migrate_to_chat_id: -300,
      },
    };
    assert.equal(persistUpdates(f.db, [message, migration], 102), 2);
    assert.equal(getOffset(f.db), 102);
    assert.equal(persistUpdates(f.db, [message], 101), 0);
    assert.equal(getOffset(f.db), 102, 'offset must never regress');
    assert.equal(messagesList(f.db).length, 2);
    assert.equal(resolveChatId(f.db, -200), -300);
    const oldChat = chatsList(f.db, { limit: 10 }).find((chat) => chat.chat_id === -200);
    assert.equal(oldChat?.migrated_to_chat_id, -300);
    assert.equal(oldChat?.current_chat_id, -300);

    f.db.exec(`
      CREATE TRIGGER telegram_test_fail_offset
      BEFORE UPDATE ON telegram_offset
      WHEN NEW.next_offset = 103
      BEGIN
        SELECT RAISE(ABORT, 'forced offset failure');
      END;
    `);
    assert.throws(
      () => persistUpdates(f.db, [{ ...message, update_id: 102 }], 103),
      /forced offset failure/
    );
    assert.equal(messagesList(f.db).some((row) => row.update_id === 102), false, 'failed batch must roll back');
    assert.equal(getOffset(f.db), 102);

    f.db.close();
    const reopened = openDb(f.dir);
    try {
      assert.equal(getOffset(reopened), 102, 'offset must survive a database reopen');
    } finally {
      reopened.close();
    }
  } finally {
    f.close();
  }
});

test('Telegram local history supports list, since, search, and bounded chat views', () => {
  const f = fixture();
  try {
    persistUpdates(f.db, [message, {
      update_id: 101,
      edited_message: {
        message_id: 12,
        date: 1_700_000_002,
        chat: { id: -201, type: 'supergroup', title: 'Other Group' },
        from: { id: 8, first_name: 'Other' },
        caption: 'needle caption',
        message_thread_id: 4,
        reply_to_message: { message_id: 9 },
      },
    }], 102);
    assert.deepEqual(messagesList(f.db, { chat_id: -200 }).map((row) => row.update_id), [100]);
    assert.deepEqual(messagesSince(f.db, { since_update_id: 100 }).map((row) => row.update_id), [101]);
    const found = messagesSearch(f.db, { query: 'needle' });
    assert.equal(found.length, 1);
    assert.equal(found[0].edited, true);
    assert.equal(found[0].thread_id, 4);
    assert.equal(found[0].reply_to_message_id, 9);
    assert.equal(chatsList(f.db, { limit: 1 }).length, 1);
    assert.throws(() => messagesSearch(f.db, { query: '   ' }), /non-empty query/);
    assert.throws(() => messagesSince(f.db, {}), /requires since_ts or since_update_id/);
  } finally {
    f.close();
  }
});

test('get_updates reads SQLite only and does not require a bot token', async () => {
  const f = fixture();
  const originalFetch = globalThis.fetch;
  let fetchCalls = 0;
  globalThis.fetch = async () => {
    fetchCalls += 1;
    throw new Error('network must not be called');
  };
  try {
    persistUpdates(f.db, [message], 101);
    const result = await telegram.invoke('get_updates', {}, ctx(f.db));
    assert.equal(fetchCalls, 0);
    assert.deepEqual(result.output, [{ update_id: 100, chat_id: -200, from: 'tester', text: 'durable hello' }]);
    await assert.rejects(
      () => telegram.invoke('messages_list', { chat_id: 'not-a-chat' }, ctx(f.db)),
      /chat_id filter must be a numeric Telegram chat ID/
    );
  } finally {
    globalThis.fetch = originalFetch;
    f.close();
  }
});

test('Telegram send rejects invite links and resolves migrated numeric chat IDs', async () => {
  const f = fixture();
  const originalFetch = globalThis.fetch;
  const bodies: any[] = [];
  globalThis.fetch = async (_url, init) => {
    bodies.push(JSON.parse(String(init?.body)));
    return new Response(JSON.stringify({ ok: true, result: { message_id: 77 } }), { status: 200 });
  };
  try {
    await assert.rejects(
      () => telegram.invoke('send_message', { chat_id: 'https://t.me/+private', text: 'x' }, ctx(f.db, { botToken: 'test' })),
      /must not be an invite link/
    );
    assert.equal(bodies.length, 0);

    persistUpdates(f.db, [{
      update_id: 1,
      message: {
        message_id: 1,
        date: 1,
        chat: { id: -200, type: 'group', title: 'Old' },
        migrate_to_chat_id: -300,
      },
    }], 2);
    const result = await telegram.invoke('send_message', { chat_id: '-200', text: 'hello' }, ctx(f.db, { botToken: 'test' }));
    assert.equal(bodies[0].chat_id, '-300');
    assert.deepEqual(result.output, {
      message_id: 77,
      chat_id: '-300',
      requested_chat_id: '-200',
      resolved_chat_id: '-300',
    });
  } finally {
    globalThis.fetch = originalFetch;
    f.close();
  }
});
