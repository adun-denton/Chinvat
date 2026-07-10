# AGENTS.md — handover for agentic coders & desktop agents

Chinvat is designed to be **deployed and controlled by desktop agents** (Claude Cowork/Code, Codex, …). Everything you need is below; no human steps are required beyond secrets the user must supply.

## Deploy (Windows)

```powershell
git clone https://github.com/adun-denton/Chinvat.git; cd Chinvat
npm install          # workspaces: hub, dashboard
npm run build        # tsc (hub) + vite build (dashboard)
npm start            # boots hub: dashboard+API+MCP-HTTP on 127.0.0.1:7777
```

- Autostart (optional): `scripts/install.ps1 -Autostart` registers a Task Scheduler logon task.
- Dev loop: `npm run dev -w hub` (tsx watch) and `npm run dev -w dashboard` (vite, proxies `/api` to 7777).

## Operate

Two equivalent control planes:

1. **MCP** — stdio: `node hub/dist/index.js --stdio` · HTTP: `POST http://127.0.0.1:7777/mcp`
   Tools: `workers_list`, `capabilities_describe`, `tasks_submit`, `tasks_status`, `tasks_result`, `tasks_cancel`, `adapter_invoke`.
2. **REST** (what the dashboard uses) — base `http://127.0.0.1:7777/api`:
   `GET /status`, `GET /modules`, `PUT /modules/:name/config`, `PUT /modules/:name/tier`,
   `GET /jobs?status=…`, `GET /jobs/:id`, `POST /jobs`, `POST /jobs/:id/cancel`,
   `GET /approvals`, `POST /approvals/:id/approve|deny`, WS events at `/ws`.

Typical delegation: `tasks_submit {module:"ollama", operation:"chat", args:{model:"qwen3", messages:[…]}, mode:"sync"}`.

## Configuration

- File: `data/chinvat.config.json` (created on first boot; `data/` is git-ignored).
- Env overrides: `CHINVAT_PORT`, `CHINVAT_DATA_DIR`.
- Module secrets (bot tokens, API keys) go **only** in that config via dashboard or `PUT /modules/:name/config`. **Never commit secrets or the `data/` directory.**

## Repo map

```
hub/src/            core: index, config, db, jobs, policy, registry, mcp, api, events, artifacts
hub/src/adapters/   built-in modules (one file each)
dashboard/src/      React UI (vite)
clients/            .mcp.json snippets, Claude skill, Codex plugin
docs/               plan, architecture, modules, roadmap
scripts/            install.ps1, start.cmd
modules/            external drop-in adapters (git-ignored contents)
```

## Conventions

- TypeScript strict; small files; no framework beyond Express + ws in the hub.
- Every adapter implements the contract in `hub/src/types.ts` and declares risk per operation — the policy engine depends on it.
- Verify before committing: `npm run build && npm run smoke` (boots hub on a temp port, exercises MCP over stdio, submits a job through policy).
- Commit style: imperative subject, body lists user-visible changes.

## Guardrails

- Do not weaken policy defaults (new modules default to `approve`).
- Do not bind to `0.0.0.0` — remote exposure is a roadmap item with its own auth design (docs/ROADMAP.md).
- Do not push `data/`, `dist/`, `node_modules/`, or lockfiles (repo is synced via API; deps are semver-pinned).
