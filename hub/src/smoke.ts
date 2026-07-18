/**
 * Self-test: boots a hub on a temp data dir, connects a real MCP client over
 * an in-memory stdio pair, and exercises discovery + a policy-gated job.
 * Run with `npm run smoke` (after build) or `tsx src/smoke.ts`.
 */
import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { Hub } from './hub.js';
import { createMcpServer } from './mcp.js';

function parseTool(res: any): any {
  const text = res?.content?.[0]?.text ?? '{}';
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

async function main(): Promise<void> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'chinvat-smoke-'));
  process.env.CHINVAT_DATA_DIR = dir;
  const hub = new Hub(dir);
  // no hub.start(): we don't want telegram polling etc. in the smoke test

  const server = createMcpServer(hub);
  const [clientT, serverT] = InMemoryTransport.createLinkedPair();
  await server.connect(serverT);
  const client = new Client({ name: 'smoke', version: '0.0.0' });
  await client.connect(clientT);

  let pass = 0;
  const check = (label: string, cond: boolean) => {
    assert.ok(cond, `FAIL: ${label}`);
    pass++;
    process.stdout.write(`  ✓ ${label}\n`);
  };

  // 1. tools present
  const tools = await client.listTools();
  const names = tools.tools.map((t: { name: string }) => t.name).sort();
  check('7 MCP tools registered', names.length === 7);
  check(
    'expected tool names',
    ['adapter_invoke', 'capabilities_describe', 'tasks_cancel', 'tasks_result', 'tasks_status', 'tasks_submit', 'workers_list'].every(
      (n) => names.includes(n)
    )
  );

  // 2. discovery
  const workersRes = parseTool(await client.callTool({ name: 'workers_list', arguments: { include_disabled: true } }));
  const workers = Array.isArray(workersRes) ? workersRes : (workersRes?.workers ?? []);
  check('16 modules discoverable', Array.isArray(workers) && workers.length === 16);
  check('workers_list carries hub build stamp', typeof workersRes?.hub?.pid === 'number' && !!workersRes?.hub?.started_at);
  const sys = workers.find((w: any) => w.name === 'system');
  check('system module defaults to approve tier', sys?.tier === 'approve');
  const coolify = workers.find((w: any) => w.name === 'coolify');
  check('coolify module defaults to disabled + approve', coolify?.enabled === false && coolify?.tier === 'approve');

  // 3. capabilities
  const caps = parseTool(await client.callTool({ name: 'capabilities_describe', arguments: { module: 'system' } }));
  check('system exposes run_command as dangerous', caps.operations.some((o: any) => o.name === 'run_command' && o.risk === 'dangerous'));

  // 4. ephemeral read calls bypass all persistent job/event/artifact storage
  check(
    'ephemeral allowlist defaults to ollama only',
    JSON.stringify(hub.config.get().ephemeralModules) === JSON.stringify(['ollama'])
  );
  const deniedEphemeral = await client.callTool({
    name: 'adapter_invoke',
    arguments: { module: 'system', operation: 'system_info', ephemeral: true },
  });
  check('ephemeral outside allowlist fails closed', deniedEphemeral.isError === true);
  hub.config.get().ephemeralModules = ['system']; // widen for the persistence checks below
  const beforeJobs = Number((hub.db.prepare('SELECT COUNT(*) AS c FROM jobs').get() as { c: number }).c);
  const beforeEvents = Number((hub.db.prepare('SELECT COUNT(*) AS c FROM job_events').get() as { c: number }).c);
  const ephemeral = parseTool(
    await client.callTool({
      name: 'adapter_invoke',
      arguments: { module: 'system', operation: 'system_info', ephemeral: true },
    })
  );
  check('ephemeral read op succeeds', !!ephemeral.output);
  check(
    'ephemeral call writes no jobs',
    Number((hub.db.prepare('SELECT COUNT(*) AS c FROM jobs').get() as { c: number }).c) === beforeJobs
  );
  check(
    'ephemeral call writes no events',
    Number((hub.db.prepare('SELECT COUNT(*) AS c FROM job_events').get() as { c: number }).c) === beforeEvents
  );
  const blockedEphemeral = await client.callTool({
    name: 'adapter_invoke',
    arguments: { module: 'system', operation: 'run_command', args: { command: 'echo no' }, ephemeral: true },
  });
  check('ephemeral act/dangerous op fails closed', blockedEphemeral.isError === true);

  // 5. read op runs even under approve tier (policy: read always allowed) — sync
  const info = parseTool(
    await client.callTool({ name: 'tasks_submit', arguments: { module: 'system', operation: 'system_info', mode: 'sync' } })
  );
  check('read op (system_info) succeeded synchronously', info.status === 'succeeded' && !!info.result);

  // 5. dangerous op under approve tier pauses for approval
  const gated = parseTool(
    await client.callTool({
      name: 'tasks_submit',
      arguments: { module: 'system', operation: 'run_command', args: { command: 'echo hi' }, mode: 'sync', wait_ms: 800 },
    })
  );
  check('dangerous op under approve tier -> waiting_approval', gated.status === 'waiting_approval');

  // 6. approve it, then it runs to completion
  const pending = hub.jobs.listPendingApprovals();
  check('approval is queued', pending.length === 1 && pending[0].job_id === gated.job_id);
  hub.jobs.resolveApproval(pending[0].id, 'approved', 'smoke');
  const done = await hub.jobs.waitFor(gated.job_id, 8000);
  check('approved job ran and succeeded', done.status === 'succeeded');
  check('command output captured', JSON.stringify(done.result).includes('hi'));

  // 7. observe tier rejects act/dangerous
  hub.config.updateModule('system', { tier: 'observe' });
  const rejected = parseTool(
    await client.callTool({
      name: 'tasks_submit',
      arguments: { module: 'system', operation: 'run_command', args: { command: 'echo no' }, mode: 'sync', wait_ms: 500 },
    })
  );
  check('observe tier rejects dangerous op', rejected.status === 'failed' && String(rejected.error).includes('policy_rejected'));

  // 8. child jobs / lineage
  const parent = parseTool(await client.callTool({ name: 'tasks_submit', arguments: { module: 'system', operation: 'system_info', mode: 'async' } }));
  const child = parseTool(
    await client.callTool({ name: 'tasks_submit', arguments: { module: 'system', operation: 'system_info', parent_id: parent.job_id, mode: 'async' } })
  );
  const status = parseTool(await client.callTool({ name: 'tasks_status', arguments: { job_id: parent.job_id } }));
  check('parent reports its child', status.children.some((c: any) => c.id === child.job_id));

  // 9. persistence + restart recovery
  hub.shutdown();
  const hub2 = new Hub(dir);
  const recovered = hub2.jobs.get(gated.job_id);
  check('jobs persist across restart', recovered?.status === 'succeeded');
  hub2.shutdown();

  await client.close();
  process.stdout.write(`\nSMOKE PASSED — ${pass} checks\n`);
  fs.rmSync(dir, { recursive: true, force: true });
}

main().catch((e) => {
  process.stderr.write(`\nSMOKE FAILED: ${e?.stack ?? e}\n`);
  process.exit(1);
});
