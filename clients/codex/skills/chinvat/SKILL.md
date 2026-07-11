---
name: chinvat
description: Delegate work to the local Chinvat labor hub. Use when the user wants to offload a subtask to a local model (Ollama/Qwen) or a remote specialist (OpenRouter), run a Windows shell command or file operation, or publish/send through a connected account — WordPress, Telegram, WhatsApp, Facebook, Instagram, or LinkedIn. Also use to check on or cancel long-running delegated jobs.
---

# Chinvat labor hub

Chinvat is a local MCP server that turns one request into delegated, tracked **jobs** run by worker **modules**. Risky operations pause for human approval. Use it to spread work across local and remote models and to act on the world through the user's connected accounts.

## Workflow

1. **Discover** — call `workers_list` to see modules, their health, policy tier, and operations. Call `capabilities_describe {module}` for exact operations, argument schemas, and each operation's risk (`read` / `act` / `dangerous`).
2. **Delegate** — call `tasks_submit {module, operation, args, mode}`.
   - `mode: "sync"` waits and returns the result inline (best for quick reads).
   - `mode: "async"` returns a `job_id`; poll `tasks_status` / `tasks_result`.
   - Pass `parent_id` to attach a subtask to a parent job, building a work tree.
3. **Handle approval** — if a job comes back `waiting_approval`, the operation exceeds the module's tier. Tell the user to approve it in the Chinvat dashboard (or Telegram), then poll `tasks_status`. Do not retry in a loop.
4. **Compose** — gather child `tasks_result`s and synthesize them into the parent objective.

## Delegation patterns

- **Offload bulk work to local models:** `tasks_submit {module:"ollama", operation:"chat", args:{model:"qwen3", messages:[...]}}`.
- **Reach a specialist:** `tasks_submit {module:"openrouter", operation:"chat", args:{model:"...", messages:[...]}}`.
- **Act on the machine:** `tasks_submit {module:"system", operation:"run_command", args:{command:"..."}}` — `dangerous`, usually needs approval.
- **Publish / send:** `wordpress.create_post`, `telegram.send_message`, `whatsapp.send_text`, `facebook.create_post`, `instagram.publish_photo`, `linkedin.create_post`.

## Rules

- Always `capabilities_describe` a module before first use in a session — argument names and risk levels are authoritative there.
- Prefer `adapter_invoke` for a single quick read; prefer `tasks_submit` when you need tracking, artifacts, or parallelism.
- Never assume an approval was granted; confirm via `tasks_status` before using a result.
- Report module setup errors (missing tokens) to the user verbatim — they fix these in the dashboard's Modules page.
