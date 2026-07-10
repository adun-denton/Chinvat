/** Chinvat core types — the adapter contract everything else depends on. */

export type Risk = 'read' | 'act' | 'dangerous';
export type Tier = 'observe' | 'approve' | 'autonomous';
export type JobStatus =
  | 'waiting_approval'
  | 'queued'
  | 'running'
  | 'succeeded'
  | 'failed'
  | 'cancelled';
export type JobMode = 'sync' | 'async';

/** Drives the dashboard's per-module config form. */
export interface FieldSpec {
  key: string;
  label: string;
  type: 'string' | 'secret' | 'number' | 'boolean';
  required?: boolean;
  placeholder?: string;
  help?: string;
  default?: string | number | boolean;
}

export interface ParamSpec {
  type: 'string' | 'number' | 'boolean' | 'object' | 'array';
  description?: string;
  required?: boolean;
}

/**
 * Map of parameter name to spec. The "| undefined" value type is a TypeScript
 * ergonomic: it lets adapters declare capabilities() as one heterogeneous
 * array literal without the compiler synthesizing phantom undefined members
 * across the union. Real specs are always defined.
 */
export type ParamMap = Record<string, ParamSpec | undefined>;

export interface OperationSpec {
  name: string;
  description: string;
  risk: Risk;
  params: ParamMap;
}

export interface HealthStatus {
  ok: boolean;
  detail?: string;
}

export interface InvokeResult {
  output?: unknown;
  /** Relative paths of artifacts saved via ctx.saveArtifact. */
  artifacts?: string[];
}

export interface AdapterContext {
  /** Module config values (from data/chinvat.config.json). */
  config: Record<string, unknown>;
  dataDir: string;
  jobId?: string;
  /** Persist a large output; returns the artifact's relative path. */
  saveArtifact(name: string, content: string | Buffer): Promise<string>;
  log(message: string): void;
  /** Aborted when the job is cancelled or the hub shuts down. */
  signal?: AbortSignal;
}

export interface ApprovalInfo {
  id: string;
  job_id: string;
  module: string;
  operation: string;
  args: Record<string, unknown>;
  requested_at: number;
}

export interface HubEvent {
  type:
    | 'job.created'
    | 'job.status'
    | 'job.log'
    | 'approval.requested'
    | 'approval.resolved'
    | 'module.config';
  [key: string]: unknown;
}

/** Narrow view of the hub handed to adapters at boot (e.g. Telegram approval buttons). */
export interface HubFacade {
  listPendingApprovals(): ApprovalInfo[];
  resolveApproval(id: string, decision: 'approved' | 'denied', via: string): boolean;
  onEvent(cb: (evt: HubEvent) => void): () => void;
}

export interface AdapterBootContext extends AdapterContext {
  hub: HubFacade;
}

export interface ChinvatAdapter {
  name: string;
  version: string;
  description: string;
  configSchema: FieldSpec[];
  capabilities(): OperationSpec[];
  health(ctx: AdapterContext): Promise<HealthStatus>;
  invoke(
    operation: string,
    args: Record<string, unknown>,
    ctx: AdapterContext
  ): Promise<InvokeResult>;
  cancel?(jobId: string): Promise<void>;
  /** Long-lived side work (polling loops, subscriptions). */
  onBoot?(ctx: AdapterBootContext): void | Promise<void>;
}

export interface Job {
  id: string;
  parent_id: string | null;
  module: string;
  operation: string;
  args: Record<string, unknown>;
  status: JobStatus;
  mode: JobMode;
  result: unknown;
  error: string | null;
  created_at: number;
  started_at: number | null;
  finished_at: number | null;
  source: string;
}

export class AdapterError extends Error {
  constructor(message: string, public readonly retriable = false) {
    super(message);
    this.name = 'AdapterError';
  }
}
