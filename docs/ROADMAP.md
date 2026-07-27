# Roadmap

This file separates shipped state from immediate defects and future direction. For current implementation details, use [Architecture](ARCHITECTURE.md) and [Modules](MODULES.md).

## Shipped foundation

- MCP hub over stdio and Streamable HTTP with seven tools.
- Durable SQLite jobs, parent/child lineage, events, artifacts, cancellation, recovery, and dashboard/Telegram approvals.
- Risk (`read` / `act` / `dangerous`) × tier (`observe` / `approve` / `autonomous`) policy.
- Dashboard, REST, WebSocket, and safe coordinator Connect flow.
- Bearer authentication for `/mcp`, `/api`, and `/ws`; fail-closed non-loopback bind policy.
- Read-only allowlisted `adapter_invoke {ephemeral:true}` with zero persistence.
- External module loading from `modules/`.

## Shipped workers — 20

### Models

- `ollama`
- `openrouter`, including pinned live-ZDR `private_chat`
- `openai-compatible`

### Machine, infrastructure, and federation

- `system`, including multi-root fencing and repaired Windows spawn environments
- `coolify`
- `remote-node`

### Publishing and commerce

- `wordpress` core REST adapter `0.4.0`
- Chinvat WP Bridge `0.4.3`, with 18 Abilities and schema-4 handshake
- `woocommerce`, with 144 fixed guarded operations

### Local applications

- `blender`
- `orca`
- `gimp`
- `rhino`

### Messaging and social

- `telegram`
- `whatsapp`
- `facebook`
- `instagram`
- `linkedin`
- `x`
- `gmail`

### Governed relay

- `chat-relay`: repository packet, classification/secret firewall, verified import, disposable-worktree validation, guarded live apply

## Immediate reliability work

### Remote Node Management

1. **Async fallback for gated remote operations.** Automatically switch to async when remote declared risk is not `read`, so approval waits cannot consume the client timeout and hide the remote job id.
2. **Remote inventory.** Add `node_jobs_list` and `node_approvals_list` so work remains discoverable after coordinator interruption.
3. **Exit on HTTP listen failure.** `EADDRINUSE` and other listener errors must terminate non-zero so supervisors detect failure.
4. **Top-level Settings UI.** Add safe editing for `bind`, `port`, and `authToken`, including token-change handoff behavior.
5. **Config reload strategy.** Decide between explicit reload/restart UX and a safe watched ConfigStore; do not leave multiple hub processes silently divergent.

### Remote GPU/media node

- Verify Ollama service/model inventory on the deployed GPU node.
- Record driver, VRAM, and runtime compatibility through `nvidia-smi`.
- Add a ComfyUI worker, most likely as an HTTP app bridge that respects ComfyUI’s own queue rather than wrapping it as shell commands.
- Define artifact transfer and bounded workflow submission for remote media jobs.

## Browser automation direction

The WP-00 spike supports **proceed, reduced**:

- build platform adapters over Playwright;
- use stable platform entity ids, never positional DOM paths for consequential actions;
- bind approvals to exact proposal fields and both value/shape digests;
- make coverage/reconciliation a blocking criterion;
- use deterministic verification before model-based audit;
- keep a tamper-evident ledger.

Do not build a custom general browser-driver protocol yet. Complete Track A on headed Windows before locking the connection model. Spike code remains disposable.

## WordPress next slices

- Export/snapshot-on-approval: read verified DB overrides, write child-theme files, commit to the site repository, then reset DB overrides so files become authoritative.
- Cache purge and post-write coherence operations.
- Named site targets once the registry supports multiple instances.
- Revisions and safer rollback surfaces.
- Separately gated file-write and WP-CLI lanes.
- RankMath sitewide controls and complete plugin install/update/delete.

## Routing and durable objectives

- `module:"auto"` using task type, capability, availability, cost, latency, context, and historical success.
- Named OpenAI-compatible instances (`nvidia`, `groq`, `together`, `lmstudio`, `vllm`, …).
- Persistent objectives that accumulate child work across restarts.
- Scheduled/event triggers.
- Artifact browser and rerun-with-edited-args UI.

## Multi-user and hosted deployment

- Hosted recipes over TLS through a reverse proxy or private tunnel.
- OIDC after bearer tokens.
- User roles mapped to module/operation/risk ceilings.
- Approval routing by role and ownership.
- Fleet dashboard over several federated hubs.
- Audit export and retention policies.

## Local-app backlog

- Orca: `analyze_gcode`, profile clone, bounded profile patch.
- GIMP: structured edit operations beyond arbitrary Python.
- Rhino: structured modeling and Grasshopper operations; re-evaluate official McNeel transport when release maturity improves.
- ComfyUI: HTTP/queue adapter and artifact flow.

Known Orca limitation: stock OrcaSlicer on Windows is not headless-capable. Continue using a CLI-capable Orca-lineage executable through the adapter.

## Standing chores

- Track MCP SDK/spec changes and update transports deliberately.
- Keep coordinator configuration schemas current.
- Keep module counts and built-in lists generated or test-checked where possible.
- Treat documentation consistency as part of definition of done for every module/auth/transport change.
- Keep specialist design documents linked from the documentation index.
