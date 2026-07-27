<p align="center">
  <a href="docs/fa/README.md"><b>فارسی</b></a> &nbsp;·&nbsp; <b>English</b>
</p>

<p align="center"><sub>راهنمای فارسی: <a href="docs/fa/README.md">از این‌جا شروع کنید ←</a></sub></p>

# Chinvat

**The bridge between your agents and your world.**

Chinvat is a local **MCP labor hub** for Windows. Any MCP-capable coordinator—Codex, Claude Code/Desktop, Cursor, Hermes, or another client—can delegate work through one governed surface to local models, hosted specialists, Windows, publishing and communication services, local desktop applications, and other Chinvat machines.

```text
Coordinator ──MCP──▶ Chinvat hub
                       ├─ 20 built-in workers + external modules
                       ├─ SQLite jobs, lineage, events, approvals, artifacts
                       ├─ risk × tier policy: observe / approve / autonomous
                       ├─ dashboard + REST + WebSocket + MCP HTTP
                       ├─ human-gated repository relay
                       └─ federated remote hubs over a private mesh
```

Chinvat is not a model router disguised as a tool proxy. It manages durable work: jobs are submitted, policy is evaluated, risky work can pause for approval, execution is recorded, and results remain retrievable after the coordinator call ends.

## Quickstart

Requirements: Node.js 20+ (22 LTS recommended) and Git.

```powershell
git clone https://github.com/adun-denton/Chinvat.git
cd Chinvat
npm install
npm run build
npm start
```

Open `http://localhost:7777`. The default bind is loopback-only and requires no token. A non-loopback bind is refused unless a bearer token of at least 24 characters is configured.

## Repository layout

```text
hub/src/                    hub, jobs, policy, auth, MCP/API, and built-in adapters
dashboard/src/              React dashboard
clients/                    coordinator configuration and Codex pack
app-bridges/                local-app and Gmail setup assets
wp-plugin/chinvat-bridge/   optional WordPress companion plugin
docs/                       maintained guides, designs, evidence, and roadmap
spike/                      disposable experimental code; never import into product code
```

## Connect a coordinator

Start the hub and use the dashboard **Connect** page. It previews the exact merge, backs up an existing client file, writes only the `chinvat` entry, re-tests the endpoint, and includes the bearer token when the hub requires one.

| Client | HTTP | stdio | Typical scope | Auto-install |
|---|---|---|---|---|
| Codex | default | supported | project + global | global |
| Claude Code | default | supported | project + global | supported |
| Claude Desktop | through `mcp-remote` | default | global | supported |
| Cursor | default | supported | project + global | supported |
| Hermes | default | supported | global | supported |
| Generic MCP client | default | supported | client-defined | copy-only |

For a local untokened hub, the HTTP endpoint is `http://127.0.0.1:7777/mcp`. Manual examples are in [`clients/`](clients/). For a tokened endpoint, prefer the Connect page because header syntax differs between clients.

## MCP surface

| Tool | Purpose |
|---|---|
| `workers_list` | Discover workers, health, tier, and operations. |
| `capabilities_describe` | Read one worker’s operation schemas and risk declarations. |
| `tasks_submit` | Submit persistent sync or async work, optionally with `parent_id`. |
| `tasks_status` / `tasks_result` / `tasks_cancel` | Track, retrieve, or stop work. |
| `adapter_invoke` | Direct synchronous call; `ephemeral:true` is allowed only for read operations on allowlisted modules and persists nothing. |

## Built-in workers

Chinvat currently registers **20** built-ins. Only `ollama`, `openrouter`, `system`, `telegram`, and `wordpress` are enabled on first boot; everything else waits for explicit configuration.

| Family | Workers |
|---|---|
| Models | `ollama`, `openrouter`, `openai-compatible` |
| Machine and infrastructure | `system`, `coolify`, `remote-node` |
| Publishing and commerce | `wordpress`, `woocommerce` |
| Messaging and social | `telegram`, `whatsapp`, `facebook`, `instagram`, `linkedin`, `x`, `gmail` |
| Local applications | `blender`, `orca`, `gimp`, `rhino` |
| Governed coding relay | `chat-relay` |

The [Modules guide](docs/MODULES.md) is the complete operational reference.

### Remote nodes

`remote-node` treats another Chinvat installation as a governed worker, not as an unstructured SSH shell. Each node retains its own modules, policy tiers, approval queue, and ledger. Use a private mesh such as Tailscale/Headscale and read [Remote Node Management](docs/REMOTE-NODES.md) before exposing a bind beyond loopback.

### Mail Relay

`chat-relay` compiles a minimal repository packet, applies a secret/classification firewall, sends or exposes it through mail/clipboard/file, imports a structured reply, validates it in a disposable worktree, and gates live-branch application as `dangerous`. `gmail` is the optional OAuth2 carrier for the mail lane. See [Mail Relay design](docs/DESIGN-mail-relay.md).

### Local-app bridges

Blender, GIMP, and Rhino use loopback socket bridges; Orca launches a pinned CLI-capable slicer. Read-tier snapshots become artifacts for a vision-capable coordinator—Chinvat does not run vision itself. See [Local-app bridge design](docs/DESIGN-local-app-bridges.md).

## Policy: what crosses the bridge

Every operation declares `read`, `act`, or `dangerous`; every module has a tier:

- **observe** — reads run; side-effecting operations are rejected.
- **approve** — reads run; `act` and `dangerous` pause at `waiting_approval`.
- **autonomous** — all operations run without a pause, while remaining logged.

Provider inference is normally `read`. Shell execution, destructive changes, live publishing, money-bearing commerce actions, and live-branch application are not.

## Documentation

Start with the [documentation index](docs/README.md). Core references: [Getting started](docs/GETTING-STARTED.md), [Configuration](docs/CONFIGURATION.md), [Modules](docs/MODULES.md), [Architecture](docs/ARCHITECTURE.md), [Remote nodes](docs/REMOTE-NODES.md), and [Roadmap](docs/ROADMAP.md).

## License

MIT — see [LICENSE](LICENSE).

---

*In Zoroastrian tradition, the Chinvat Bridge is where deeds are weighed before crossing. Same idea, smaller stakes.*
