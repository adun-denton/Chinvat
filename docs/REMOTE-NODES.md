# Remote Node Management

Run a Chinvat hub on a machine you do not sit in front of — a GPU box in another
country, a home server, a workstation at the office — and drive it from your own
coordinator as one more set of workers.

## The model: federated hubs, not a remote shell

Each remote machine runs its **own complete hub**. It keeps its own modules, its
own policy tiers, its own approval queue and its own job ledger. Your local
`remote-node` module is an MCP client to those hubs.

That matters for three reasons:

- The remote machine stays governed by its own rules. A `dangerous` operation
  there still stops at *its* approval gate, not only yours.
- Work continues when your machine is off. Submit `async`, close the laptop,
  collect the result tomorrow.
- The GPU box can run its own local models (`ollama`, `openai-compatible` against
  a local vLLM or LM Studio) and act as a media engine, without shipping payloads
  back and forth for every step.

```text
your machine                          remote node (e.g. the 5070 box)
┌───────────────────────┐             ┌──────────────────────────────┐
│ Claude / Codex        │             │ chinvat hub :7777            │
│   └─ chinvat hub      │  mesh VPN   │   ├─ system  (approve)       │
│        └─ remote-node │◀──────────▶ │   ├─ ollama  (autonomous)    │
│                       │  MCP/HTTP   │   └─ …                       │
└───────────────────────┘  + bearer   └──────────────────────────────┘
```

## Step 1 — put both machines on a private mesh

Do **not** port-forward `7777` to the internet. Use a WireGuard-based overlay so
the link is encrypted and the hub is never publicly routable.

- **Tailscale** is the least-effort option. Install on both machines, sign in,
  done. Each host gets a stable `100.64.0.0/10` address and a `*.ts.net` name.
- **Headscale** is the self-hosted control plane if you cannot rely on
  Tailscale's coordination servers or its OAuth sign-in from your network. It
  hands out the same address space, so everything below is identical. If you
  already run Coolify, that is a reasonable place to host it.
- **NetBird** is a comparable self-hostable alternative.

Verify from your machine before going further:

```powershell
ping 100.101.102.103          # the node's mesh address
```

`remote-node` recognises mesh addresses (`100.64.0.0/10`,
`fd7a:115c:a1e0::/48`, `*.ts.net`) and private RFC1918 ranges, and allows plain
`http` to them. A **public** host requires `https`; the `allowInsecureHttp`
override exists but is almost never the right answer.

## Step 2 — install and token the hub on the node

On the remote machine:

```powershell
git clone https://github.com/adun-denton/Chinvat.git
cd Chinvat
npm install
npm run build
```

Generate a token and write the node's config:

```powershell
node -e "console.log(require('crypto').randomBytes(32).toString('base64url'))"
```

In `data/chinvat.config.json` on the node:

```json
{
  "port": 7777,
  "bind": "100.101.102.103",
  "authToken": "PASTE_THE_GENERATED_TOKEN"
}
```

Bind to the **mesh address**, not `0.0.0.0`. Binding to the mesh interface means
the listener does not exist on the node's LAN or its ISP-facing interface at all.

The hub now **refuses to start** on a non-loopback bind without a token, and
refuses any token under 24 characters. That is deliberate: `system.run_command`
is a `dangerous` operation, and an untokened off-box hub would publish it to
whatever can reach the port. Both `/mcp` and `/api` require the bearer token.

Environment overrides are available if you prefer not to edit the file:
`CHINVAT_BIND`, `CHINVAT_AUTH_TOKEN`, `CHINVAT_PORT`, `CHINVAT_DATA_DIR`.

Start it, and keep the node's own tiers conservative — leave `system` at
**approve** unless you have a specific reason not to.

The node's own dashboard stays usable: opening `http://100.101.102.103:7777`
prompts for the token once and remembers it in that browser. The live event
stream at `/ws` is gated the same way, since it carries job arguments and
results.

## Step 3 — register the node on your machine

On your machine, open the dashboard, find the **remote-node** card, and set
`nodes` to a JSON array:

```json
[
  {
    "name": "gpu-us",
    "url": "http://100.101.102.103:7777/mcp",
    "token": "PASTE_THE_SAME_TOKEN",
    "note": "5070 box — media engine"
  }
]
```

Enable the module and select **Test connection**. Health reports how many nodes
answered. Tokens are stored locally in `data/chinvat.config.json` and are never
returned by any operation — `nodes_list` shows `authenticated: true` and nothing
more.

## Operations

| Operation | Risk | What it does |
| --- | --- | --- |
| `nodes_list` | read | Configured nodes and their transport classification. No network call. |
| `node_health` | read | Handshake: reachability, hub build, enabled workers. |
| `node_workers` | read | The node's full module list with health, tier and operations. |
| `node_capabilities` | read | Operation schemas for one module on the node. |
| `node_invoke` | act | Run a remote `read` or `act` operation. |
| `node_invoke_privileged` | dangerous | Run any remote operation, including `dangerous` ones. Requires `confirm:"REMOTE_EXECUTE"`. |
| `node_job_status` | read | Status, timing and recent events for a remote job. |
| `node_job_result` | read | Final result and artifacts for a remote job. |
| `node_job_cancel` | act | Cancel a remote job, or deny one waiting for approval there. |

### Why there are two invoke operations

Proxying must not launder risk. If a single `act` operation could reach
`system.run_command` on the node, the local `act` gate would silently stand in
for a `dangerous` one.

So `node_invoke` asks the node for the operation's declared risk **before**
submitting, and refuses anything the node marks `dangerous`. Reaching those
requires `node_invoke_privileged`, which is `dangerous` locally *and* demands an
explicit confirm string. The node's own tier still applies on top: a remote
`dangerous` operation on an `approve`-tier module returns
`waiting_approval`, and someone has to approve it there.

## Typical use

Discover what the node can do:

```json
{ "module": "remote-node", "operation": "node_workers", "args": { "node": "gpu-us" } }
```

Run a local model on the node's GPU:

```json
{
  "module": "remote-node",
  "operation": "node_invoke",
  "args": {
    "node": "gpu-us",
    "module": "ollama",
    "operation": "chat",
    "args": { "prompt": "summarize this transcript", "model": "qwen3" }
  }
}
```

Long jobs — a transcode, a model pull — should go `async` and be collected later:

```json
{ "module": "remote-node", "operation": "node_invoke",
  "args": { "node": "gpu-us", "module": "ollama", "operation": "pull_model",
            "args": { "model": "qwen3:32b" }, "mode": "async" } }
```

then poll with `node_job_status` and read `node_job_result`.

## Security notes

- **The mesh is the perimeter.** Any device on the tailnet that holds the token
  can reach the node. Use ACLs to restrict which peers may talk to port 7777,
  and keep the peer list small.
- **One token per node.** Rotating a node's `authToken` is a config edit plus a
  restart on that node, and a config edit on every coordinator that dials it.
- **Physical and legal reality.** A machine you control remotely sits on someone
  else's power, network and jurisdiction. Agree with its owner on what it may be
  used for before pointing an agent at it.
- **Do not feed untrusted content to a privileged agent.** `node_invoke_privileged`
  is remote code execution by design; the confirm string and the approval gates
  are mitigations, not a sandbox.
- **Not covered here:** interactive desktop access. For that, run Sunshine on the
  node with Moonlight on your side, or RDP over the same mesh. Chinvat is the
  automation channel, not a remote-desktop product.
