# Chinvat — Full Development Plan

Successor to the "Local MCP Labor Hub" blueprint (July 2026), adjusted after review: client-agnostic instead of Codex-only, dashboard-first, policy pulled forward from V5 to v0.1.

## 1. Vision

A **local labor hub**: coordinators (any MCP client) delegate work; Chinvat routes it to worker modules — local models, remote specialists, the Windows machine, messaging and publishing channels — persists every job, and gates risky actions behind an approval bridge. Remote/cloud deployment and multi-user control are explicit later phases; every v0.1 decision keeps that path open (Streamable HTTP transport, token auth hook, UI already client/server).

## 2. Differentiation

Aggregators/gateways (MetaMCP, mcp-proxy, agentgateway…) multiplex *tools*. Chinvat manages *labor*: durable jobs with lineage (`parent_id`), artifacts, policy tiers, human approval loops (dashboard + Telegram), and a UI for the human supervising the market. It is also itself an MCP server, so it composes with those gateways if ever needed.

## 3. Architecture (v0.1)

One Node 20+/TypeScript process:

- **Transports:** MCP stdio (spawned per-client) and MCP Streamable HTTP at `/mcp`; both share one hub singleton (jobs, policy, registry). Spec pinned to the SDK line supporting 2025-11-25; the 2026-07-28 RC (sessionless Streamable HTTP) is tracked as a low-risk upgrade since we keep no protocol-level session state.
- **Job engine:** better-sqlite3. Tables `jobs`, `job_events`, `approvals`. States: `queued → running → succeeded|failed|cancelled`, plus `waiting_approval` before `queued`. Crash recovery: on boot, `running` → failed(`interrupted`), `queued` re-dispatched. Per-module concurrency limits. Large outputs → `data/artifacts/<jobId>/`.
- **Policy engine:** operation risk (`read|act|dangerous`) × module tier (`observe|approve|autonomous`) → allow / queue-for-approval / reject. Approvals resolvable via dashboard or Telegram inline buttons; every decision is a `job_event` (audit trail).
- **Adapter contract:** `name, version, description, configSchema, capabilities(), health(), invoke(op, args, ctx), cancel?`. `ctx` provides config, artifact store, logger, event emitter. Registry loads built-ins + `modules/*/` drop-ins at boot.
- **Dashboard:** React/Vite SPA served statically by the hub; REST + WebSocket for live job/approval events.

## 4. Scope of v0.1 (this build)

| # | Deliverable | Maps to blueprint |
|---|---|---|
| 1 | Repo scaffold, plan, agent handover docs | — |
| 2 | Hub core: config, SQLite jobs, policy, registry, events, artifacts | V1 + slice of V5 |
| 3 | Modules: ollama, openrouter, telegram, wordpress, system (full); whatsapp, facebook, instagram, linkedin (token-config) | V0, V2 (manual selection), V3 |
| 4 | MCP layer (stdio + Streamable HTTP) with 7 tools; REST/WS API | V0/V1 |
| 5 | Dashboard: Overview, Jobs, Modules, Approvals, Playground, Settings | — (new) |
| 6 | Client packs (Claude skill, Codex plugin, snippets), install.ps1, start.cmd | blueprint §5 |
| 7 | Verification: build + boot + stdio MCP smoke test + job-through-policy | Definition of done |

**Definition of done (v0.1):** a coordinator can discover workers, submit parallel jobs (sync + async, with lineage), survive hub restarts, retrieve structured results and artifacts, invoke app modules, and a human can supervise/approve everything from the dashboard.

## 5. Worker selection

v0.1: explicit — coordinator names `module` (+ model in args). The skill teaches the pattern: plan on the big model, bulk-extract on local Qwen, specialize via OpenRouter, act via app modules, synthesize upstream. v0.2 adds routing metadata (cost, latency, context, historical success) captured per job, enabling `module:"auto"`.

## 6. Windows deployment

Git clone → `npm install` → `npm run build` → `npm start`. `scripts/install.ps1` automates incl. optional Task Scheduler autostart; `scripts/start.cmd` for double-click. No service wrapper in v0.1 (NSSM documented as an option). Data under `data/` beside the repo by default (`CHINVAT_DATA_DIR` to relocate).

## 7. Later versions (see ROADMAP.md for detail)

- **v0.2 — routing & reach:** auto worker selection, Blender module, artifacts browser, objectives (persistent parent goals), scheduled/event triggers.
- **v0.3 — surfaces:** WordPress *destination* plugin (WP-side companion), Tauri desktop shell + tray, WhatsApp desktop-driver alternative.
- **v1.0 — remote:** hosted hub (VPS/cloud or tunnel), TLS + token/OIDC auth, multi-user access levels mapped to tool/operation scopes (the "user levels → tool calls" feature), fleet view for multiple hubs.

## 8. Risks & mitigations

- **MCP spec drift** (2026-07-28 RC): transport code isolated in `mcp.ts`; no session-state assumptions.
- **Native module builds** (better-sqlite3): prebuilt binaries cover Node 20/22 on win32-x64; docs include build-tools fallback.
- **Meta/LinkedIn APIs:** tokens/app review are on the user; modules validate config and surface precise errors in the dashboard rather than failing deep in a job.
- **Telegram single-consumer:** long-polling loop guarded so only one hub instance polls a bot token.
- **Secrets:** config file is git-ignored; dashboard masks values; docs forbid committing `data/`.

## 9. Delivered since the v0.1 plan

- **X (Twitter) module** — tenth built-in (`post_tweet`, `delete_tweet`, `me`, `search_recent`), OAuth 2.0, config-gated and disabled by default. Built-ins are now: ollama, openrouter, telegram, wordpress, system, whatsapp, facebook, instagram, linkedin, x.
- **Connect workflow** — first-class coordinator connection, replacing the Settings view. Generates each client's config in its real format (Codex TOML, Claude Code/Cursor/Claude Desktop JSON, Hermes YAML) with host detection, copy or safe auto-install (preview → timestamped backup → merge only the `chinvat` entry → re-test), plus a Test MCP endpoint action that runs `workers_list`. Backed by `hub/src/connect.ts` and `/api/connect/*`; adds `smol-toml` and `yaml`. Verified live: correct paths/formats for all six clients, non-destructive TOML/JSON merges with backups, endpoint self-test reporting tools/workers. Streamable HTTP is the default transport; Claude Desktop (no native HTTP) defaults to stdio.
- **Build hardening** — dashboard build now type-checks (`tsc --noEmit && vite build`) after collapsing a project-reference tsconfig that broke a clean Windows build.
