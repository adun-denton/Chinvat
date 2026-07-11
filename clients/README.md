# Connecting coordinators to Chinvat

The hub speaks MCP two ways at once, both backed by the same jobs, policy, and approvals:

- **stdio** — the client spawns `node hub/dist/index.js --stdio`
- **Streamable HTTP** — the client connects to `http://127.0.0.1:7777/mcp` (start the hub first with `npm start`)

Build the hub before connecting: `npm install && npm run build`.

## Claude Code / Claude Desktop

Copy [`claude/.mcp.json`](claude/.mcp.json) into your project (Claude Code reads `.mcp.json`) or merge it into your Claude Desktop developer config, replacing `<REPO>` with the absolute path to your clone. Then drop the skill at [`claude/skills/chinvat`](claude/skills/chinvat) into your skills directory so Claude knows how to delegate.

## Codex

1. Copy the `codex/` folder to `C:\Users\<you>\plugins\local-labor-hub`.
2. Edit both JSON files, replacing `<REPO>` with your clone path.
3. Register and install per your Codex plugin workflow (see the manifest in `codex/.codex-plugin/plugin.json`).

## Any other MCP client (Cursor, custom)

Point it at the Streamable HTTP endpoint `http://127.0.0.1:7777/mcp` while the hub is running, or spawn the stdio command above. No per-client code — the tools are identical on every transport.

## The seven tools

`workers_list` · `capabilities_describe` · `tasks_submit` · `tasks_status` · `tasks_result` · `tasks_cancel` · `adapter_invoke`
