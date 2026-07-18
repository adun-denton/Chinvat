import crypto from 'node:crypto';
import type { DB } from './db.js';
import type { EventBus } from './events.js';
import type { Registry } from './registry.js';
import type { ConfigStore } from './config.js';
import { decide } from './policy.js';
import type { ApprovalInfo, InvokeResult, Job, JobMode, JobStatus } from './types.js';

export interface SubmitParams {
  module: string;
  operation: string;
  args?: Record<string, unknown>;
  parent_id?: string | null;
  mode?: JobMode;
  source?: string;
}

const TERMINAL: JobStatus[] = ['succeeded', 'failed', 'cancelled'];

interface JobRow {
  id: string;
  parent_id: string | null;
  module: string;
  operation: string;
  args_json: string;
  status: JobStatus;
  mode: JobMode;
  result_json: string | null;
  error: string | null;
  created_at: number;
  started_at: number | null;
  finished_at: number | null;
  source: string;
}

function rowToJob(r: JobRow): Job {
  return {
    ...r,
    args: JSON.parse(r.args_json || '{}'),
    result: r.result_json ? JSON.parse(r.result_json) : null,
  };
}

export class JobEngine {
  private running = new Map<string, number>(); // module -> active count
  private controllers = new Map<string, AbortController>();
  private waiters = new Map<string, Set<() => void>>();
  private dispatchScheduled = false;
  private stopped = false;
  private readonly timer: ReturnType<typeof setInterval>;

  constructor(
    private readonly db: DB,
    private readonly bus: EventBus,
    private readonly registry: Registry,
    private readonly config: ConfigStore
  ) {
    this.recover();
    this.timer = setInterval(() => this.dispatch(), 1000);
    this.timer.unref();
  }

  /**
   * Execute a read-only operation without writing arguments, results, events, logs,
   * or artifacts to Chinvat storage. Ephemeral calls are synchronous and cannot be
   * approved or recovered after restart by design.
   */
  async invokeEphemeral(
    module: string,
    operation: string,
    args: Record<string, unknown>
  ): Promise<InvokeResult> {
    const adapter = this.registry.get(module);
    if (!adapter) throw new Error(`unknown module '${module}'`);
    if (!this.registry.isEnabled(module)) throw new Error(`module '${module}' is disabled`);
    const allowlist = this.config.get().ephemeralModules;
    if (!allowlist.includes(module)) {
      throw new Error(
        `ephemeral invocation is not enabled for module '${module}' — add it to ephemeralModules in chinvat.config.json (current: ${JSON.stringify(allowlist)})`
      );
    }
    const op = this.registry.operation(module, operation);
    if (!op)
      throw new Error(
        `unknown operation '${operation}' on '${module}' (use capabilities_describe)`
      );
    if (op.risk !== 'read') {
      throw new Error('ephemeral invocation is limited to read-risk operations');
    }
    const tier = this.config.module(module).tier;
    if (decide(op.risk, tier) !== 'run') {
      throw new Error(`policy_rejected: tier '${tier}' does not allow '${op.risk}' operations`);
    }

    const baseCtx = this.registry.makeCtx(module);
    return adapter.invoke(operation, args, {
      ...baseCtx,
      jobId: undefined,
      log: () => undefined,
      saveArtifact: async () => {
        throw new Error('artifact persistence is disabled for ephemeral invocation');
      },
    });
  }

  /** Stop dispatching (call before closing the DB). Running jobs are abandoned to recovery on next boot. */
  stop(): void {
    this.stopped = true;
    clearInterval(this.timer);
    for (const c of this.controllers.values()) c.abort();
  }

  /** Boot recovery: interrupted running jobs fail; queued jobs re-dispatch naturally. */
  private recover(): void {
    const n = this.db
      .prepare(
        `UPDATE jobs SET status='failed', error='interrupted by hub restart', finished_at=? WHERE status='running'`
      )
      .run(Date.now()).changes;
    if (n > 0) process.stderr.write(`[chinvat] recovered ${n} interrupted job(s)\n`);
  }

  submit(p: SubmitParams): Job {
    const adapter = this.registry.get(p.module);
    if (!adapter) throw new Error(`unknown module '${p.module}'`);
    if (!this.registry.isEnabled(p.module)) throw new Error(`module '${p.module}' is disabled`);
    const op = this.registry.operation(p.module, p.operation);
    if (!op)
      throw new Error(
        `unknown operation '${p.operation}' on '${p.module}' (use capabilities_describe)`
      );
    if (p.parent_id && !this.get(p.parent_id)) throw new Error(`unknown parent_id '${p.parent_id}'`);

    const tier = this.config.module(p.module).tier;
    const decision = decide(op.risk, tier);
    const id = crypto.randomUUID();
    const now = Date.now();
    const status: JobStatus =
      decision === 'run' ? 'queued' : decision === 'approval' ? 'waiting_approval' : 'failed';

    this.db
      .prepare(
        `INSERT INTO jobs (id, parent_id, module, operation, args_json, status, mode, error, created_at, source)
         VALUES (?,?,?,?,?,?,?,?,?,?)`
      )
      .run(
        id,
        p.parent_id ?? null,
        p.module,
        p.operation,
        JSON.stringify(p.args ?? {}),
        status,
        p.mode ?? 'async',
        decision === 'reject'
          ? `policy_rejected: tier '${tier}' does not allow '${op.risk}' operations`
          : null,
        now,
        p.source ?? 'mcp'
      );
    if (decision === 'reject') {
      this.db.prepare(`UPDATE jobs SET finished_at=? WHERE id=?`).run(now, id);
    }

    this.event(id, 'created', { decision, risk: op.risk, tier });
    const job = this.get(id)!;
    this.bus.emit({ type: 'job.created', job });

    if (decision === 'approval') {
      const approvalId = crypto.randomUUID();
      this.db
        .prepare(`INSERT INTO approvals (id, job_id, requested_at) VALUES (?,?,?)`)
        .run(approvalId, id, now);
      this.bus.emit({ type: 'approval.requested', approval: this.approvalInfo(approvalId)! });
    } else if (decision === 'run') {
      this.kick();
    } else {
      this.bus.emit({ type: 'job.status', job });
      this.release(id);
    }
    return job;
  }

  get(id: string): Job | undefined {
    const r = this.db.prepare(`SELECT * FROM jobs WHERE id=?`).get(id) as JobRow | undefined;
    return r ? rowToJob(r) : undefined;
  }

  list(opts: { status?: string; module?: string; limit?: number; offset?: number } = {}): Job[] {
    const where: string[] = [];
    const params: unknown[] = [];
    if (opts.status) {
      where.push('status=?');
      params.push(opts.status);
    }
    if (opts.module) {
      where.push('module=?');
      params.push(opts.module);
    }
    const sql = `SELECT * FROM jobs ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
                 ORDER BY created_at DESC LIMIT ? OFFSET ?`;
    params.push(Math.min(opts.limit ?? 100, 500), opts.offset ?? 0);
    return (this.db.prepare(sql).all(...params) as JobRow[]).map(rowToJob);
  }

  children(id: string): Job[] {
    return (
      this.db.prepare(`SELECT * FROM jobs WHERE parent_id=? ORDER BY created_at`).all(id) as JobRow[]
    ).map(rowToJob);
  }

  eventsFor(id: string): { ts: number; kind: string; data: unknown }[] {
    return (
      this.db
        .prepare(`SELECT ts, kind, data_json FROM job_events WHERE job_id=? ORDER BY id`)
        .all(id) as { ts: number; kind: string; data_json: string | null }[]
    ).map((r) => ({ ts: r.ts, kind: r.kind, data: r.data_json ? JSON.parse(r.data_json) : null }));
  }

  counts(): Record<string, number> {
    const rows = this.db
      .prepare(`SELECT status, COUNT(*) c FROM jobs GROUP BY status`)
      .all() as { status: string; c: number }[];
    return Object.fromEntries(rows.map((r) => [r.status, r.c]));
  }

  event(jobId: string, kind: string, data?: unknown): void {
    this.db
      .prepare(`INSERT INTO job_events (job_id, ts, kind, data_json) VALUES (?,?,?,?)`)
      .run(jobId, Date.now(), kind, data === undefined ? null : JSON.stringify(data));
  }

  log(jobId: string | undefined, module: string, message: string): void {
    if (jobId) {
      this.event(jobId, 'log', { message });
      this.bus.emit({ type: 'job.log', job_id: jobId, module, message });
    } else {
      process.stderr.write(`[${module}] ${message}\n`);
    }
  }

  cancel(id: string, via = 'api'): Job {
    const job = this.get(id);
    if (!job) throw new Error(`unknown job '${id}'`);
    if (TERMINAL.includes(job.status)) return job;

    if (job.status === 'waiting_approval') {
      const open = this.db
        .prepare(`SELECT id FROM approvals WHERE job_id=? AND decision IS NULL`)
        .get(id) as { id: string } | undefined;
      if (open) return this.resolveApprovalInternal(open.id, 'denied', via) ?? this.get(id)!;
    }
    if (job.status === 'queued') {
      this.finish(id, 'cancelled', null, `cancelled via ${via}`);
      return this.get(id)!;
    }
    // running
    this.controllers.get(id)?.abort();
    const adapter = this.registry.get(job.module);
    adapter?.cancel?.(id).catch(() => undefined);
    this.event(id, 'cancel_requested', { via });
    return this.get(id)!;
  }

  waitFor(id: string, timeoutMs: number): Promise<Job> {
    const job = this.get(id);
    if (!job) return Promise.reject(new Error(`unknown job '${id}'`));
    if (TERMINAL.includes(job.status)) return Promise.resolve(job);
    return new Promise((resolve) => {
      let settled = false;
      const done = (): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        set.delete(done);
        resolve(this.get(id)!);
      };
      const timer = setTimeout(done, timeoutMs);
      const set = this.waiters.get(id) ?? new Set<() => void>();
      this.waiters.set(id, set);
      set.add(done);
    });
  }

  private release(id: string): void {
    const set = this.waiters.get(id);
    if (!set) return;
    this.waiters.delete(id);
    for (const cb of [...set]) cb();
  }

  // approvals

  approvalInfo(approvalId: string): ApprovalInfo | undefined {
    const r = this.db
      .prepare(
        `SELECT a.id, a.job_id, a.requested_at, j.module, j.operation, j.args_json
         FROM approvals a JOIN jobs j ON j.id = a.job_id WHERE a.id=?`
      )
      .get(approvalId) as
      | { id: string; job_id: string; requested_at: number; module: string; operation: string; args_json: string }
      | undefined;
    if (!r) return undefined;
    return { ...r, args: JSON.parse(r.args_json || '{}') };
  }

  listPendingApprovals(): ApprovalInfo[] {
    const rows = this.db
      .prepare(
        `SELECT a.id FROM approvals a JOIN jobs j ON j.id=a.job_id
         WHERE a.decision IS NULL AND j.status='waiting_approval' ORDER BY a.requested_at`
      )
      .all() as { id: string }[];
    return rows.map((r) => this.approvalInfo(r.id)!).filter(Boolean);
  }

  resolveApproval(id: string, decision: 'approved' | 'denied', via: string): boolean {
    return this.resolveApprovalInternal(id, decision, via) !== undefined;
  }

  private resolveApprovalInternal(
    id: string,
    decision: 'approved' | 'denied',
    via: string
  ): Job | undefined {
    const info = this.approvalInfo(id);
    if (!info) return undefined;
    const changed = this.db
      .prepare(`UPDATE approvals SET decision=?, decided_at=?, decided_via=? WHERE id=? AND decision IS NULL`)
      .run(decision, Date.now(), via, id).changes;
    if (!changed) return undefined; // already decided
    this.event(info.job_id, 'approval', { decision, via });
    this.bus.emit({ type: 'approval.resolved', approval_id: id, job_id: info.job_id, decision, via });
    if (decision === 'approved') {
      this.db.prepare(`UPDATE jobs SET status='queued' WHERE id=? AND status='waiting_approval'`).run(info.job_id);
      const job = this.get(info.job_id)!;
      this.bus.emit({ type: 'job.status', job });
      this.kick();
      return job;
    }
    this.finish(info.job_id, 'cancelled', null, `denied via ${via}`);
    return this.get(info.job_id);
  }

  // dispatch

  kick(): void {
    if (this.dispatchScheduled || this.stopped) return;
    this.dispatchScheduled = true;
    setImmediate(() => {
      this.dispatchScheduled = false;
      this.dispatch();
    });
  }

  private dispatch(): void {
    if (this.stopped || !this.db.open) return;
    const limit = this.config.get().concurrencyPerModule;
    const queued = this.db
      .prepare(`SELECT * FROM jobs WHERE status='queued' ORDER BY created_at LIMIT 100`)
      .all() as JobRow[];
    for (const row of queued) {
      const active = this.running.get(row.module) ?? 0;
      if (active >= limit) continue;
      // Atomic claim: only the instance whose UPDATE actually flips 'queued'->'running'
      // runs the job. Safe when several hubs share one WAL database (e.g. a client-spawned
      // stdio hub alongside the dashboard hub) — a job is executed exactly once.
      const claimed = this.db
        .prepare(`UPDATE jobs SET status='running', started_at=? WHERE id=? AND status='queued'`)
        .run(Date.now(), row.id).changes;
      if (claimed !== 1) continue;
      this.running.set(row.module, active + 1);
      const job = this.get(row.id)!;
      this.bus.emit({ type: 'job.status', job });
      void this.runJob(job).finally(() => {
        this.running.set(row.module, (this.running.get(row.module) ?? 1) - 1);
        this.kick();
      });
    }
  }

  private async runJob(job: Job): Promise<void> {
    const adapter = this.registry.get(job.module)!;
    const controller = new AbortController();
    this.controllers.set(job.id, controller);
    try {
      const ctx = this.registry.makeCtx(job.module, job.id, controller.signal);
      const result = await adapter.invoke(job.operation, job.args, ctx);
      if (controller.signal.aborted) {
        this.finish(job.id, 'cancelled', null, 'cancelled while running');
      } else {
        this.finish(job.id, 'succeeded', result ?? {}, null);
      }
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      this.finish(
        job.id,
        controller.signal.aborted ? 'cancelled' : 'failed',
        null,
        controller.signal.aborted ? 'cancelled while running' : message
      );
    } finally {
      this.controllers.delete(job.id);
    }
  }

  private finish(id: string, status: JobStatus, result: unknown, error: string | null): void {
    if (!this.db.open) return;
    this.db
      .prepare(`UPDATE jobs SET status=?, result_json=?, error=?, finished_at=? WHERE id=?`)
      .run(status, result === null ? null : JSON.stringify(result), error, Date.now(), id);
    this.event(id, status, error ? { error } : undefined);
    const job = this.get(id)!;
    this.bus.emit({ type: 'job.status', job });
    this.release(id);
  }
}
