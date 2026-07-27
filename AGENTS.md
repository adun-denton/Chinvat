# AGENTS.md — handover for agentic coders and desktop agents

Chinvat is designed to be deployed and maintained by coding/desktop agents. Ordinary repository work should be completed end to end: inspect, edit, verify, commit, and push. Do not introduce a branch/PR/merge workflow for routine changes unless repository protection, parallel work, or explicit review requires it.

## Deploy on Windows

```powershell
git clone https://github.com/adun-denton/Chinvat.git
cd Chinvat
npm install
npm run build
npm start
```

- Requirements: Node.js 20+; Node 22 LTS recommended.
- Dashboard, REST, WebSocket events, and MCP HTTP normally share `127.0.0.1:7777`.
- Optional autostart: `scripts/install.ps1 -Autostart`.
- Dev loop: `npm run dev -w hub` and `npm run dev -w dashboard`.

## Process and transport model

A process owns one `Hub` singleton: config, SQLite DB, registry, job engine, policy, artifacts, REST, WebSocket events, and MCP bindings.

```text
normal run: node hub/dist/index.js             HTTP + dashboard
stdio client: node hub/dist/index.js --stdio   stdio only unless --http/--port is explicit
```

HTTP surfaces:

- MCP: `POST /mcp`
- REST: `/api/*`
- WebSocket events: `/ws`
- Dashboard: `/`
- Auth probe: `GET /auth/required`

MCP tools: `workers_list`, `capabilities_describe`, `tasks_submit`, `tasks_status`, `tasks_result`, `tasks_cancel`, `adapter_invoke`.

## Authentication and remote bind

- Default `bind` is `127.0.0.1`; an empty token is allowed only on loopback.
- A non-loopback bind without `authToken` is a startup error.
- Tokens must be at least 24 characters.
- `/mcp`, `/api`, and `/ws` share the same authorization decision.
- HTTP clients use `Authorization: Bearer <token>`; browser WebSockets may use `?token=`.
- Bind a remote node to its private mesh address, not `0.0.0.0`; see `docs/REMOTE-NODES.md`.

Environment overrides: `CHINVAT_PORT`, `CHINVAT_DATA_DIR`, `CHINVAT_BIND`, `CHINVAT_AUTH_TOKEN`.

`ConfigStore` loads once per process. Dashboard and client-spawned stdio hubs are separate processes and can share one config file while holding different in-memory snapshots. Restart every affected process after external config edits or a rebuild.

## Built-in modules

The 20 built-ins are:

`ollama`, `openrouter`, `openai-compatible`, `system`, `telegram`, `wordpress`, `woocommerce`, `coolify`, `blender`, `orca`, `gimp`, `rhino`, `whatsapp`, `facebook`, `instagram`, `linkedin`, `x`, `gmail`, `chat-relay`, `remote-node`.

The registry also loads external `modules/<name>/index.mjs|index.js` modules at boot. New modules default to the `approve` tier.

## Repository map

```text
hub/src/                  composition root, jobs, policy, auth, MCP, REST/WS
hub/src/adapters/         built-in workers
hub/src/lib/              shared relay, transport, packet, and validation layers
dashboard/src/            React/Vite dashboard
clients/                  coordinator configs and Codex pack
modules/                  external drop-in adapters loaded at boot
app-bridges/              app-side setup/assets for local integrations
wp-plugin/                optional WordPress companion plugin
docs/README.md            documentation hierarchy
docs/DESIGN-*.md          subsystem designs
docs/spike/               empirical or disposable research
```

## Verification

For ordinary code changes:

```powershell
npm run build
npm run smoke
```

Also run the nearest unit tests. The smoke test asserts the built-in module count; update it when the registry changes.

Cross-platform caveats:

- `better-sqlite3` and Rollup/Vite use platform-native bindings. A checkout with Windows dependencies cannot fully test/build under a Linux sandbox.
- Hub TypeScript and dashboard type-checking can still be run where their dependencies permit.
- Normalize only files you intentionally edit; do not commit a repository-wide CRLF rewrite.

## Operational traps

- Do not clone or move the repository through `C:\Windows\System32`; protected ACLs can leave SQLite unwritable. Clone directly into a user-owned directory.
- Do not alternate elevated and unelevated hub runs against the same data directory.
- A dashboard HTTP hub and a client-spawned stdio hub are distinct. Restarting one does not refresh the other.
- Until TASK-CHINVAT-008c is fixed, an `EADDRINUSE` listen error is logged but may leave the process alive without a listener. Supervisors must check the socket/health endpoint, not only process existence.
- Until TASK-CHINVAT-008a is fixed, use `mode:"async"` for remote operations that may wait for approval.

## Guardrails

- Every operation declares `read`, `act`, or `dangerous`; do not bypass policy in an adapter.
- Do not expose raw-request or raw-shell escape hatches under a lower risk label.
- Keep secrets in the git-ignored config only; never commit `data/`.
- `/connect/apply` may merge only Chinvat's own coordinator entry and must back up the target first.
- Local scripting operations and remote privileged invocation are code execution by design, not sandboxes.
- Browser automation follows the WP-00 decision: build platform adapters and a governed data plane on Playwright; do not import the disposable spike or create a custom driver protocol without new evidence.
