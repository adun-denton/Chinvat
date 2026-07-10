import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { z } from 'zod';
import type { Request, Response } from 'express';
import type { Hub } from './hub.js';
import { AdapterError } from './types.js';

const VERSION = '0.1.0';

function ok(data: unknown) {
  return { content: [{ type: 'text' as const, text: JSON.stringify(data, null, 2) }] };
}
function fail(message: string) {
  return { isError: true, content: [{ type: 'text' as const, text: message }] };
}

/** Build a fresh McpServer bound to the shared hub. Cheap; used per stdio process and per HTTP request. */
export function createMcpServer(hub: Hub) {
  const server = new McpServer(
    { name: 'chinvat', version: VERSION },
    {
      instructions:
        'Chinvat is a local labor hub. Discover modules with workers_list, inspect one with ' +
        'capabilities_describe, then delegate with tasks_submit (mode "sync" waits, "async" returns a job_id). ' +
        'Risky operations may pause for human approval; poll tasks_status. Use parent_id to build job trees.',
    }
  );

  server.registerTool(
    'workers_list',
    {
      title: 'List workers',
      description: 'List all worker modules with health, policy tier, and operation names.',
      inputSchema: { include_disabled: z.boolean().optional() },
    },
    async ({ include_disabled }: { include_disabled?: boolean }) => {
      const modules = hub.registry.list().filter((m) => include_disabled || m.enabled);
      const withHealth = await Promise.all(
        modules.map(async (m) => ({
          name: m.name,
          description: m.description,
          enabled: m.enabled,
          tier: m.tier,
          health: await hub.registry.health(m.name),
          operations: m.operations.map((o) => ({ name: o.name, risk: o.risk, description: o.description })),
        }))
      );
      return ok(withHealth);
    }
  );

  server.registerTool(
    'capabilities_describe',
    {
      title: 'Describe a module',
      description: 'Full operation schemas (params + risk) for one module.',
      inputSchema: { module: z.string() },
    },
    async ({ module }: { module: string }) => {
      const info = hub.registry.list().find((m) => m.name === module);
      if (!info) return fail(`unknown module '${module}'. Try workers_list.`);
      return ok({ module: info.name, tier: info.tier, enabled: info.enabled, operations: info.operations });
    }
  );

  server.registerTool(
    'tasks_submit',
    {
      title: 'Submit a task',
      description:
        'Queue a job on a module. mode "sync" waits up to wait_ms for a result; "async" returns a job_id immediately. ' +
        'Operations above the module tier pause as waiting_approval.',
      inputSchema: {
        module: z.string(),
        operation: z.string(),
        args: z.record(z.any()).optional(),
        parent_id: z.string().optional(),
        mode: z.enum(['sync', 'async']).optional(),
        wait_ms: z.number().int().positive().optional(),
      },
    },
    async ({
      module,
      operation,
      args,
      parent_id,
      mode,
      wait_ms,
    }: {
      module: string;
      operation: string;
      args?: Record<string, unknown>;
      parent_id?: string;
      mode?: 'sync' | 'async';
      wait_ms?: number;
    }) => {
      try {
        const job = hub.jobs.submit({
          module,
          operation,
          args: args ?? {},
          parent_id: parent_id ?? null,
          mode: mode ?? 'async',
        });
        if ((mode ?? 'async') === 'async') {
          return ok({ job_id: job.id, status: job.status });
        }
        const cfg = hub.config.get();
        const waited = await hub.jobs.waitFor(
          job.id,
          Math.min(wait_ms ?? cfg.syncWaitMsDefault, cfg.syncWaitMsMax)
        );
        return ok({
          job_id: waited.id,
          status: waited.status,
          result: waited.result,
          error: waited.error,
          note:
            waited.status === 'waiting_approval'
              ? 'Awaiting human approval — approve in the dashboard or Telegram, then poll tasks_status.'
              : waited.status === 'running' || waited.status === 'queued'
                ? 'Still running — poll tasks_status/tasks_result.'
                : undefined,
        });
      } catch (e) {
        return fail(e instanceof Error ? e.message : String(e));
      }
    }
  );

  server.registerTool(
    'tasks_status',
    {
      title: 'Task status',
      description: 'Status, timing, child jobs and recent events for a job.',
      inputSchema: { job_id: z.string() },
    },
    async ({ job_id }: { job_id: string }) => {
      const job = hub.jobs.get(job_id);
      if (!job) return fail(`unknown job '${job_id}'`);
      return ok({
        id: job.id,
        module: job.module,
        operation: job.operation,
        status: job.status,
        error: job.error,
        created_at: job.created_at,
        started_at: job.started_at,
        finished_at: job.finished_at,
        children: hub.jobs.children(job_id).map((c) => ({ id: c.id, operation: c.operation, status: c.status })),
        events: hub.jobs.eventsFor(job_id).slice(-20),
      });
    }
  );

  server.registerTool(
    'tasks_result',
    {
      title: 'Task result',
      description: 'Final result plus artifact list for a completed job.',
      inputSchema: { job_id: z.string() },
    },
    async ({ job_id }: { job_id: string }) => {
      const job = hub.jobs.get(job_id);
      if (!job) return fail(`unknown job '${job_id}'`);
      return ok({
        id: job.id,
        status: job.status,
        result: job.result,
        error: job.error,
        artifacts: hub.artifacts.list(job_id),
      });
    }
  );

  server.registerTool(
    'tasks_cancel',
    {
      title: 'Cancel a task',
      description: 'Cancel a queued/running job, or deny one waiting for approval.',
      inputSchema: { job_id: z.string() },
    },
    async ({ job_id }: { job_id: string }) => {
      try {
        const job = hub.jobs.cancel(job_id, 'mcp');
        return ok({ id: job.id, status: job.status });
      } catch (e) {
        return fail(e instanceof Error ? e.message : String(e));
      }
    }
  );

  server.registerTool(
    'adapter_invoke',
    {
      title: 'Invoke directly',
      description:
        'Synchronous single call, still policy-checked. Convenient for quick read operations; ' +
        'creates a tracked job under the hood.',
      inputSchema: { module: z.string(), operation: z.string(), args: z.record(z.any()).optional() },
    },
    async ({ module, operation, args }: { module: string; operation: string; args?: Record<string, unknown> }) => {
      try {
        const job = hub.jobs.submit({ module, operation, args: args ?? {}, mode: 'sync', source: 'mcp:adapter_invoke' });
        const cfg = hub.config.get();
        const done = await hub.jobs.waitFor(job.id, cfg.syncWaitMsDefault);
        if (done.status === 'succeeded') return ok(done.result);
        if (done.status === 'waiting_approval')
          return fail(`operation requires approval (job ${done.id}); approve it then use tasks_result`);
        return fail(done.error ?? `job ended as ${done.status}`);
      } catch (e) {
        if (e instanceof AdapterError) return fail(e.message);
        return fail(e instanceof Error ? e.message : String(e));
      }
    }
  );

  return server;
}

/** Attach a stdio transport for the spawning client (Claude Desktop/Code, Codex, …). */
export async function serveStdio(hub: Hub): Promise<void> {
  const server = createMcpServer(hub);
  const transport = new StdioServerTransport();
  await server.connect(transport);
  process.stderr.write('[chinvat] MCP stdio transport ready\n');
}

/** Handle one Streamable-HTTP MCP request in stateless mode (no sticky sessions). */
export async function handleStreamableHttp(hub: Hub, req: Request, res: Response): Promise<void> {
  const server = createMcpServer(hub);
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
  res.on('close', () => {
    void transport.close();
    void server.close();
  });
  try {
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  } catch (e) {
    process.stderr.write(`[chinvat] streamable-http error: ${e}\n`);
    if (!res.headersSent) res.status(500).json({ error: 'mcp transport error' });
  }
}
