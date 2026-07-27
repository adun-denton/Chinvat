# Architecture

## 1. System model

Chinvat is a governed MCP labor hub. One hub process owns a module registry, durable jobs, policy decisions, approvals, artifacts, and several control surfaces. A coordinator plans and delegates; Chinvat executes and records.

A machine may run more than one process—for example, a normal HTTP/dashboard hub and a Claude Desktop-spawned stdio hub. Those processes do not share memory even when they read the same configuration file.

```text
coordinator ── MCP ──▶ Hub
                       ├─ registry: 20 built-ins + external modules
                       ├─ policy: risk × tier
                       ├─ durable job engine + approvals + artifacts
                       ├─ REST API + dashboard + WebSocket events
                       └─ workers: models, system, apps, publishing, relay, remote hubs
```

## 2. Process and transport model

Entry point: `hub/dist/index.js`.

Flags:

- `--stdio`: attach MCP stdio.
- `--http`: serve HTTP even when stdio is active.
- `--port <n>`: override the HTTP port and imply explicit HTTP.
- `--no-http`: disable HTTP.

A normal run serves:

- dashboard at `/`
- REST under `/api`
- WebSocket events at `/ws`
- MCP Streamable HTTP at `/mcp`
- unauthenticated auth requirement probe at `/auth/required`

A stdio-spawned process does not bind port 7777 unless HTTP was explicitly requested. This prevents every desktop client from competing with the dashboard daemon for the same socket.

## 3. Composition root

```text
index.ts       boot, flags, bind policy, transports, shutdown
hub.ts         constructs the singleton and registers built-ins
config.ts      JSON config + environment overrides
                (loaded once per process)
auth.ts        one authorization decision for HTTP, MCP, REST, and WS
registry.ts    built-ins, external modules, health cache
policy.ts      read|act|dangerous × observe|approve|autonomous
jobs.ts        persistence, queues, concurrency, approvals, recovery
mcp.ts         seven MCP tools and stdio/HTTP bindings
api.ts         dashboard, REST, WebSocket upgrade, connect routes
connect.ts     coordinator config generation, merge, backup, endpoint test
artifacts.ts   bounded job artifacts under data/artifacts/
events.ts      typed event bus feeding WS and adapter hooks
```

Major shared libraries include local-app socket transport, guarded target validation, Mail Relay packet/envelope/worktree layers, and WordPress/WooCommerce helpers.

## 4. Adapter contract

Each module implements `ChinvatAdapter`:

```ts
interface ChinvatAdapter {
  name: string;
  version: string;
  description: string;
  configSchema: FieldSpec[];
  activation?: ActivationSpec;
  capabilities(): OperationSpec[];
  health(ctx: AdapterContext): Promise<HealthStatus>;
  invoke(operation: string, args: Record<string, unknown>, ctx: AdapterContext): Promise<InvokeResult>;
  cancel?(jobId: string): Promise<void>;
  onBoot?(ctx: AdapterBootContext): void | Promise<void>;
}
```

Every operation declares a schema and a risk. The registry materializes default module settings, caches health briefly, and loads external modules from `modules/<name>/index.mjs|index.js` at boot.

## 5. Built-in worker families

The current 20 built-ins are:

- Models: `ollama`, `openrouter`, `openai-compatible`
- Machine/infrastructure: `system`, `coolify`, `remote-node`
- Local apps: `blender`, `orca`, `gimp`, `rhino`
- Publishing/commerce: `wordpress`, `woocommerce`
- Messaging/social: `telegram`, `whatsapp`, `facebook`, `instagram`, `linkedin`, `x`
- Relay: `gmail`, `chat-relay`

The complete operation reference belongs in `MODULES.md`; subsystem-specific mechanics belong in `DESIGN-*.md` or the relevant app/plugin setup guide.

## 6. Job and policy lifecycle

```text
tasks_submit ──▶ persist job ──▶ policy.decide
   ├─ reject     → failed(policy_rejected)
   ├─ approval   → waiting_approval ── approve ──▶ queued
   │                                  └─ deny ───▶ cancelled
   └─ run        → queued ── dispatcher ──▶ running ──▶ succeeded|failed|cancelled
```

Risk levels:

- `read`: no intended external mutation.
- `act`: bounded/reversible external or local mutation.
- `dangerous`: shell/code execution, destructive operations, money, publication, or high-consequence changes.

Tiers:

- `observe`: read runs; higher risks reject.
- `approve`: read runs; higher risks wait for approval.
- `autonomous`: all declared operations run and remain logged.

`mode:"sync"` waits for a terminal result up to the configured limit. `mode:"async"` returns a job id immediately. Parent/child lineage is stored through `parent_id`.

`adapter_invoke` is a direct synchronous path. `ephemeral:true` is allowed only for read-risk operations in `ephemeralModules`; it intentionally creates no job, event, log, result, or artifact persistence.

## 7. Authentication and bind policy

Loopback remains zero-config. Remote exposure is fail-closed:

- `bind` defaults to `127.0.0.1`.
- A non-loopback bind requires an `authToken` of at least 24 characters before any socket is opened.
- `/mcp`, `/api`, and `/ws` use the same authorization procedure.
- HTTP uses a bearer header. Browser WebSockets may carry `?token=` because the browser API cannot set an authorization header.
- The dashboard stores the supplied token only in that browser's local storage and can forget it.

The bearer token authenticates access to one hub. It is not multi-user authorization and does not assign per-user risk ceilings; that remains roadmap work.

## 8. Federated hubs

`remote-node` makes another complete Chinvat hub appear as a worker. Federation does not merge state:

```text
coordinator hub ── remote-node/MCP ──▶ node hub
local policy                              remote policy
local proxy job                           remote job + approval + artifacts
```

Transport policy permits plain HTTP only to loopback, RFC1918, Tailscale/Headscale mesh ranges, and `*.ts.net`; public targets require HTTPS unless an explicit insecure override is set. Off-box nodes require tokens.

Risk is not laundered. Normal remote invocation first resolves the remote operation risk and refuses `dangerous`; privileged invocation is itself `dangerous`, requires `confirm:"REMOTE_EXECUTE"`, and is still subject to the node's own tier.

See `REMOTE-NODES.md` for deployment and current MVP limitations.

## 9. Human-gated coding relay

`chat-relay` compiles a repository state into a bounded provider-neutral packet, runs a secret/classification firewall, and binds responses to `TASK_ID`, `PACKET_SHA`, and `BASE_COMMIT`.

```text
compile → dispatch(mail|clipboard|file) → import inert reply
        → validate in disposable worktree → apply to live branch behind danger gate
```

The relay owns lifecycle state but no mail transport. `gmail` is a separate carrier composed by the coordinator. Imported replies do not execute; validation runs only in a disposable worktree, and `relay_apply` is the sole live-branch mutation.

See `DESIGN-mail-relay.md` and `app-bridges/gmail/SETUP.md`.

## 10. Local-app bridges

Blender, GIMP, and Rhino use loopback socket bridges with separate app-side activation. Orca uses a pinned CLI process and intentionally exposes no printer-control surface. Visual workers can return PNG artifacts for a vision-capable coordinator; Chinvat itself does not perform vision.

Scripting operations are code execution by design and require both a module-specific opt-in and normal policy approval. See `DESIGN-local-app-bridges.md`.

## 11. Browser-automation direction

WP-00 measured that platform/entity adapters provide the durable advantage: stable identity, consequence-aware proposals, coverage accounting, compact records, and reconstructable audits. A generic positional DOM path silently selected the wrong entity after routine virtualized-grid movement, while adapter entity ids failed safely.

The accepted direction is therefore:

- direct Playwright foundation
- platform adapters with declared identity/extraction schemas and known-unknowns
- governed proposal/approval/verification/ledger layers
- paired value and shape digests
- explicit coverage accounting

A custom browser driver protocol is not justified by the current evidence. The spike under `spike/wp-00/` is disposable and must not be imported into production packages.

## 12. Configuration lifecycle

`data/chinvat.config.json` is human-editable and git-ignored. The in-memory config is loaded once at process construction. Environment overrides are merged into that in-memory object; a later save serializes the whole object, so a one-off environment override can become persistent.

Operational consequence: after editing config outside a process, restart the normal HTTP hub and every client-spawned stdio hub that must see the change.

## 13. Data model

```text
jobs(id, parent_id, module, operation, args_json, status, mode,
     result_json, error, created_at, started_at, finished_at, source)
job_events(id, job_id, ts, kind, data_json)
approvals(id, job_id, requested_at, decided_at, decision, decided_via)
```

Artifacts live under `data/artifacts/<jobId>/`. Relay lifecycle files live under `data/relay/<taskId>/`.

## 14. Known architectural limitations

- Auth is one bearer token per hub, not per-user authorization.
- Config does not hot-reload.
- Remote job/approval listing is not yet exposed through `remote-node`.
- Gated remote work should be submitted async until sync handoff preserves job ids.
- An HTTP listen error such as `EADDRINUSE` is not yet guaranteed to terminate the process non-zero.
- Fleet UI, objectives, scheduling, automatic routing, and hosted deployment remain separate slices.
