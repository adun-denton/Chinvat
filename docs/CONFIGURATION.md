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

Chinvat has exactly 16 built-ins: `ollama`, `openrouter`, `openai-compatible`, `system`, `telegram`, `wordpress`, `coolify`, `blender`, `orca`, `gimp`, `rhino`, `whatsapp`, `facebook`, `instagram`, `linkedin`, and `x`. By default, `ollama`, `openrouter`, `system`, `telegram`, and `wordpress` are enabled. The other eleven remain disabled until configured.

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

## Safe defaults

- Keep the hub bound to `127.0.0.1`.
- Start system, messaging, and publishing modules at **approve**.
- Restrict the system module's `allowedRoot`.
- Use provider-side budgets and long-lived tokens only where necessary.
- Disable unused modules and expired credentials.
