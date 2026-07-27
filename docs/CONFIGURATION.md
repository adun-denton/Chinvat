# Configuring Chinvat

The dashboard and hub at `http://localhost:7777` are the primary configuration surface.

## Modules

For every module:

1. Enter the fields shown on its card.
2. Keep secrets in the secret fields; do not put them in prompts.
3. Enable the module.
4. Select a policy tier.
5. Save and run **Test connection**.

A green health result proves the configured identity or endpoint. It does not always prove every optional action: publishing APIs may require additional scopes, products, credits, or account review. Test one low-impact real operation before relying on a workflow.

Exact service prerequisites and fields are listed in [Modules](MODULES.md).

Chinvat has exactly 20 built-ins: `ollama`, `openrouter`, `openai-compatible`, `system`, `telegram`, `wordpress`, `woocommerce`, `coolify`, `blender`, `orca`, `gimp`, `rhino`, `whatsapp`, `facebook`, `instagram`, `linkedin`, `x`, `gmail`, `chat-relay`, and `remote-node`. By default, `ollama`, `openrouter`, `system`, `telegram`, and `wordpress` are enabled. The others remain disabled until configured; `woocommerce` and `remote-node` default to the **approve** tier.

## Connect

Use **Connect** to attach a coordinator. Preview before applying. Chinvat backs up the existing client configuration and merges only the `chinvat` MCP entry.

The local MCP endpoint is:

```text
http://127.0.0.1:7777/mcp
```

HTTP is the default for Codex (`.codex/config.toml`, `url`), Claude Code (`.mcp.json`, `type:"http"` and `url`, or `claude mcp add`), Cursor (`.cursor/mcp.json`, `url`), Hermes (`~/.hermes/config.yaml`, then `/reload-mcp`), and generic clients. Claude Desktop has no native HTTP transport: use stdio with `command:"node"` and `args:[".../hub/dist/index.js","--stdio"]`, or HTTP through `npx mcp-remote`.

## Jobs and approvals

Use **Jobs** to inspect queued, running, waiting, succeeded, or failed work. Approval authorizes an attempt; it does not guarantee the external API accepts it. Always inspect the final job status when a message or post is not visible.

Use **Approvals** to approve or deny gated actions. Telegram approval buttons are optional and require a configured Telegram bot and chat ID.

## Configuration file

Chinvat creates:

```text
data/chinvat.config.json
```

The directory is git-ignored. Back it up securely if needed, but never commit or share it. Environment overrides:

- `CHINVAT_PORT`
- `CHINVAT_DATA_DIR`
- `CHINVAT_BIND`
- `CHINVAT_AUTH_TOKEN`

## Authentication and bind policy

`bind` defaults to `127.0.0.1` and `authToken` defaults to empty, which keeps the
local experience zero-config. Beyond loopback the rules are strict and enforced
at startup:

- A non-loopback `bind` with no `authToken` is a **startup error**, not a warning.
  An untokened off-box hub would publish `system.run_command` to the network.
- Any configured `authToken` must be at least 24 characters.
- When a token is set, every `/mcp` and `/api` request must carry
  `Authorization: Bearer <token>` — including on loopback.
- The `/ws` event stream is gated identically. Browsers cannot set headers on a
  WebSocket, so it accepts `?token=…`; an `Authorization` header still wins for
  non-browser clients.
- The dashboard prompts for the token when the hub answers 401 and keeps it in
  that browser's local storage. Use **forget token** in the sidebar to clear it.
  `GET /auth/required` is deliberately unauthenticated so the dashboard knows
  whether to prompt; it reveals nothing a 401 would not.

Generate one with:

```powershell
node -e "console.log(require('crypto').randomBytes(32).toString('base64url'))"
```

The **Connect** page folds the token into the client snippets it generates, so a
tokened hub stays one copy-paste away from a working coordinator.

Exposing a hub is covered end to end in [Remote Nodes](REMOTE-NODES.md).

## Safe defaults

- Keep the hub bound to `127.0.0.1` unless you are deliberately running a remote
  node; then bind to the mesh address, never `0.0.0.0`.
- Start system, messaging, and publishing modules at **approve**.
- Restrict the system module's `allowedRoot`.
- Use provider-side budgets and long-lived tokens only where necessary.
- Disable unused modules and expired credentials.
