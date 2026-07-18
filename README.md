<p align="center">
  <a href="docs/fa/README.md"><b>فارسی</b></a> &nbsp;·&nbsp; <b>English</b>
</p>

<p align="center"><sub>راهنمای کامل به زبان فارسی: <a href="docs/fa/README.md">از این‌جا شروع کنید ←</a></sub></p>

# Chinvat

**The bridge between your agents and your world.**

Chinvat is a local **MCP labor hub** for Windows. It gives any MCP-capable coordinator (Claude Code / Claude Desktop, Codex, Cursor, Hermes, …) a single server through which it can delegate work to local models, remote specialist models, Windows itself, and your communication and publishing channels — with a persistent job queue, artifacts, and a policy layer that decides what crosses the bridge.

```
Coordinator agent ──MCP──▶ Chinvat Hub ──▶ ollama · openrouter · openai-compatible
        (Claude, Codex…)      │             Windows/System · Telegram · WordPress
                              │             WhatsApp · Facebook · Instagram · LinkedIn · X
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

## Repository layout

```text
hub/src/                    hub, jobs, policy, MCP, API, and built-in adapters
dashboard/src/              local React dashboard
clients/                    coordinator configuration and Codex plugin
wp-plugin/chinvat-bridge/   optional WordPress Abilities companion plugin
app-bridges/                pinned or externally installed local-app bridge assets
docs/                       guides, architecture, modules, and roadmap
```

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
| `adapter_invoke` | Direct synchronous call; optional non-persistent `ephemeral:true` for read-only ops |

## Modules

| Module | Status | Needs |
|---|---|---|
| `ollama` | full | local Ollama at `127.0.0.1:11434` |
| `openrouter` | full | API key |
| `openai-compatible` | full | `Base URL` + the provider’s own `API key` |
| `telegram` | full (incl. approval buttons) | bot token |
| `wordpress` | full | site URL + application password |
| `system` (Windows/shell/files) | full | policy tier ≥ approve for writes |
| `coolify` | v0.1.0 | Coolify URL + scoped API token |
| `blender` | v0.1.0 | Blender + enabled bridge add-on; one Connect click |
| `orca` | v0.1.0 | CLI-capable Orca-lineage slicer + configured paths |
| `gimp` | v0.1.0 | GIMP 3 + user-installed GPL plug-in; per-session start |
| `rhino` | v0.1.0 | Rhino 8 + installed bridge script |
| `whatsapp` (Cloud API) | token-config | Meta app token + phone number ID |
| `facebook` (Pages) | token-config | page access token |
| `instagram` (Graph) | token-config | IG user ID + token |
| `linkedin` | token-config | OAuth token (`w_member_social`) |
| `x` (Twitter) | token-config | OAuth 2.0 user token (`tweet.write`) |

`openai-compatible` is one reusable worker for NVIDIA NIM/Nemotron, Groq, Together, LM Studio, vLLM, Azure, and any other OpenAI-compatible endpoint — point it at a `Base URL` with the provider’s `API key`. Provider-named instances are roadmap work, not shipped modules. New modules are folders implementing the [adapter contract](docs/ARCHITECTURE.md#adapter-contract) — drop them in `hub/src/adapters/` (built-in) or `modules/` (external, loaded at boot).

### Local-app bridges

`blender`, `orca`, and `gimp` add local desktop-app control. Blender and GIMP use loopback sockets; Orca spawns a pinned slicer CLI and deliberately has no printer-control surface. Read-tier PNG snapshots are artifacts for a vision-capable caller to inspect and iterate on—Chinvat does not run vision itself. See the [local-app bridge design](docs/DESIGN-local-app-bridges.md), [Blender app-side setup](app-bridges/blender/README.md), and [GIMP setup](app-bridges/gimp/SETUP.md).

### WordPress companion plugin

The built-in `wordpress` module uses core WordPress REST for posts, pages, media, taxonomy, and block-theme navigation. Adapter 0.4.0 can read and patch existing pages; list/read/update/delete media metadata; list/read/update `wp_navigation` block markup; pass `featured_media` through post/page drafts and updates; and upload either a bounded public URL or caller-supplied base64 bytes (for example, bytes downloaded through an authenticated Google Drive connector). Navigation updates and permanent media deletion are dangerous operations. URL uploads reject private-network destinations across redirects, unsupported MIME types, and payloads above 20 MiB. The optional [Chinvat WP Bridge](wp-plugin/chinvat-bridge/README.md) 0.4.3 adds 18 WordPress Abilities for guarded option access, active-theme file I/O, DB-layer Global Styles and Site Editor template overrides, per-post RankMath fields, installed-plugin activation/deactivation, and block-aware child-theme scaffolding. PHP theme writes use an in-process Zend syntax gate when `proc_open` is disabled and remain fail-closed if no verified backend exists. Its authenticated handshake is `GET /wp-json/chinvat-bridge/v1/info`.

The TypeScript `wordpress` adapter 0.4.0 exposes 19 fixed `bridge_*` operations: one handshake plus the 18 Bridge abilities. The new `bridge_db_state`, `bridge_global_styles_*`, and `bridge_template_*` operations run through normal Chinvat jobs and policy; DB writes require **Developer Mode** plus **DB Layer (Global Styles & Templates)**. This is a static operation list, not discovery of arbitrary abilities. Both `bridge_theme_write` and the auto-activating `bridge_theme_scaffold_child` are `dangerous`. Use an admin-only application password, keep MCP away from untrusted callers, and never give a write-enabled agent untrusted content. The safeguards reduce risk; they do not make arbitrary code execution safe.

## Policy: what crosses the bridge

Every operation declares a risk (`read` / `act` / `dangerous`); every module has a tier:

- **observe** — `read` operations run; `act`/`dangerous` operations are rejected
- **approve** — `read` operations run; `act`/`dangerous` operations pause as `waiting_approval`; release with one click in the dashboard or from Telegram
- **autonomous** — everything runs (dangerous ops still logged)

Model inference is `read`, so it runs at every tier without approval.

## Docs

[Getting started](docs/GETTING-STARTED.md) · [Using models](docs/MODELS.md) · [Configuration](docs/CONFIGURATION.md) · [Modules guide](docs/MODULES.md) · [راهنمای فارسی](docs/fa/README.md)

[Development plan](docs/DEVELOPMENT-PLAN.md) · [Architecture](docs/ARCHITECTURE.md) · [Roadmap](docs/ROADMAP.md) · [Local-app bridge design](docs/DESIGN-local-app-bridges.md) · [Agent handover](AGENTS.md)

## License

MIT — see [LICENSE](LICENSE).

---

*In Zoroastrian tradition, the Chinvat Bridge is where deeds are weighed before crossing. Same idea, smaller stakes.*
