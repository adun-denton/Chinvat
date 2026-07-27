# Remote Node Management

Run a complete Chinvat hub on another machine—a GPU workstation, home server, or office computer—and expose it to your coordinator as another governed worker set. This is automation, not remote desktop.

## Model: federated hubs

Each machine keeps its own:

- module registry and credentials
- policy tiers
- job ledger and artifacts
- approval queue
- dashboard and event stream

The coordinator's `remote-node` worker is an MCP client to the node hub.

```text
coordinator hub                         remote node hub
┌────────────────────────┐              ┌────────────────────────┐
│ coordinator            │              │ system / ollama / apps │
│   └─ local Chinvat     │  private     │ local policy + ledger  │
│        └─ remote-node ├── mesh/MCP ─▶│ approvals + artifacts  │
└────────────────────────┘  + bearer    └────────────────────────┘
```

The remote hub's policy still governs the operation. Federation never converts a node into an agentless shell.

## 1. Put both machines on a private mesh

Do not port-forward port 7777 to the public internet. Use a WireGuard-based overlay such as Tailscale or Headscale. NetBird is a comparable alternative.

`remote-node` recognizes:

- loopback
- RFC1918 private IPv4 ranges
- Tailscale/Headscale `100.64.0.0/10`
- Tailscale IPv6 `fd7a:115c:a1e0::/48`
- `*.ts.net`

Plain HTTP is permitted only for loopback/private/mesh destinations. Public destinations require HTTPS unless `allowInsecureHttp` is explicitly enabled.

Restrict inbound TCP 7777 with the node firewall and mesh ACLs to the coordinator peers that need it.

## 2. Install and authenticate the node hub

On the node:

```powershell
git clone https://github.com/adun-denton/Chinvat.git
cd Chinvat
npm install
npm run build
```

Generate a token:

```powershell
node -e "console.log(require('crypto').randomBytes(32).toString('base64url'))"
```

Configure `data/chinvat.config.json`:

```json
{
  "port": 7777,
  "bind": "100.101.102.103",
  "authToken": "PASTE_GENERATED_TOKEN"
}
```

Bind to the node's mesh address, not `0.0.0.0`. A non-loopback bind without a token is a startup error, and a configured token shorter than 24 characters is rejected.

Environment overrides are available:

- `CHINVAT_BIND`
- `CHINVAT_AUTH_TOKEN`
- `CHINVAT_PORT`
- `CHINVAT_DATA_DIR`

`ConfigStore` loads once per process. Environment values are merged into the in-memory config; a later config save can persist them into JSON. Restart all hub processes after changing node auth/bind settings.

Start the hub and keep consequential modules—especially `system`—at `approve` until their exact workflows are tested.

The remote dashboard at the mesh URL prompts for the token. The same token gates `/mcp`, `/api`, and `/ws`.

## 3. Register the node on the coordinator

Configure the local `remote-node` module with a JSON array:

```json
[
  {
    "name": "gpu-us",
    "url": "http://100.101.102.103:7777/mcp",
    "token": "PASTE_THE_SAME_TOKEN",
    "note": "GPU media node"
  }
]
```

Fields:

- `nodes`: node array; treated as secret because it contains tokens
- `timeoutMs`: default 60000
- `allowInsecureHttp`: default false

Enable the module, keep its default `approve` tier, and run **Test connection**. Operation results never return node tokens.

## Operations

| Operation | Risk | Purpose |
|---|---|---|
| `nodes_list` | read | Configured nodes and transport classification; no network call |
| `node_health` | read | MCP handshake and node summary |
| `node_workers` | read | Remote modules, tiers, health, and operations |
| `node_capabilities` | read | Schemas and risks for a remote module |
| `node_invoke` | act | Invoke a remote read/act operation; refuses remote dangerous operations |
| `node_invoke_privileged` | dangerous | Invoke any remote operation; requires `confirm:"REMOTE_EXECUTE"` |
| `node_job_status` | read | Inspect one known remote job id |
| `node_job_result` | read | Retrieve one known remote result/artifacts |
| `node_job_cancel` | act | Cancel a remote job or deny one waiting for approval |

## Two-layer risk enforcement

`node_invoke` asks the node for the target operation's declared risk before submission. It refuses anything marked `dangerous`. Such operations require `node_invoke_privileged`, which is `dangerous` on the coordinator and requires an explicit confirmation string.

The node's own tier then applies. A privileged call to an `approve`-tier remote module can still park at `waiting_approval` on the node.

## Recommended invocation pattern

Discover first:

```json
{ "module": "remote-node", "operation": "node_workers", "args": { "node": "gpu-us" } }
```

Run a read operation:

```json
{
  "module": "remote-node",
  "operation": "node_invoke",
  "args": {
    "node": "gpu-us",
    "module": "ollama",
    "operation": "chat",
    "args": { "prompt": "summarize this text", "model": "qwen3" }
  }
}
```

Use async for long work and for anything that may wait for approval:

```json
{
  "module": "remote-node",
  "operation": "node_invoke",
  "args": {
    "node": "gpu-us",
    "module": "ollama",
    "operation": "pull_model",
    "args": { "model": "qwen3:32b" },
    "mode": "async"
  }
}
```

Keep the returned job id, poll with `node_job_status`, and collect with `node_job_result`.

## Current MVP limitations

### 008a — gated sync work can lose its job id

`node_invoke` defaults to sync. When the remote operation is `act` and its module is at `approve`, the remote job can wait longer than the local MCP client timeout. The local call then fails without preserving the useful remote job id.

**Until fixed:** explicitly use `mode:"async"` for remote non-read operations or any operation that may wait for approval.

### 008b — no remote job or approval listing

The coordinator can inspect only a known remote job id. There is no `node_jobs_list` or `node_approvals_list`, so a lost id is not recoverable through `remote-node`.

**Until fixed:** record every async job id and use the node dashboard for recovery.

### 008c — listener failure may not terminate the process

The HTTP server logs `EADDRINUSE` but may keep the process alive without a bound listener. A process-only supervisor can therefore report a false healthy state.

**Until fixed:** ensure only one HTTP hub owns the port and supervise a socket/health request, not only process existence.

## Windows deployment notes

- Clone directly into a user-owned directory. Do not clone into `C:\Windows\System32` and then move it; inherited ACLs can make SQLite read-only.
- Do not mix elevated and normal hub runs against the same checkout/data directory.
- A client-spawned stdio hub and the dashboard HTTP hub are separate processes. Restart both when they need new build/config state.
- Use a supervisor/service account that owns the repository and data files. Admin rights are normally required only for firewall configuration.

## Security notes

- The private mesh is the network perimeter; the bearer token is the hub credential. Use both.
- Prefer one token per node and rotate it after accidental disclosure.
- Tokens must be updated on the node and every coordinator entry, followed by process restart.
- `node_invoke_privileged` is remote code execution by design. Confirmation and approval are mitigations, not a sandbox.
- Do not feed untrusted content to a privileged agent.
- Agree with the machine owner on allowed workloads, data, power, and jurisdiction.
- For interactive desktop use, use RDP or Moonlight/Sunshine over the same mesh. Chinvat is the automation channel.
