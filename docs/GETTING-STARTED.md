# Getting started with Chinvat

This guide takes a fresh Windows machine to one successful delegated model task.

## 1. Install and start

Requirements: Node.js 20 or newer (22 LTS recommended) and Git.

```powershell
git clone https://github.com/adun-denton/Chinvat.git
cd Chinvat
npm install
npm run build
npm start
```

Open `http://localhost:7777`. Chinvat binds to loopback by default; keep the terminal open while using it.

## 2. Configure one model worker

Open **Modules** and choose one:

- **Ollama** for local/private inference. Install Ollama, run `ollama pull qwen3`, enable the module, and test.
- **OpenRouter** for hosted models. Enter an OpenRouter key and default model, enable, and test.
- **openai-compatible** for NVIDIA, Groq, Together, LM Studio, vLLM, Azure, or another compatible endpoint. Enter the base URL, provider key, exact default model, and optional custom headers.

Secrets remain in the local, git-ignored `data/chinvat.config.json`. Never paste them into prompts or commit the file.

## 3. Connect the coordinator

Open **Connect**, select Codex, Claude Code, Claude Desktop, Cursor, Hermes, or Generic MCP, preview the change, and install it. Chinvat merges only its own entry and creates a backup.

Local HTTP endpoint:

```text
http://127.0.0.1:7777/mcp
```

Restart or reload the coordinator when instructed. Manual formats are in the [clients guide](../clients/README.md).

Claude Desktop does not support native HTTP MCP. Use its stdio entry (`node hub/dist/index.js --stdio`) or an HTTP bridge such as `mcp-remote`.

A tokened remote hub requires client-specific authentication fields. Use the remote hub's **Connect** page rather than adapting the untokened local examples by hand.

## 4. Verify discovery

Ask the coordinator:

```text
Use Chinvat to list available workers and capabilities.
```

The enabled worker should be healthy. Otherwise, read its exact health message, correct the settings, and run **Test connection** again.

## 5. Delegate the first task

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

The coordinator discovers the operation schema, submits a job, and returns the result.

## 6. Understand policy

- **observe**: `read` runs; `act` and `dangerous` reject.
- **approve**: `read` runs; `act` and `dangerous` wait for approval.
- **autonomous**: declared operations run without pausing and remain logged.

Model inference is normally `read`. Publishing, messaging, file writes, commerce changes, code execution, and destructive actions are consequential.

Start external-service and system workers at `approve`. Raise autonomy only after exercising the exact operations and recovery behavior.

## 7. The seven MCP tools

`workers_list`, `capabilities_describe`, `tasks_submit`, `tasks_status`, `tasks_result`, `tasks_cancel`, and `adapter_invoke`.

Use `tasks_submit` for persistent delegated work. Use async for long-running jobs and work that may wait for approval.

Use `adapter_invoke` for a direct synchronous call. `ephemeral:true` suppresses Chinvat job/event/result/log/artifact persistence, but only for `read` operations in the top-level `ephemeralModules` allowlist.

## 8. Process/config note

The dashboard HTTP hub and a client-spawned stdio hub are separate processes. Configuration is loaded once per process. After editing config or rebuilding, restart every process that must see the new state.

## Next

- [Documentation hierarchy](README.md)
- [Using models](MODELS.md)
- [Configuration guide](CONFIGURATION.md)
- [Modules reference](MODULES.md)
- [Remote nodes](REMOTE-NODES.md)
- [Mail Relay design](DESIGN-mail-relay.md)
- [راهنمای فارسی](fa/README.md)
