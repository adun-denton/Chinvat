# Configuring Chinvat

The dashboard and hub at `http://localhost:7777` are the primary configuration surface. The configuration file is `data/chinvat.config.json`; it is human-editable, git-ignored, and contains module credentials.

## Modules

For every module:

1. Enter the fields shown on its card.
2. Keep credentials in secret fields; do not place them in prompts.
3. Enable the module.
4. Select a policy tier.
5. Save and run **Test connection**.
6. Exercise one low-impact real operation before relying on the workflow.

A green health result proves the configured identity or endpoint. It does not prove every optional scope, product entitlement, credit balance, or write operation.

The exact prerequisites and operation surfaces are in [Modules](MODULES.md).

Chinvat ships 20 built-ins:

`ollama`, `openrouter`, `openai-compatible`, `system`, `telegram`, `wordpress`, `woocommerce`, `coolify`, `blender`, `orca`, `gimp`, `rhino`, `whatsapp`, `facebook`, `instagram`, `linkedin`, `x`, `gmail`, `chat-relay`, and `remote-node`.

The first-boot enabled set is `ollama`, `openrouter`, `system`, `telegram`, and `wordpress`. Other built-ins remain disabled until configured. Consequential workers normally default to `approve`; model workers normally default to `autonomous`.

## Connect

Use **Connect** to attach a coordinator. Preview before applying. Chinvat backs up the existing client configuration and merges only its own `chinvat` entry.

Local MCP endpoint:

```text
http://127.0.0.1:7777/mcp
```

HTTP is the default for Codex, Claude Code, Cursor, Hermes, and generic MCP clients. Claude Desktop has no native HTTP MCP transport: use stdio with `node hub/dist/index.js --stdio`, or an HTTP bridge such as `mcp-remote`.

For a tokened or remote hub, use the dashboard-generated snippet because each client represents headers differently. Manual local examples are in the [clients guide](../clients/README.md).

## Jobs and approvals

Use **Jobs** to inspect queued, running, waiting, succeeded, failed, and cancelled work. An approval authorizes an attempt; it does not prove that the external service accepted or completed it.

Use **Approvals** to approve or deny gated work. Telegram approval buttons are optional and require a configured Telegram bot and chat ID.

`mode:"sync"` waits for a terminal result up to the configured limit. `mode:"async"` returns the job id immediately. Use async for long operations and for remote operations that may wait for approval.

## Configuration schema

Representative top-level shape:

```json
{
  "port": 7777,
  "bind": "127.0.0.1",
  "authToken": "",
  "concurrencyPerModule": 2,
  "syncWaitMsDefault": 120000,
  "syncWaitMsMax": 600000,
  "ephemeralModules": ["ollama"],
  "modules": {
    "ollama": {
      "enabled": true,
      "tier": "autonomous",
      "config": {}
    }
  }
}
```

Top-level fields:

- `port`: HTTP/dashboard/MCP port.
- `bind`: listener address. Default `127.0.0.1`.
- `authToken`: bearer credential. Empty is allowed only on loopback.
- `concurrencyPerModule`: simultaneous jobs permitted for each module.
- `syncWaitMsDefault`: default sync wait.
- `syncWaitMsMax`: maximum accepted sync wait.
- `ephemeralModules`: modules whose `read` operations may use `adapter_invoke` with `ephemeral:true`.
- `modules`: per-module `{ enabled, tier, config }` records.

The default ephemeral allowlist is `["ollama"]`. Add `openrouter` explicitly before using `openrouter.private_chat`, which is ephemeral-only.

## Configuration lifecycle

`ConfigStore` loads once when each hub process starts. A dashboard HTTP hub and a client-spawned stdio hub are separate processes; they may read the same file while holding different in-memory snapshots.

After an external edit or rebuild, restart every affected process. Restarting the dashboard hub does not refresh an already-running stdio hub.

Environment overrides:

- `CHINVAT_PORT`
- `CHINVAT_DATA_DIR`
- `CHINVAT_BIND`
- `CHINVAT_AUTH_TOKEN`

Environment overrides are merged into the in-memory configuration. A later module/config save serializes the whole in-memory object, so a one-off environment override can become persistent in `chinvat.config.json`. Treat environment overrides as real configuration, not guaranteed temporary flags.

## Authentication and bind policy

Loopback is zero-config. Remote exposure is fail-closed:

- A non-loopback `bind` without `authToken` is a startup error.
- Any configured token must be at least 24 characters.
- When a token is set, `/mcp`, `/api`, and `/ws` require authentication, including on loopback.
- HTTP clients use `Authorization: Bearer <token>`.
- Browser WebSockets may use `?token=...` because the browser API cannot set an authorization header.
- The dashboard prompts after a 401 and stores the token only in that browser's local storage.
- `GET /auth/required` is intentionally unauthenticated so the dashboard can decide whether to prompt.

Generate a token:

```powershell
node -e "console.log(require('crypto').randomBytes(32).toString('base64url'))"
```

For remote machines, bind to the private mesh address rather than `0.0.0.0`. See [Remote Nodes](REMOTE-NODES.md).

## System filesystem fence

The `system` module supports:

- `allowedRoots`: preferred multi-root configuration. It may be a list or a semicolon/comma-delimited string.
- `allowedRoot`: legacy single-root fallback.
- `allowFullAccess`: disables the filesystem fence when explicitly enabled.

Relative paths resolve against the first configured root. Keep `system` at `approve` unless the exact workload and roots have been tested.

## Safe defaults

- Keep the hub on `127.0.0.1` unless deliberately deploying a remote node.
- Keep system, messaging, publishing, relay, commerce, and remote-node workers at `approve` initially.
- Use narrow `allowedRoots`; avoid `allowFullAccess`.
- Use provider-side budgets and least-privilege credentials.
- Disable unused modules and rotate expired or exposed tokens.
- Never commit or share `data/chinvat.config.json`.
