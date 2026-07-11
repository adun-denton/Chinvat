# Connecting coordinators to Chinvat

The easiest path is the dashboard: start the hub (`npm start`), open **Connect** at `http://localhost:7777`, pick your client, and copy the config or use **Install automatically**. Auto-install previews the exact merged file, backs up anything it finds, writes only the `chinvat` entry, and re-tests the endpoint. This folder holds the manual equivalents.

The hub speaks MCP two ways at once, backed by the same jobs, policy, and approvals:

- **Streamable HTTP** (default) — `http://127.0.0.1:7777/mcp`
- **stdio** (fallback) — the client spawns `node <REPO>/hub/dist/index.js --stdio`

Build the hub first: `npm install && npm run build`.

## Per-client config (each format is different — don't assume `.mcp.json`)

**Codex** — TOML at `.codex/config.toml` (project) or `~/.codex/config.toml` (global):
```toml
[mcp_servers.chinvat]
url = "http://127.0.0.1:7777/mcp"
```
See [`codex/config.toml`](codex/config.toml). Restart Codex after.

**Claude Code** — JSON at `.mcp.json` (project) or `~/.claude.json` (user); or one command:
```
claude mcp add --transport http chinvat http://127.0.0.1:7777/mcp
```
```json
{ "mcpServers": { "chinvat": { "type": "http", "url": "http://127.0.0.1:7777/mcp" } } }
```
Run `/mcp` to connect.

**Cursor** — JSON at `.cursor/mcp.json` (project) or `~/.cursor/mcp.json` (global):
```json
{ "mcpServers": { "chinvat": { "url": "http://127.0.0.1:7777/mcp" } } }
```

**Hermes** — YAML at `~/.hermes/config.yaml`; then `/reload-mcp` (no restart):
```yaml
mcp_servers:
  chinvat:
    url: http://127.0.0.1:7777/mcp
```

**Claude Desktop** — JSON at `%APPDATA%\Claude\claude_desktop_config.json`. No native HTTP, so use stdio (replace `<REPO>`), then fully restart the app:
```json
{ "mcpServers": { "chinvat": { "command": "node", "args": ["<REPO>/hub/dist/index.js", "--stdio"] } } }
```
HTTP alternative: `{ "command": "npx", "args": ["-y", "mcp-remote", "http://127.0.0.1:7777/mcp"] }`.

**Any other MCP client** — point it at `http://127.0.0.1:7777/mcp` (Streamable HTTP), or spawn the stdio command above.

## Codex plugin (optional)

The simplest Codex setup is just the `config.toml` above — no plugin needed. If you do want the packaged plugin (which also ships the delegation skill), copy the whole `codex/` folder to `C:\Users\<you>\plugins\local-labor-hub` and edit paths; the skill is bundled inside so the folder is self-contained.

## The seven tools

`workers_list` · `capabilities_describe` · `tasks_submit` · `tasks_status` · `tasks_result` · `tasks_cancel` · `adapter_invoke`
