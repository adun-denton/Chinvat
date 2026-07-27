# Connecting coordinators to Chinvat

The safest path is the dashboard: start the hub, open **Connect**, choose the client, preview the generated configuration, and use **Install automatically** where supported. Chinvat backs up the target and writes only its own `chinvat` entry.

The hub supports:

- **Streamable HTTP** — normally `http://127.0.0.1:7777/mcp`
- **stdio** — the client spawns `node <REPO>/hub/dist/index.js --stdio`

Build first:

```powershell
npm install
npm run build
```

## Local untokened examples

These manual examples are for the default loopback hub with no `authToken`.

### Codex

Project `.codex/config.toml` or global `~/.codex/config.toml`:

```toml
[mcp_servers.chinvat]
url = "http://127.0.0.1:7777/mcp"
```

See [`codex/config.toml`](codex/config.toml). Restart Codex.

### Claude Code

Project `.mcp.json`, user config, or CLI:

```text
claude mcp add --transport http chinvat http://127.0.0.1:7777/mcp
```

```json
{
  "mcpServers": {
    "chinvat": {
      "type": "http",
      "url": "http://127.0.0.1:7777/mcp"
    }
  }
}
```

Run `/mcp` to connect.

### Cursor

Project `.cursor/mcp.json` or global `~/.cursor/mcp.json`:

```json
{
  "mcpServers": {
    "chinvat": {
      "url": "http://127.0.0.1:7777/mcp"
    }
  }
}
```

### Hermes

`~/.hermes/config.yaml`:

```yaml
mcp_servers:
  chinvat:
    url: http://127.0.0.1:7777/mcp
```

Run `/reload-mcp`.

### Claude Desktop

`%APPDATA%\Claude\claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "chinvat": {
      "command": "node",
      "args": ["<REPO>/hub/dist/index.js", "--stdio"]
    }
  }
}
```

Fully restart Claude Desktop. Its native MCP transport is stdio; an HTTP alternative is `mcp-remote`.

### Other MCP clients

Use Streamable HTTP at the local endpoint, or spawn the stdio command above.

## Authenticated or remote hubs

A hub with `authToken` requires `Authorization: Bearer <token>` on `/mcp`. Client configuration formats represent HTTP headers differently, and some stdio-to-HTTP bridges use their own syntax.

Use the authenticated hub's **Connect** page to generate the exact snippet. Do not copy a token into a tracked project file or public issue. Prefer a private mesh address and follow [Remote Nodes](../docs/REMOTE-NODES.md).

Bearer auth identifies access to one hub; it is not per-user authorization.

## Process behavior

A client-spawned stdio hub is a different process from the dashboard HTTP hub. Each process loads configuration once. Restart every affected process after a rebuild or external config edit.

## Codex plugin (optional)

The simplest Codex setup is the TOML entry above. The optional packaged plugin under `codex/` also includes the delegation skill; copy it to the local plugins directory and adjust paths.

## The seven tools

`workers_list` · `capabilities_describe` · `tasks_submit` · `tasks_status` · `tasks_result` · `tasks_cancel` · `adapter_invoke`
