import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { Hub } from '../hub/dist/hub.js';
import { createMcpServer } from '../hub/dist/mcp.js';

if (process.env.OLLAMA_DEBUG) throw new Error('OLLAMA_DEBUG is set; prompts could be logged');
if (process.env.OLLAMA_HOST && !/127\.0\.0\.1|localhost/i.test(process.env.OLLAMA_HOST)) {
  throw new Error(`OLLAMA_HOST is not local: ${process.env.OLLAMA_HOST}`);
}

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'chinvat-ollama-ephemeral-'));
process.env.CHINVAT_DATA_DIR = dir;
const hub = new Hub(dir);
const server = createMcpServer(hub);
const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
const client = new Client({ name: 'ollama-ephemeral-smoke', version: '0.0.0' });

try {
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  const response = await client.callTool({
    name: 'adapter_invoke',
    arguments: {
      module: 'ollama',
      operation: 'chat',
      ephemeral: true,
      args: {
        model: process.env.CHINVAT_OLLAMA_SMOKE_MODEL || 'qwen3.5:9b',
        messages: [
          {
            role: 'user',
            content:
              'Synthetic transport test only. Output ONLY JSON: ' +
              '{"items":[{"id":"SYN-01","category":"identity","confidence":0.99}]}',
          },
        ],
        think: false,
        format: 'json',
        options: { temperature: 0, seed: 7, num_predict: 400 },
      },
    },
  });
  assert.equal(response.isError, undefined, JSON.stringify(response));
  const envelope = JSON.parse(response.content[0].text);
  const content = envelope?.output?.message?.content;
  assert.ok(content, 'Ollama returned empty message content');
  const parsed = JSON.parse(content);
  assert.equal(parsed.items?.[0]?.id, 'SYN-01');
  assert.equal(
    Number(hub.db.prepare('SELECT COUNT(*) AS c FROM jobs').get().c),
    0,
    'ephemeral prompt/result entered jobs table'
  );
  assert.equal(
    Number(hub.db.prepare('SELECT COUNT(*) AS c FROM job_events').get().c),
    0,
    'ephemeral prompt/result entered events table'
  );
  process.stdout.write('OLLAMA EPHEMERAL SMOKE PASSED\n');
} finally {
  await client.close().catch(() => undefined);
  await server.close().catch(() => undefined);
  hub.shutdown();
  fs.rmSync(dir, { recursive: true, force: true });
}
