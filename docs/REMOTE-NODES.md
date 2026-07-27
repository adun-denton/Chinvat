# Remote Node Management

A remote node is a complete Chinvat hub on another machine, addressed through the local `remote-node` worker. It is a governed automation channel, not a remote-desktop session and not an unstructured SSH proxy.

```text
coordinator machine                         remote node
┌────────────────────────┐                  ┌───────────────────────────┐
│ coordinator            │   private mesh   │ Chinvat hub :7777         │
│   └─ local Chinvat     │◀────────────────▶│   ├─ system               │
│        └─ remote-node  │   MCP + bearer   │   ├─ ollama / GPU tools   │
│                        │                  │   └─ its own policy/ledger │
└────────────────────────┘                  └───────────────────────────┘
```

Each node retains:

- its own enabled modules and credentials;
- its own risk tiers and approval queue;
- its own job database and artifacts;
- its own local filesystem fences;
- the ability to continue async work when the coordinator disconnects.

## 1. Put both machines on a private mesh

Do not port-forward `7777` to the public internet. Use a WireGuard-based overlay such as Tailscale or Headscale. NetBird is a comparable alternative.

`remote-node` classifies these as private transports:

- loopback;
- RFC1918 IPv4;
- Tailscale/Headscale `100.64.0.0/10`;
- Tailscale IPv6 `fd7a:115c:a1e0::/48`;
- `*.ts.net` names.

Plain HTTP is accepted only for those classes. Public hosts require HTTPS unless `allowInsecureHttp` is deliberately enabled. An off-box node must have a token.

Verify mesh reachability before configuring Chinvat:

```powershell
ping <node-mesh-address>
```

Restrict the node firewall to TCP `7777` from the mesh range or, preferably, the coordinator peer only.

## 2. Install and configure the node hub

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

In the node’s `data/chinvat.config.json`:

```json
{
  "port": 7777,
  "bind": "<node-mesh-address>",
  "authToken": "<strong-unique-token>"
}
```

Bind the mesh interface, not `0.0.0.0`. Chinvat refuses a non-loopback bind without a token and rejects tokens shorter than 24 characters.

Equivalent environment overlays:

```text
CHINVAT_BIND
CHINVAT_AUTH_TOKEN
CHINVAT_PORT
CHINVAT_DATA_DIR
```

Environment overlays can be persisted into JSON by a later config save; read [Configuration](CONFIGURATION.md#environment-overlays).

Start the hub and keep the node’s `system` worker at `approve` until exact operations are tested.

The node dashboard remains usable at its mesh URL. It prompts for the bearer token and stores it in that browser. `/mcp`, `/api`, and `/ws` are all gated.

## 3. Register the node on the coordinator

On the coordinator dashboard, open `remote-node` and configure `nodes`:

```json
[
  {
    "name": "gpu-node",
    "url": "http://<node-mesh-address>:7777/mcp",
    "token": "<same-token>",
    "note": "remote GPU workstation"
  }
]
```

Enable the module, keep tier `approve`, save, and run **Test connection**.

Tokens are stored in the coordinator’s local config and are never returned by operations. `nodes_list` reports only whether authentication is configured.

## Operations

| Operation | Risk | Purpose |
|---|---|---|
| `nodes_list` | read | Local configured-node inventory; no network call. |
| `node_health` | read | MCP reachability and node summary. |
| `node_workers` | read | Enabled workers, health, tiers, and operations. |
| `node_capabilities` | read | Schemas and declared risks for one remote worker. |
| `node_invoke` | act | Submit remote `read` or `act`; refuses remote `dangerous`. |
| `node_invoke_privileged` | dangerous | Submit any remote operation; requires `confirm:"REMOTE_EXECUTE"`. |
| `node_job_status` | read | Read one known remote job’s state/events. |
| `node_job_result` | read | Retrieve one known remote job’s result/artifacts. |
| `node_job_cancel` | act | Cancel or deny one known remote job. |

## Risk does not disappear through the proxy

Before `node_invoke` submits work, it asks the node for the target operation’s declared risk. Remote `dangerous` operations are refused.

`node_invoke_privileged` is itself `dangerous` on the coordinator, requires the explicit confirmation string, and then submits to the node. The node’s own tier still applies, so the work may also stop at the remote approval queue.

This is deliberate double governance, not duplication.

## Recommended call pattern

Discover first:

```json
{
  "module": "remote-node",
  "operation": "node_workers",
  "args": { "node": "gpu-node" }
}
```

Read-only remote work can use sync:

```json
{
  "module": "remote-node",
  "operation": "node_invoke",
  "args": {
    "node": "gpu-node",
    "module": "ollama",
    "operation": "chat",
    "args": { "model": "qwen3", "prompt": "Summarize this text" },
    "mode": "sync"
  }
}
```

Long or approval-prone work should use async:

```json
{
  "module": "remote-node",
  "operation": "node_invoke",
  "args": {
    "node": "gpu-node",
    "module": "ollama",
    "operation": "pull_model",
    "args": { "model": "qwen3:32b" },
    "mode": "async"
  }
}
```

Preserve the returned remote job id, then use `node_job_status` and `node_job_result`.

## Current limitations

These are shipped defects/backlog, not configuration mistakes:

1. **Sync waits can lose approval-prone job ids.** A remote `act`/`dangerous` call may stop at `waiting_approval`; the local sync wait can exceed the MCP client timeout before the id reaches the coordinator. Until fixed, use async for every non-read operation that might be gated.
2. **No remote job or approval listing.** Only status/result/cancel by known id exist. A lost id is not recoverable through `remote-node` today.
3. **`EADDRINUSE` does not exit the hub process.** The HTTP server logs the bind error but the process remains alive without a listener. Supervisors must verify the port, not only process liveness, until the process exits non-zero on listen failure.
4. **No top-level network Settings panel.** `bind`, `port`, and `authToken` are JSON/environment settings.
5. **No live ConfigStore reload.** Restart any separate stdio hub after changing its shared config.

## Windows deployment notes

- Do not clone into `C:\Windows\System32`. An elevated shell starts there and inherited ACLs can make SQLite/config unwritable after moving the tree.
- Do not mix elevated and normal hub runs against one tree; created files can become inaccessible to the normal process.
- A simple logon launcher is acceptable for a personal node, but monitor both process and port. A service/supervisor should restart on non-zero exit once the `EADDRINUSE` defect is fixed.
- Keep logs under the Chinvat data/tree, rotate them, and never print bearer tokens.
- Tailscale may connect before or after a logon script depending on host state; verify actual bind success rather than assuming startup order.

## Security and operations

- The mesh is the perimeter, not the sole control. Use peer ACLs and the hub token together.
- Use one token per node. Rotate any token pasted into chat, logs, tickets, or shell history.
- Rotation requires updating the node `authToken`, updating every coordinator’s node entry, and restarting affected hub processes.
- Restrict `system.allowedRoots`; do not grant full disk merely because the machine is remote.
- Do not feed untrusted content to an agent able to use `node_invoke_privileged`.
- The machine remains subject to its owner, network, power, and jurisdiction. Agree on permitted workloads.
- For interactive desktop access, use RDP or Sunshine/Moonlight over the same private mesh. Chinvat is the automation channel.
