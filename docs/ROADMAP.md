# Roadmap

This file is future-facing. Shipped behavior belongs in the reference and architecture documents; it is summarized here only to establish the starting point.

## Shipped foundation

- Governed MCP hub with durable jobs, parent/child lineage, approvals, artifacts, dashboard, REST, WebSocket events, stdio, and Streamable HTTP.
- Safe coordinator connection workflow for Codex, Claude Code/Desktop, Cursor, Hermes, and generic clients.
- Twenty built-in workers across models, system/infrastructure, local apps, WordPress/WooCommerce, messaging/social, Gmail/relay, and remote hubs.
- Bearer authentication, dashboard unlock, WebSocket auth, and fail-closed non-loopback binding.
- Federated remote hubs through `remote-node` with transport constraints and anti-risk-laundering privileged invocation.
- Mail Relay with packet classification/secret firewall, bound response envelope, disposable-worktree validation, and gated live apply.
- Local-app bridges for Blender, GIMP, Rhino, and Orca.
- WordPress Bridge 0.4.3, TypeScript WordPress adapter 0.4.0, and guarded WooCommerce fixed-operation worker.
- Ephemeral read-only adapter invocation and hardened private OpenRouter routing.
- WP-00 browser spike: adapter/data-plane direction supported; custom browser driver protocol rejected for now.

## Immediate: remote-node reliability

- **008a:** prevent sync timeout from losing the remote job id when the node parks at `waiting_approval`; default non-read remote work to async or return identity before waiting.
- **008b:** add `node_jobs_list` and `node_approvals_list` (or equivalent recovery surfaces).
- **008c:** exit non-zero on HTTP listen failure such as `EADDRINUSE`.
- Add safe hub Settings controls for `authToken`, `bind`, and `port`.
- Define explicit config reload behavior across HTTP and stdio hub processes.
- Add fleet-level node/job visibility after the recovery primitives exist.

## Next: remote GPU and media engine

- Verify Ollama and NVIDIA runtime on the deployed GPU node.
- Add ComfyUI as a governed HTTP/queue adapter with async jobs, progress, artifacts, cancellation, and health.
- Add reproducible Windows service/supervisor recipes for remote nodes.
- Define bounded artifact transfer between hubs.

## Browser automation and data plane

- Execute WP-00 Track A on the intended Windows/headed environment.
- Build direct Playwright runtime behind a platform-adapter boundary.
- Implement stable entity refs, known-unknown declarations, coverage accounting, paired value/shape digests, consequence-bound proposals, approvals, deterministic verification, and tamper-evident ledger.
- Start with one read-only Meta/platform adapter.
- Defer recipe compiler and broad write automation until the first adapter proves the data plane.
- Do not build a custom CBP/browser driver protocol unless later evidence shows a durable advantage.

## Routing and orchestration

- `module:"auto"` with explainable selection by task, privacy, price, latency, context, availability, and observed success.
- Named OpenAI-compatible instances (`nvidia`, `groq`, `together`, `lmstudio`, `vllm`, etc.).
- Persistent objectives and child-result accumulation.
- Scheduled and webhook/event-triggered jobs.
- Artifact browser and job re-run/edit flows.

## Agent Plugins compatibility

- Evaluate the Agent Plugins packaging standard as an import/compatibility layer rather than a replacement for Chinvat governance.
- Map portable plugin manifests, skills, and MCP declarations onto Chinvat capability discovery, modules, policy tiers, approvals, and job lineage.
- Define a clean boundary between portable standard behavior and Chinvat-specific extensions such as routing, bridges, event exhaust, human gates, and Familiar-facing events.
- Decide whether Chinvat should load Agent Plugins directly, translate them into module adapters, or support both paths.
- Validate one representative plugin end to end before locking the relevant MVP/integration architecture.

## Publishing and commerce

- WordPress export/snapshot-on-approval: materialize verified DB overrides into child-theme files, commit them, then reset overrides so files become authoritative.
- Cache purge, named site targets, revisions/coherence operations, and separately gated file-write/WP-CLI.
- RankMath sitewide controls and guarded plugin install/update/delete.
- Editorial preview/review workflows and structured Gutenberg operations.

## Local-app backlog

- Orca: G-code analysis plus bounded profile clone/patch.
- GIMP: structured edit operations beyond Python.
- Rhino: structured modeling and Grasshopper operations; re-evaluate official McNeel backend when released.
- Blender: expand structured operations where they reduce reliance on arbitrary Python.

## Hosted and multi-user

- TLS/reverse-proxy/tunnel deployment recipes.
- OIDC identity and per-user authorization mapped to module, operation, and risk ceiling.
- Approval routing by role.
- Multi-hub fleet dashboard.
- Audit export, retention, and redaction policy.
- Signed installable module packages/marketplace format.

## Standing chores

- Track MCP SDK/spec changes and client configuration formats.
- Keep the built-in module count synchronized across registry, smoke tests, README, modules guide, architecture, and agent handover.
- Keep documentation layers separated according to `docs/README.md`.
- Add modules by demonstrated demand; prefer narrow fixed-operation surfaces over raw APIs.
