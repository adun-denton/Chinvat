<p align="center">
  <a href="docs/fa/README.md"><b>فارسی</b></a> &nbsp;·&nbsp; <b>English</b>
</p>

<p align="center"><sub>راهنمای فارسی: <a href="docs/fa/README.md">از این‌جا شروع کنید ←</a></sub></p>

# Chinvat

**The bridge between your agents and your world.**

Chinvat is a governed MCP labor hub for Windows. Any MCP-capable coordinator—Codex, Claude, Cursor, Hermes, or another client—can delegate work through one interface to models, the machine, local creative applications, publishing/commerce systems, communication channels, and complete Chinvat hubs on other computers.

It is not a generic tool proxy. Work becomes durable jobs with lineage, artifacts, policy, approval, recovery, and an audit trail.

```text
Coordinator ── MCP ──▶ Chinvat Hub
                        ├─ model workers: Ollama · OpenRouter · OpenAI-compatible
                        ├─ machine/apps: System · Coolify · Blender · GIMP · Rhino · Orca
                        ├─ publishing: WordPress · WooCommerce
                        ├─ communication: Telegram · WhatsApp · social · Gmail
                        ├─ governed relay: chat-relay
                        ├─ federated hubs: remote-node
                        ├─ SQLite jobs + approvals + artifacts
                        └─ dashboard + REST + WebSocket @ 127.0.0.1:7777
```

## Why

MCP aggregators multiplex tools. Chinvat manages labor: jobs are submitted, routed to explicit worker operations, persisted, supervised, approved when consequential, and composed into larger objectives by the coordinator.

Each remote machine can run a complete independent hub. Each hub keeps its own policy, approvals, modules, ledger, and artifacts; federation does not turn a remote workstation into an ungoverned shell.

## Quickstart on Windows

Requirements: Node.js 20+ (22 LTS recommended) and Git.

```powershell
git clone https://github.com/adun-denton/Chinvat.git
cd Chinvat
npm install
npm run build
npm start
```

Open `http://localhost:7777`. For an agent-led deployment, see [AGENTS.md](AGENTS.md).

## Repository layout

```text
hub/src/                    hub core, auth, jobs, policy, MCP/REST/WS, adapters
hub/src/lib/                shared transport, relay, packet, validation layers
dashboard/src/              local React dashboard
clients/                    coordinator configuration and Codex pack
modules/                    external drop-in adapters loaded at boot
app-bridges/                app-side bridge setup/assets
wp-plugin/chinvat-bridge/   optional WordPress Abilities companion plugin
docs/README.md              documentation hierarchy and authority map
docs/spike/                 measured experiments and rejected paths
```

## Connect a coordinator

Start the hub and open **Connect**. Chinvat can preview and safely merge its own entry into supported client configuration, back up the existing file, re-test the endpoint, and report the required restart/reload.

| Client | Default | Notes |
|---|---|---|
| Codex | Streamable HTTP | project/global TOML; restart |
| Claude Code | Streamable HTTP | project/global; `/mcp` |
| Claude Desktop | stdio | native HTTP unavailable; full restart |
| Cursor | Streamable HTTP | project/global JSON |
| Hermes | Streamable HTTP | YAML; `/reload-mcp` |
| Generic MCP | Streamable HTTP or stdio | copy-only |

Local endpoint: `http://127.0.0.1:7777/mcp`.

A hub deliberately bound outside loopback requires a bearer token. Generated Connect snippets include the token for authenticated hubs. See [Configuration](docs/CONFIGURATION.md) and [Remote Nodes](docs/REMOTE-NODES.md).

## MCP surface

| Tool | Purpose |
|---|---|
| `workers_list` | Discover modules, health, tiers, and operations |
| `capabilities_describe` | Read schemas and risk for one module |
| `tasks_submit` | Submit persistent sync/async work with optional lineage |
| `tasks_status` / `tasks_result` / `tasks_cancel` | Track, retrieve, and stop jobs |
| `adapter_invoke` | Direct synchronous call; optionally ephemeral for allowlisted read operations |

## Built-in modules

Chinvat ships 20 built-ins. The complete operation and setup reference is [Modules](docs/MODULES.md).

| Family | Modules |
|---|---|
| Models | `ollama`, `openrouter`, `openai-compatible` |
| Machine/infrastructure | `system`, `coolify`, `remote-node` |
| Local applications | `blender`, `orca`, `gimp`, `rhino` |
| Publishing/commerce | `wordpress`, `woocommerce` |
| Messaging/social | `telegram`, `whatsapp`, `facebook`, `instagram`, `linkedin`, `x` |
| Governed relay | `gmail`, `chat-relay` |

External modules can be placed under `modules/<name>/` and are loaded at boot.

## Major subsystem guides

- **Remote nodes:** federated hubs over a private mesh, bearer auth, transport restrictions, and two-layer policy. [Guide](docs/REMOTE-NODES.md)
- **Mail Relay:** compile a bounded repository packet, import an inert response, validate in a disposable worktree, and gate live apply. [Design](docs/DESIGN-mail-relay.md)
- **Local applications:** socket and CLI bridge patterns for Blender, GIMP, Rhino, and Orca. [Design](docs/DESIGN-local-app-bridges.md)
- **Browser direction:** platform adapters and governed data plane on Playwright; no custom driver protocol without new evidence. [WP-00 report](docs/spike/WP-00-REPORT.md)
- **WordPress:** core REST in the hub plus the optional guarded WP Bridge. [Plugin guide](wp-plugin/chinvat-bridge/README.md)

## Policy: what crosses the bridge

Every operation declares `read`, `act`, or `dangerous`. Every module has a tier:

- **observe** — read runs; act/dangerous reject.
- **approve** — read runs; act/dangerous wait for human approval.
- **autonomous** — declared operations run without pausing and remain logged.

Risk labels are part of the adapter contract. A proxy or raw escape hatch may not silently downgrade the risk of the operation it reaches.

## Authentication and trust

The default loopback hub is zero-config. A non-loopback bind without a token fails before opening a socket. `/mcp`, `/api`, and `/ws` share the same authorization decision.

Bearer auth identifies access to one hub; it is not yet per-user authorization. Remote privileged invocation is remote code execution by design and remains subject to both the coordinator hub's gate and the remote hub's own policy.

## Documentation

Start with the [documentation hierarchy](docs/README.md).

[Getting started](docs/GETTING-STARTED.md) · [Configuration](docs/CONFIGURATION.md) · [Models](docs/MODELS.md) · [Modules](docs/MODULES.md) · [Remote nodes](docs/REMOTE-NODES.md) · [Architecture](docs/ARCHITECTURE.md) · [Development plan](docs/DEVELOPMENT-PLAN.md) · [Roadmap](docs/ROADMAP.md) · [راهنمای فارسی](docs/fa/README.md)

## License

MIT — see [LICENSE](LICENSE).

---

*In Zoroastrian tradition, the Chinvat Bridge is where deeds are weighed before crossing. Same idea, smaller stakes.*
