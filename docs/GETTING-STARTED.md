# Getting started with Chinvat

This guide takes you from a fresh Windows machine to one successful delegated model task.

## 1. Install and start

Requirements: Node.js 20 or newer (22 LTS recommended) and Git.

```powershell
git clone https://github.com/adun-denton/Chinvat.git
cd Chinvat
npm install
npm run build
npm start
```

Open `http://localhost:7777`. Chinvat is local-only by default; keep the terminal open while you use it.

## 2. Configure one model worker

Open **Modules** and choose one starting point:

- **Ollama** for local/private inference. Install Ollama, run `ollama pull qwen3`, keep the default URL, enable the module, and select **Test connection**.
- **OpenRouter** for hosted models. Create an API key at OpenRouter, paste it into the module, choose a default model, enable it, and test.
- **openai-compatible** for NVIDIA NIM/Nemotron, Groq, Together, LM Studio, vLLM, Azure, or another compatible endpoint. This is one reusable module, not separate provider modules. Enter `Base URL`, `API key`, `Default model`, and optional `Custom headers (JSON)`.

Secrets remain in the local, git-ignored `data/chinvat.config.json`. Never paste them into prompts or commit that file.

## 3. Connect your coordinator

Open **Connect**, select Codex, Claude Code, Claude Desktop, Cursor, Hermes, or Generic MCP, preview the change, and install it. Chinvat merges only its own entry and creates a backup.

HTTP is the default for Codex, Claude Code, Cursor, Hermes, and generic MCP clients:

```text
http://127.0.0.1:7777/mcp
```

Restart or reload the coordinator when the Connect page tells you to. Detailed manual formats are in [the clients guide](../clients/README.md).

Claude Desktop does not support native HTTP MCP. Use its default stdio entry (`node hub/dist/index.js --stdio`) or the `npx mcp-remote` bridge; do not put a raw `url` in Claude Desktop's config.

## 4. Verify discovery

Ask your coordinator:

```text
Use Chinvat to list available workers and capabilities.
```

The answer should show the worker you enabled as healthy. If it is unhealthy, open **Modules**, read its exact health message, correct the configuration, and run **Test connection** again.

## 5. Delegate the first task

Try one explicit request:

```text
Use Chinvat's Ollama worker to summarize this text: ...
```

or:

```text
Use Chinvat's OpenRouter worker with model <provider/model> to answer: ...
```

or:

```text
Use Chinvat's openai-compatible worker with model <model-id> to answer: ...
```

The coordinator discovers the operation schema, submits a job, and returns the result. Model inference is normally read-risk; publishing, messaging, file writes, and destructive actions follow the selected policy tier.

## 6. Understand approvals

- **observe**: `read` operations run; `act` and `dangerous` operations are rejected.
- **approve**: `read` operations run; `act` and `dangerous` operations pause as `waiting_approval`.
- **autonomous**: all operations run without pausing, but remain logged.

Model inference operations are `read`, so they never wait for approval at any tier.

## The seven MCP tools

`workers_list`, `capabilities_describe`, `tasks_submit`, `tasks_status`, `tasks_result`, `tasks_cancel`, and `adapter_invoke`.

Use `tasks_submit { module, operation, args, mode:"sync"|"async", parent_id?, wait_ms? }` for persistent delegated work. Use `adapter_invoke { module, operation, args }` for a quick synchronous single call. For sensitive read-only work that must not enter Chinvat's job database, use `adapter_invoke { module, operation, args, ephemeral:true }`; this disables job/event/result/log/artifact persistence and fails closed for non-read operations. Ephemeral use is confined to the `ephemeralModules` allowlist in `chinvat.config.json` (default `["ollama"]`); modules outside it are rejected fail-closed.

Start external-service and system workers on **approve**. Raise autonomy only after testing the exact operations you intend to use.

## Next

- [Using models](MODELS.md)
- [Configuration guide](CONFIGURATION.md)
- [Modules reference](MODULES.md)
- [راهنمای فارسی](fa/README.md)
