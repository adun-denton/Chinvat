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

1. **Core REST, shipped in the hub:** adapter 0.4.0 in `hub/src/adapters/wordpress.ts` calls `/wp-json/wp/v2` for posts, pages, media, taxonomy, and `wp_navigation`. Existing pages and navigation records have explicit editable-context reads and bounded updates; draft post/page writes accept `featured_media`. Media has list/read/metadata-update/permanent-delete primitives and accepts one bounded public URL or base64 bytes supplied by an authenticated upstream connector. URL fetching validates HTTP(S), every redirect target, resolved addresses, MIME, and a 20 MiB cap before forwarding bytes to WordPress. Navigation updates and permanent media deletion are `dangerous`; these operations remain inside Chinvat's normal jobs and policy engine.
2. **WordPress Abilities, shipped in the companion plugin:** `wp-plugin/chinvat-bridge/` 0.4.2 registers 18 `chinvat-bridge/*` abilities. In addition to options, active-theme files, per-post RankMath metadata, plugin activation/deactivation, and child-theme scaffolding, eight `chinvat-db` abilities read/write/reset user Global Styles and Site Editor template/part overrides—the DB layer that wins at render time. The plugin provides authenticated `GET /wp-json/chinvat-bridge/v1/info`; schema `3` reports all 18 abilities and includes the `child_scaffold` and `db_layer` toggles.

The TypeScript adapter version `0.4.0` ships 19 static `bridge_*` operations: `bridge_info`, the original ten ability mappings, and `bridge_db_state`, `bridge_global_styles_get`, `bridge_global_styles_update`, `bridge_global_styles_reset`, `bridge_template_list`, `bridge_template_get`, `bridge_template_update`, and `bridge_template_reset`. `bridge_info` calls the handshake; the other 18 map to known abilities using this contract:

```text
read:                    GET    /wp-json/wp-abilities/v1/abilities/{name}/run?input[key]=value
no-argument read:        GET    /wp-json/wp-abilities/v1/abilities/{name}/run?input=
destructive annotation: DELETE /wp-json/wp-abilities/v1/abilities/{name}/run?input[key]=value
other writes:            POST   /wp-json/wp-abilities/v1/abilities/{name}/run  {"input":{"key":"value"}}
```

The Abilities API requires an `input` object even for no-argument GET runs; a bare `input=` satisfies that route, whereas a JSON query string such as `{}` is not decoded into an object. In the deployed API version, destructive-annotated abilities require DELETE and ignore DELETE bodies, so their inputs travel only in nested query parameters. The Bridge therefore reserves destructive annotations for small-scalar operations (`plugins-toggle`, `theme-scaffold-child`, and the two DB resets); content-bearing writes are non-destructive annotations and use POST JSON. Query-borne booleans need REST boolean sanitization. These transport annotations do not change Chinvat policy risk.

These operations preserve each ability's `read` / `act` / `dangerous` risk and therefore pass through normal Chinvat jobs/policy before invocation. The adapter uses application-password authentication. Its `health()` first authenticates against core REST, then probes the handshake best-effort and appends the Bridge version/write state when detected; Bridge absence never fails core WordPress health. The operation list is fixed in the adapter rather than dynamically generated from handshake results.

The DB slice separates runtime state from file state. `db-state` reports the active stylesheet/template, user Global Styles post, and DB overrides with `has_theme_file`. Global Styles update deep-merges or replaces a theme.json-shaped config and writes the required user-theme markers; on hosts where `wp_update_post` fatals for `wp_global_styles`, 0.4.2 hard-deletes and reinserts the full post, losing revisions. Template get/list follow WordPress resolution (DB override first); update creates or updates the override; reset makes the backing theme file authoritative or reports that no file remains. DB reads require `edit_theme_options`; writes also require Developer Mode and `db_layer`. The shared insert helper temporarily removes KSES filters only when the actor lacks `unfiltered_html`; existing template overrides use WordPress's normal `wp_update_post` path.

Each stdio MCP client owns a spawned hub process. After rebuilding `hub/dist`, restart those `node ... --stdio` processes or the client so it loads the new adapter; restarting only the HTTP daemon does not refresh stdio clients.

`bridge_theme_scaffold_child` is `dangerous` and defaults to activation. It creates a fresh, block-aware child of `get_template()`—never a child of the active stylesheet—with `style.css`, minimal `theme.json`, a trusted plugin-authored `functions.php`, copied header/footer parts when present, and a `templates/` directory. The generated PHP enqueues `get_stylesheet_uri()` on `wp_enqueue_scripts`, because block themes do not automatically load the child stylesheet. It is static plugin code written through the scaffold's confined child writer, not agent input traveling through the `theme-write` lint path. It is an update-resistant target for `theme-write`, not a full clone. `theme-write` remains remote code execution by design and fails closed for `.php` when PHP CLI linting through `proc_open` is unavailable; non-PHP writes are unaffected. Path confinement, atomic writes, PHP linting, backups, capability checks, Developer Mode, and per-capability toggles are layered mitigations rather than a security boundary.

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
