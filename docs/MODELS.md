# Using models through Chinvat

Chinvat is not a model and does not replace your coordinator. Codex, Claude, or another MCP client plans the work; Chinvat exposes model workers, runs their jobs, records results, and applies policy.

## Choose a provider

| Worker | Best for | Credentials | Typical trade-off |
|---|---|---|---|
| Ollama | local, private, bulk work | none | limited by local hardware |
| OpenRouter | broad hosted catalogue and routing | OpenRouter key | provider usage is billed separately |
| `openai-compatible` | direct NVIDIA, Groq, Together, Azure, vLLM, LM Studio, etc. | provider key | endpoint behavior varies |

OpenRouter credentials work only with OpenRouter. For NVIDIA NIM/Nemotron, use the NVIDIA key in `openai-compatible`; do not place it in OpenRouter. Chinvat ships one `openai-compatible` instance; provider-named instances such as `nvidia`, `groq`, `together`, `lmstudio`, and `vllm` are roadmap items, not modules.

## Exact worker surfaces

- `ollama`: `chat`, `generate`, `embeddings`, `list_models`, `pull_model`; fields `Base URL` (default `http://127.0.0.1:11434`) and `Default model` (default `qwen3`).
- `openrouter`: `chat`, `list_models`, `key_info`; fields `API key` and `Default model` (default `openrouter/auto`). Its base URL is fixed to `https://openrouter.ai/api/v1` and is not configurable.
- `openai-compatible`: `chat`, `list_models`, `embeddings`; fields `Base URL`, `API key`, `Default model`, `Custom headers (JSON)`. `Base URL` is normalized to one `/v1`; trailing slashes are removed. `chat` accepts `prompt` or `messages`, plus optional `model`, `temperature`, and `max_tokens`. Unsupported embeddings endpoints return a clear capability error.

For NVIDIA, set `Base URL` to `https://integrate.api.nvidia.com/v1`, use an `nvapi-` key from build.nvidia.com, and run `list_models` before choosing an exact ID such as `nvidia/llama-3.3-nemotron-super-49b-v1.5`. Some models or tiers require enabled access, and the free tier is rate-limited.

## Model selection

Each model operation accepts a per-call `model`. If omitted, the worker uses its configured default. Prefer explicit model IDs in repeatable workflows.

Examples for a coordinator:

```text
Use Chinvat's OpenRouter worker with model anthropic/<model-id> to review this draft.
```

```text
Use Chinvat's openai-compatible worker with model nvidia/<nemotron-model-id> to classify these records.
```

```text
Use Chinvat's Ollama worker with my local model to extract action items. Return JSON.
```

Do not guess model IDs. Use the worker's `list_models` operation or the provider catalogue, then copy the exact ID.

## Operations

- `chat`: `messages` or a single `prompt`; optional `model`, `temperature`, and `max_tokens` where exposed.
- `generate`: raw Ollama completion.
- `embeddings`: vectors for retrieval or similarity when the provider supports them.
- `list_models`: models visible to the configured endpoint/key.

## A practical division of labor

- Use local models for private, repetitive, and inexpensive preprocessing.
- Use a hosted specialist when a task needs a particular capability or stronger quality.
- Keep the coordinator responsible for tool use, final synthesis, and user-facing decisions.

Chinvat currently exposes workers individually. A future pool/router may automate selection and fallback; until then, name the worker and model in the request when the choice matters.

## Cost, privacy, and context

- Provider usage is separate from any ChatGPT or Claude subscription.
- Set provider-side spending limits where available.
- Only send data appropriate for that provider. Ollama stays local; hosted workers transmit prompts to their configured service.
- Chinvat jobs persist inputs and results locally. Treat the data directory as sensitive.
- A worker call does not inherit unlimited conversation history automatically. The coordinator decides what context to send.

## Troubleshooting

1. Check module health in **Modules**.
2. Run `list_models` to validate the key, endpoint, and model ID.
3. Try a minimal `chat` prompt.
4. Read the job's exact upstream status and error.
5. Check provider credits, scopes, rate limits, and model availability.

Common distinctions:

- **401/invalid key**: credential problem.
- **403/access denied**: missing scope, product permission, or account entitlement.
- **402/credits depleted**: provider billing, not a Chinvat connection failure.
- **404/model not found**: wrong model ID or base URL.
- **connection refused**: local service is not running or the endpoint is wrong.
