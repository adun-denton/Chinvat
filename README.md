# Chinvat

**The bridge between your agents and your world.**

Chinvat is a local **MCP labor hub** for Windows. It gives any MCP-capable coordinator (Claude Code / Claude Desktop, Codex, Cursor, Hermes, …) a single server through which it can delegate work to local models, remote specialist models, Windows itself, and your communication and publishing channels — with a persistent job queue, artifacts, and a policy layer that decides what crosses the bridge.

```
Coordinator agent ──MCP──▶ Chinvat Hub ──▶ Ollama · OpenRouter · Windows/System
        (Claude, Codex…)      │             Telegram · WordPress · WhatsApp
                              │             Facebook · Instagram · LinkedIn
                              ├─ SQLite job engine (parent/child, artifacts, recovery)
                              ├─ Policy tiers (observe / approve / autonomous)
                              └─ Web dashboard @ http://localhost:7777
```

## Why

MCP servers are the critical joints of agentic pipelines — and the most frequent friction points. Existing aggregators proxy tools; Chinvat instead runs a **labor market**: jobs are submitted, routed to worker modules, persisted, supervised, approved when risky, and their results composed back into parent objectives.

## Quickstart (Windows)

Requirements: [Node.js 20+](https://nodejs.org) (22 LTS recommended), Git.

```powershell
git clone https://github.com/adun-denton/Chinvat.git
cd Chinvat
npm install
npm run build
npm start            # hub + dashboard on http://localhost:7777
```

Or let a desktop agent do it — see [AGENTS.md](AGENTS.md).

## Connect a coordinator

Start the hub, open the **Connect** tab, pick your client, and either copy the configuration or let Chinvat install it for you. Auto-install previews the exact change, backs up any existing file, writes only the `chinvat` entry (never touching your other servers), then re-tests the endpoint and reports success. Streamable HTTP is the default transport; stdio is the fallback.

| Client | HTTP | stdio | Scope | Auto-install | After connecting |
|---|---|---|---|---|---|
| Codex | ✓ default | ✓ | project + global | ✓ global | restart Codex |
| Claude Desktop | via `mcp-remote` | ✓ default | global | ✓ global | full restart |
| Claude Code | ✓ default | ✓ | project + global | ✓ + one-command | `/mcp` |
| Hermes | ✓ default | ✓ | global | ✓ global | `/reload-mcp` (no restart) |
| Cursor | ✓ default | ✓ | project + global | ✓ global | auto / toggle |
| Generic MCP client | ✓ default | ✓ | — | copy-only | reload |

The endpoint is always `http://127.0.0.1:7777/mcp`. Manual snippets and the Codex plugin live in [`clients/`](clients/); Claude Desktop has no native HTTP transport, so Chinvat uses stdio there by default.

## MCP surface

| Tool | Purpose |
|---|---|
| `workers_list` | Discover modules, health, and policy tier |
| `capabilities_describe` | Operations + JSON-schema args + risk level for one module |
| `tasks_submit` | Queue a job (sync or async, optional `parent_id`) |
| `tasks_status` / `tasks_result` / `tasks_cancel` | Track, fetch, stop |
| `adapter_invoke` | Direct synchronous call for quick low-risk ops |

## Modules

| Module | Status | Needs |
|---|---|---|
| `ollama` | full | local Ollama at `127.0.0.1:11434` |
| `openrouter` | full | API key |
| `telegram` | full (incl. approval buttons) | bot token |
| `wordpress` | full | site URL + application password |
| `system` (Windows/shell/files) | full | policy tier ≥ approve for writes |
| `whatsapp` (Cloud API) | token-config | Meta app token + phone number ID |
| `facebook` (Pages) | token-config | page access token |
| `instagram` (Graph) | token-config | IG user ID + token |
| `linkedin` | token-config | OAuth token (`w_member_social`) |

New modules are folders implementing the [adapter contract](docs/ARCHITECTURE.md#adapter-contract) — drop them in `hub/src/adapters/` (built-in) or `modules/` (external, loaded at boot).

## Policy: what crosses the bridge

Every operation declares a risk (`read` / `act` / `dangerous`); every module has a tier:

- **observe** — only `read` operations run
- **approve** — `act`/`dangerous` operations pause as `waiting_approval`; release with one click in the dashboard or from Telegram
- **autonomous** — everything runs (dangerous ops still logged)

## Docs

[Development plan](docs/DEVELOPMENT-PLAN.md) · [Architecture](docs/ARCHITECTURE.md) · [Modules guide](docs/MODULES.md) · [Roadmap](docs/ROADMAP.md) · [Agent handover](AGENTS.md)

## License

MIT — see [LICENSE](LICENSE).

---

*In Zoroastrian tradition, the Chinvat Bridge is where deeds are weighed before crossing. Same idea, smaller stakes.*
