# Architecture

## Process model

One Node process (`hub/dist/index.js`). Flags: `--stdio` (attach MCP stdio transport for the spawning client), `--port <n>` (default 7777), `--no-http`. The HTTP side serves: dashboard (static), REST `/api`, WebSocket `/ws`, MCP Streamable HTTP `/mcp`. All transports share one `Hub` singleton.

## Components

```
index.ts ─ boot: config → db → registry → jobs → policy → api/mcp
config.ts     load/merge/save data/chinvat.config.json + env overrides
db.ts         better-sqlite3 bootstrap + migrations (idempotent DDL)
types.ts      ChinvatAdapter contract, Job, OperationSpec, risk/tier enums
registry.ts   instantiate built-ins + load modules/*/ ; health cache
policy.ts     decide(op.risk, module.tier) → run | approval | reject
jobs.ts       queue, dispatch (per-module concurrency), lifecycle, recovery
events.ts     tiny typed pub/sub → WS broadcast + adapter hooks
artifacts.ts  save/list/read under data/artifacts/<jobId>/
mcp.ts        McpServer with 7 tools; stdio + streamable-HTTP bindings
api.ts        Express REST + ws upgrade + static dashboard
smoke.ts      self-test used by `npm run smoke`
```

## Adapter contract

```ts
interface ChinvatAdapter {
  name: string; version: string; description: string;
  configSchema: FieldSpec[];              // drives dashboard config forms
  capabilities(): OperationSpec[];        // { name, description, params, risk }
  health(ctx): Promise<{ ok: boolean; detail?: string }>;
  invoke(operation, args, ctx): Promise<InvokeResult>;  // { output?, artifacts? }
  cancel?(jobId): Promise<void>;
  onBoot?(ctx): void|Promise<void>;       // e.g. telegram polling loop
}
```

`ctx: AdapterContext` = `{ config, dataDir, saveArtifact(), log(), emit(), signal }`. Risk levels: `read` (no side effects), `act` (reversible-ish side effects), `dangerous` (shell, deletes, money, mass sends).

## Job lifecycle

```
tasks_submit ──▶ policy.decide
   ├─ reject   → job failed(policy_rejected)
   ├─ approval → waiting_approval ──approve──▶ queued   (deny → cancelled)
   └─ run      → queued ──dispatcher──▶ running ──▶ succeeded | failed
mode:"sync" holds the MCP call until terminal state or timeout, then returns result inline;
mode:"async" returns {job_id} immediately. Parent/child via parent_id; tree in dashboard.
```

Events (`job_events`): every transition + adapter logs, streamed over `/ws` and into Telegram when configured.

## Data model (SQLite)

```
jobs(id TEXT pk, parent_id, module, operation, args_json, status, mode,
     result_json, error, created_at, started_at, finished_at, source)
job_events(id INTEGER pk, job_id, ts, kind, data_json)
approvals(id TEXT pk, job_id, requested_at, decided_at, decision, decided_via)
```

Config is a JSON file, not DB — human-editable, easy to back up: `{ port, modules: { [name]: { enabled, tier, config } } }`.

## Security posture (v0.1)

Binds 127.0.0.1 only. Dashboard/REST unauthenticated **on localhost by design**; `/mcp` same. Auth middleware hook exists (`api.ts`) so the v1.0 remote release adds token/OIDC without restructuring. Secrets never leave the machine except inside calls to the services they belong to.
