# Architecture

## Process model

A Chinvat process owns one `Hub` singleton: config, SQLite, registry, jobs, policy, artifacts, and events. The normal process serves the dashboard, REST `/api`, WebSocket `/ws`, and MCP Streamable HTTP `/mcp`. A coordinator may instead spawn a stdio process with `--stdio`.

```text
index.ts
  └─ Hub
      ├─ ConfigStore
      ├─ SQLite DB
      ├─ Registry: 20 built-ins + external modules
      ├─ JobEngine + Policy
      ├─ ArtifactStore + EventBus
      ├─ MCP stdio / Streamable HTTP
      └─ REST / WebSocket / dashboard
```

Flags:

- `--stdio` — attach MCP stdio.
- `--port <n>` — override the HTTP port for this launch.
- `--http` — allow HTTP alongside stdio.
- `--no-http` — suppress HTTP.

A stdio launch does not start HTTP unless explicitly requested. This prevents a client-spawned process from racing the dashboard process for port `7777`.

## Core components

| File | Responsibility |
|---|---|
| `hub/src/index.ts` | boot, transport selection, bind-policy check, signals |
| `hub/src/hub.ts` | composition root and built-in registration |
| `hub/src/config.ts` | config defaults, environment overlays, persistence |
| `hub/src/auth.ts` | bearer authorization and fail-closed bind policy |
| `hub/src/db.ts` | SQLite bootstrap and migrations |
| `hub/src/jobs.ts` | queue, lifecycle, approvals, cancellation, recovery |
| `hub/src/policy.ts` | risk × tier decision |
| `hub/src/registry.ts` | built-ins, external modules, health cache, contexts |
| `hub/src/mcp.ts` | seven MCP tools over stdio/HTTP |
| `hub/src/api.ts` | REST, dashboard, WebSocket upgrade and auth |
| `hub/src/connect.ts` | client detection, snippets, safe config merge/backup |
| `hub/src/artifacts.ts` | job artifacts under `data/artifacts/<jobId>/` |
| `hub/src/events.ts` | typed pub/sub for WS and adapter hooks |

## Adapter contract

```ts
interface ChinvatAdapter {
  name: string;
  version: string;
  description: string;
  configSchema: FieldSpec[];
  activation?: ActivationSpec;
  capabilities(): OperationSpec[];
  health(ctx: AdapterContext): Promise<HealthStatus>;
  invoke(operation: string, args: unknown, ctx: AdapterContext): Promise<InvokeResult>;
  cancel?(jobId: string): Promise<void>;
  onBoot?(ctx: AdapterBootContext): void | Promise<void>;
}
```

Each capability declares a JSON-like parameter schema and one fixed risk:

- `read` — no intended external side effect.
- `act` — reversible or bounded mutation/egress.
- `dangerous` — shell/code execution, destructive change, money-bearing action, mass send, or live-branch mutation.

The registry loads these 20 built-ins:

```text
ollama openrouter system telegram wordpress woocommerce whatsapp facebook
instagram linkedin x openai-compatible blender orca gimp rhino coolify
gmail chat-relay remote-node
```

External modules are discovered from `modules/<name>/index.mjs|index.js` at boot and default to tier `approve`.

## Configuration model

Top-level config:

```ts
{
  port,
  bind,
  authToken,
  concurrencyPerModule,
  syncWaitMsDefault,
  syncWaitMsMax,
  ephemeralModules,
  modules: {
    [name]: { enabled, tier, config }
  }
}
```

`ConfigStore` reads once per process. It does not watch the file. A dashboard HTTP process and a coordinator-spawned stdio process can therefore hold different in-memory snapshots of the same JSON file until restarted.

Environment overlays: `CHINVAT_PORT`, `CHINVAT_DATA_DIR`, `CHINVAT_BIND`, `CHINVAT_AUTH_TOKEN`. Overlaid values live in the in-memory config; a later save can persist them into the JSON file.

## Authentication and transport boundary

Local default: `bind = 127.0.0.1`, empty token, no authentication prompt.

Before opening an HTTP socket, `assertBindPolicy()` enforces:

- a non-loopback bind requires a token;
- tokens must be at least 24 characters;
- a configured token gates `/mcp`, `/api`, and `/ws` even on loopback.

HTTP clients send `Authorization: Bearer <token>`. Browser WebSockets may use `?token=` because the browser API cannot set arbitrary upgrade headers; an authorization header takes precedence where available. `GET /auth/required` is intentionally unauthenticated and exposes only whether a prompt is needed.

The dashboard stores its entered token in browser local storage and can forget it from the sidebar. The Connect flow embeds the token in generated client configuration.

## Job and policy lifecycle

```text
tasks_submit / POST /jobs
        │
        ▼
policy(risk, tier)
  ├─ reject    → failed(policy_rejected)
  ├─ approval  → waiting_approval → queued | cancelled
  └─ run       → queued
                    ▼
                  running
                    ▼
          succeeded | failed | cancelled
```

`mode:"sync"` holds the caller until terminal state or timeout. `mode:"async"` returns a job id immediately. Parent/child lineage uses `parent_id`.

On restart, interrupted running jobs are marked failed and queued work can be dispatched again. Per-module concurrency is configured globally.

SQLite tables:

```text
jobs
job_events
approvals
```

Every transition and adapter log becomes a job event. Artifacts live outside SQLite and are referenced from results.

## Ephemeral invocation

`adapter_invoke {ephemeral:true}` is a separate execution path for sensitive read-only calls:

- only `read` operations;
- only modules in `ephemeralModules` (default `['ollama']`);
- synchronous only;
- no job, event, result, log, or artifact persistence.

It fails closed if any condition is not met. Ollama forwards `think` and `format`—including JSON Schema objects—without mutating them.

## System worker boundary

The system worker supports `allowedRoots` (array or semicolon/comma-delimited string) with legacy `allowedRoot` fallback. Relative paths resolve under the first root; `allowFullAccess` explicitly disables fencing.

Windows MCP launchers may supply a stripped environment. Before spawning, the adapter repairs executable classification (`PATHEXT`) and `ComSpec`; health performs a real child-process stdout probe so detached/no-output false success is rejected.

## Remote federation

`remote-node` is an MCP client to complete Chinvat hubs. Each node keeps its own policy, approvals, modules, and ledger.

Transport rules:

- plain HTTP only to loopback, RFC1918, Tailscale/Headscale `100.64.0.0/10`, `fd7a:115c:a1e0::/48`, or `*.ts.net`;
- public hosts require HTTPS unless explicitly overridden;
- off-box nodes require a token;
- credentials embedded in URLs are refused.

Risk is resolved from the remote operation before submission. Normal `node_invoke` refuses remote `dangerous`; `node_invoke_privileged` is dangerous locally and requires `confirm:"REMOTE_EXECUTE"`. The remote tier still applies.

Current limitations are documented in [Remote Nodes](REMOTE-NODES.md): approval-prone calls should use async, remote jobs cannot yet be listed, and `EADDRINUSE` does not yet terminate the HTTP process.

## Mail Relay

The coding relay is split deliberately:

```text
repo-packet        compile minimal evidence + secret/classification firewall
relay-envelope     TASK_ID + PACKET_SHA + BASE_COMMIT wire verification
relay-worktree     disposable validation and guarded live apply
chat-relay         lifecycle and policy mapping
gmail              optional OAuth2 transport carrier
```

An imported reply is inert. Validation runs only in a disposable Git worktree; live application is the sole `dangerous` mutation. Mail is one transport beside clipboard and file. See [Mail Relay design](DESIGN-mail-relay.md).

## Local-app bridges

Blender and GIMP use the shared raw JSON loopback socket transport. Rhino uses framed JSON over loopback. Orca is a process-spawn adapter and does not use the socket helper. Script execution is separately opt-in and `dangerous`; read-tier PNG snapshots are stored as artifacts for a vision-capable coordinator.

See [Local-app bridge design](DESIGN-local-app-bridges.md).

## WordPress and WooCommerce

The `wordpress` adapter combines core REST operations with a fixed mapping to the optional Chinvat WP Bridge. The bridge exposes authenticated, capability-checked theme/options/RankMath/plugin and DB-layer operations. Dangerous theme writes remain remote code execution by design and are protected by plugin toggles, linting, path confinement, policy, and backups—not made intrinsically safe.

`woocommerce` is a separate worker with 144 fixed operations and no raw-request escape hatch. It validates the target before credentials are attached, supports dry-run on writes, captures before-state, and requires additional confirmation for irreversible/financial/system operations.

The complete operational details belong in [Modules](MODULES.md) and the [plugin README](../wp-plugin/chinvat-bridge/README.md), not duplicated here.

## Browser automation evidence boundary

`spike/wp-00/` and [its report](spike/WP-00-REPORT.md) are disposable evidence. Measured results support a reduced direction: platform adapters and a governed data plane on Playwright, entity-stable references, separate value/shape digests, coverage accounting, deterministic verification, and a hash-chained ledger. They do not justify a custom general browser-driver protocol, and spike code must not be imported into product packages.

## Security posture

- Local-only and untokened is the default.
- Remote exposure is opt-in, tokened, and intended for a private mesh.
- Policy gates are additional controls; provider permissions and host security still apply.
- Confirmation strings, linting, path fences, and dry-runs are mitigations, not sandboxes.
- Secrets are stored locally and sent only to their configured service.
- The hub is an admin tool. Do not expose privileged modules to untrusted callers or feed untrusted content to agents with write/code-execution authority.
