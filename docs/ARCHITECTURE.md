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
connect.ts    per-client config (JSON/TOML/YAML), safe merge + backup, host detection, endpoint self-test
mcp.ts        McpServer with 7 tools; stdio + streamable-HTTP bindings
api.ts        Express REST + ws upgrade + static dashboard
smoke.ts      self-test used by `npm run smoke`
```

External deps beyond Express/ws/zod/better-sqlite3: `smol-toml` and `yaml` back the connect module's config merges (Codex is TOML, Hermes is YAML).

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

`ctx: AdapterContext` = `{ config, dataDir, saveArtifact(), log(), emit(), signal }`. Risk levels: `read` (no side effects), `act` (reversible-ish side effects), `dangerous` (shell, deletes, money, mass sends). Eleven modules ship built-in (`ollama`, `openrouter`, `openai-compatible`, `system`, `telegram`, `wordpress`, `whatsapp`, `facebook`, `instagram`, `linkedin`, `x`); more load from `modules/` at boot.

## WordPress integration paths

WordPress has two complementary surfaces:

1. **Core REST, shipped in the hub:** `hub/src/adapters/wordpress.ts` calls `/wp-json/wp/v2` for posts, pages, media, and taxonomy. These operations are available through Chinvat's normal jobs and policy engine.
2. **WordPress Abilities, shipped in the companion plugin:** `wp-plugin/chinvat-bridge/` registers nine `chinvat-bridge/*` abilities for options, active-theme files, per-post RankMath metadata, and plugin activation/deactivation. The WordPress Abilities API + MCP Adapter can expose them directly. The plugin also provides authenticated `GET /wp-json/chinvat-bridge/v1/info` for version/capability discovery.

The TypeScript adapter does **not yet** probe the handshake or invoke these abilities. Its planned extension contract is:

```text
read:          GET  /wp-json/wp-abilities/v1/abilities/{name}/run?input[key]=value
act/dangerous: POST /wp-json/wp-abilities/v1/abilities/{name}/run
               {"input":{"key":"value"}}
```

The extension must translate each ability's `read` / `act` / `dangerous` risk into Chinvat policy before invocation and preserve application-password authentication. `theme-write` remains remote code execution by design; path confinement, atomic writes, PHP linting, backups, capability checks, Developer Mode, and per-capability toggles are layered mitigations rather than a security boundary.

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

## Connecting coordinators

`connect.ts` turns "add Chinvat to my agent" into a first-class flow. For each supported client (Codex, Claude Desktop, Claude Code, Hermes, Cursor, Generic) it knows the config format, file location, transports, scopes, and restart behavior. REST surface under `/api/connect`:

```
GET  /connect/clients   list clients with detection, resolved paths, ready-to-copy snippets, one-commands
POST /connect/test      real MCP handshake against the hub's own /mcp, then workers_list
POST /connect/preview   compute the merged config file without writing (diff + backup path)
POST /connect/apply     back up any existing file (timestamped) then write the merged config
```

Merges are non-destructive: parse the existing file (JSON/TOML/YAML), set only the `chinvat` entry, serialize back. Auto-install targets user/global scope (well-defined absolute paths); project scope is copy/one-command so nothing is written into an unchosen folder. Claude Desktop has no native HTTP transport, so it defaults to stdio (HTTP offered via `mcp-remote`).

## Data model (SQLite)

```
jobs(id TEXT pk, parent_id, module, operation, args_json, status, mode,
     result_json, error, created_at, started_at, finished_at, source)
job_events(id INTEGER pk, job_id, ts, kind, data_json)
approvals(id TEXT pk, job_id, requested_at, decided_at, decision, decided_via)
```

Config is a JSON file, not DB — human-editable, easy to back up: `{ port, modules: { [name]: { enabled, tier, config } } }`.

## Security posture (v0.1)

Binds 127.0.0.1 only. Dashboard/REST unauthenticated **on localhost by design**; `/mcp` same. The `/connect/apply` route writes to the user's own coordinator config files (their machine, their process) and always backs up first. Auth middleware hook exists (`api.ts`) so the v1.0 remote release adds token/OIDC without restructuring. Secrets never leave the machine except inside calls to the services they belong to.
