# AGENTS.md — handover for coding and desktop agents

Chinvat is designed to be deployed, operated, and extended by desktop coding agents. This file is the compact operational contract; subsystem details live in [`docs/`](docs/README.md).

## Deploy on Windows

```powershell
git clone https://github.com/adun-denton/Chinvat.git
cd Chinvat
npm install
npm run build
npm start
```

- Normal run: dashboard + REST + WebSocket + MCP HTTP on `127.0.0.1:7777`.
- stdio-only client process: `node hub/dist/index.js --stdio`.
- Explicit dual transport: add `--http` or `--port <n>` to a stdio launch.
- Optional autostart: `scripts/install.ps1 -Autostart`.
- Development: `npm run dev -w hub` and `npm run dev -w dashboard`.

Do not clone or move a working tree through `C:\Windows\System32`; inherited ACLs can leave SQLite and config files unwritable for normal runs. Do not alternate elevated and unelevated hub processes against the same tree.

## Operate

MCP tools:

`workers_list`, `capabilities_describe`, `tasks_submit`, `tasks_status`, `tasks_result`, `tasks_cancel`, `adapter_invoke`.

REST base: `http://127.0.0.1:7777/api`.

Important routes:

```text
GET  /status
GET  /modules
PUT  /modules/:name/config|tier|enabled
GET  /jobs
GET  /jobs/:id
POST /jobs
POST /jobs/:id/cancel
GET  /approvals
POST /approvals/:id/approve|deny
GET  /connect/clients
POST /connect/test|preview|apply
GET  /auth/required
WS   /ws
MCP  /mcp
```

## Current built-ins

The hub registers 20 adapters:

```text
ollama openrouter openai-compatible system telegram wordpress woocommerce
coolify blender orca gimp rhino whatsapp facebook instagram linkedin x
gmail chat-relay remote-node
```

First-boot enabled: `ollama`, `openrouter`, `system`, `telegram`, `wordpress`. New or external modules default to tier `approve`.

## Configuration and authentication

Config file: `data/chinvat.config.json`.

Environment overrides:

```text
CHINVAT_PORT
CHINVAT_DATA_DIR
CHINVAT_BIND
CHINVAT_AUTH_TOKEN
```

`bind` defaults to `127.0.0.1`. A non-loopback bind without an `authToken` is a startup error, and tokens shorter than 24 characters are rejected. A configured token gates `/mcp`, `/api`, and `/ws`; `/auth/required` is intentionally public so the dashboard can prompt.

`ConfigStore` loads once per process. Dashboard/API config changes are not visible to a separate stdio hub until that client process is restarted. Environment-overridden top-level values are part of the in-memory config and may be written into `chinvat.config.json` by a later save; do not assume a one-off environment launch stays ephemeral.

## Repository map

```text
hub/src/              composition root, config, auth, DB, jobs, policy, registry,
                      MCP, REST/WS, connect, artifacts, adapter libraries
hub/src/adapters/     20 built-in workers
hub/src/lib/          shared relay, transport, validation, and packet helpers
dashboard/src/        React/Vite dashboard
clients/              coordinator configs and Codex pack
app-bridges/          local-app/Gmail setup assets
wp-plugin/            optional WordPress companion plugin
docs/                 maintained docs, specialist designs, roadmap, spike report
spike/                disposable experiments; never import into product code
modules/              external drop-ins loaded at boot
```

## Conventions

- TypeScript strict; keep adapter and policy boundaries explicit.
- Every operation declares `read`, `act`, or `dangerous`; never infer risk from its name at runtime.
- External adapters implement `ChinvatAdapter` from `hub/src/types.ts` and default to `approve`.
- Secrets live only in git-ignored config or provider stores. Never commit `data/`.
- Prefer `mode:"async"` for long work and for remote operations that may stop at approval.
- `adapter_invoke {ephemeral:true}` is read-only, synchronous, non-persistent, and restricted by `ephemeralModules`.
- The browser spike under `spike/wp-00/` is evidence, not a reusable package. The approved direction is adapter + governed data plane over Playwright, not a general custom browser driver.

## Verify before committing

```powershell
npm run build
npm run smoke
```

Run relevant unit tests for the touched subsystem. Native `better-sqlite3` and Vite/Rollup bindings are platform-specific; a Linux-mounted Windows checkout may type-check while native tests/builds require Windows. Avoid committing CRLF-only churn.

For documentation-only changes, verify links, module counts, operation names, and that all current-state claims match code on `main`.

## Guardrails and known operational defects

- Never bind `0.0.0.0`; remote nodes should bind the private mesh address and use a bearer token.
- `/connect/apply` may merge only the `chinvat` client entry and must create a backup.
- `remote-node.node_invoke` can lose the useful job id when sync mode waits on a remote approval. Until fixed, use async for non-read remote operations.
- No remote jobs/approvals listing operation exists yet; preserve returned remote job ids.
- An HTTP `EADDRINUSE` error is currently logged without terminating the process. A supervisor may mistake that process for a healthy listener; verify the port independently.
- Do not weaken module defaults or bypass adapter-level confirmations for destructive, financial, or code-execution operations.

## Documentation authority

Use [`docs/README.md`](docs/README.md). Code/tests outrank prose; the development plan and handoffs are historical when they contradict current implementation.
