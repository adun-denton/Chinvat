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
  const workers = parseTool(await client.callTool({ name: 'workers_list', arguments: { include_disabled: true } }));
  check('14 modules discoverable', Array.isArray(workers) && workers.length === 14);
  const sys = workers.find((w: any) => w.name === 'system');
  check('system module defaults to approve tier', sys?.tier === 'approve');

  // 3. capabilities
  const caps = parseTool(await client.callTool({ name: 'capabilities_describe', arguments: { module: 'system' } }));
  check('system exposes run_command as dangerous', caps.operations.some((o: any) => o.name === 'run_command' && o.risk === 'dangerous'));

  // 4. read op runs even under approve tier (policy: read always allowed) — sync
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
