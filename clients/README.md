# Connecting coordinators to Chinvat

The recommended path is the dashboard **Connect** page: start the hub, open `http://localhost:7777`, choose the client, preview the exact merge, and apply it. Chinvat backs up an existing config, writes only the `chinvat` entry, includes authentication when required, and re-tests the endpoint.

The hub offers two MCP transports backed by the same jobs, policy, approvals, and artifacts:

- Streamable HTTP: `http://127.0.0.1:7777/mcp`
- stdio: `node <REPO>/hub/dist/index.js --stdio`

Build first:

```powershell
npm install
npm run build
```

## Tokened hubs

The examples below are for the default local untokened hub. When `authToken` is configured, every MCP HTTP request requires a bearer token. Prefer the Connect page because clients encode HTTP headers differently and the generated configuration carries the current token.

Do not paste a remote-node bearer token into public documentation, issue text, or committed client configuration. Rotate any token exposed in chat or logs.

## Codex

TOML at `.codex/config.toml` (project) or `~/.codex/config.toml` (global):

```toml
[mcp_servers.chinvat]
url = "http://127.0.0.1:7777/mcp"
```

Restart Codex after changing its MCP configuration. See [`codex/config.toml`](codex/config.toml).

## Claude Code

JSON at `.mcp.json` (project) or `~/.claude.json` (user), or use the CLI:

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

Run `/mcp` to inspect the connection.

## Cursor

JSON at `.cursor/mcp.json` (project) or `~/.cursor/mcp.json` (global):

```json
{
  "mcpServers": {
    "chinvat": {
      "url": "http://127.0.0.1:7777/mcp"
    }
  }
}
```

## Hermes

YAML at `~/.hermes/config.yaml`, then `/reload-mcp`:

```yaml
mcp_servers:
  chinvat:
    url: http://127.0.0.1:7777/mcp
```

## Claude Desktop

Claude Desktop has no native HTTP MCP transport. Default to stdio in `%APPDATA%\Claude\claude_desktop_config.json`:

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

HTTP alternative through `mcp-remote`:

```json
{
  "mcpServers": {
    "chinvat": {
      "command": "npx",
      "args": ["-y", "mcp-remote", "http://127.0.0.1:7777/mcp"]
    }
  }
}
```

Fully restart Claude Desktop, including its tray process, after config, module, or rebuilt-code changes. Its stdio hub is a separate process with its own in-memory config snapshot.

## Generic MCP clients

Point a Streamable HTTP client at `http://127.0.0.1:7777/mcp`, or spawn the stdio command above. For a tokened endpoint, configure `Authorization: Bearer <token>` according to that client’s schema.

## Codex pack

The basic TOML entry is sufficient. The optional `codex/` pack also includes the delegation skill. Copy the complete directory to the desired plugin location and edit paths as needed.

## The seven tools

```text
workers_list
capabilities_describe
tasks_submit
tasks_status
tasks_result
tasks_cancel
adapter_invoke
```

Use `tasks_submit` for persistent work. `adapter_invoke {ephemeral:true}` is available only for allowlisted read operations and records nothing.
