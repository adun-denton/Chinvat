# Using models through Chinvat

Chinvat is not a model and does not replace the coordinator. Codex, Claude, or another MCP client plans the work; Chinvat exposes model workers, applies policy, runs jobs, and records results unless an explicitly ephemeral path is used.

## Choose a provider

| Worker | Best for | Credentials | Typical trade-off |
|---|---|---|---|
| `ollama` | local, private, bulk work | none | limited by local hardware |
| `openrouter` | broad hosted catalogue and provider routing | OpenRouter key | hosted processing and provider billing |
| `openai-compatible` | direct NVIDIA, Groq, Together, Azure, vLLM, LM Studio, etc. | provider key | endpoint behavior varies |

OpenRouter credentials work only with OpenRouter. For NVIDIA NIM/Nemotron, use the NVIDIA key in `openai-compatible`; do not place it in OpenRouter.

Chinvat currently ships one `openai-compatible` instance. Named instances such as `nvidia`, `groq`, `together`, `lmstudio`, and `vllm` remain roadmap work.

## Exact worker surfaces

### Ollama

Operations:

- `chat`: `prompt` or `messages`; optional `model`, `think`, `format`, and `options`.
- `generate`: raw prompt completion; optional `model`, `think`, `format`, and `options`.
- `embeddings`: embedding vectors for `input`.
- `list_models`: locally installed models.
- `pull_model`: download a model; `act` risk.

`think` is forwarded to Ollama to enable or disable model thinking. `format` may be `"json"` or a JSON Schema object. `options` carries Ollama settings such as temperature or context length.

Fields: `Base URL` (default `http://127.0.0.1:11434`) and `Default model` (default `qwen3`).

### OpenRouter

Operations:

- `chat`: normal hosted chat; optional model, temperature, and token limit.
- `private_chat`: ephemeral-only private route with exact model/provider allowlists, live ZDR endpoint verification, data-collection denial, no fallback, and optional response schema.
- `list_models`: visible catalogue.
- `key_info`: key usage and limits.

Fields: `API key`, `Default model`, `Private model allowlist`, and `Private provider allowlist`. The base URL is fixed to `https://openrouter.ai/api/v1`.

`private_chat` requires all of the following:

1. Add `openrouter` to top-level `ephemeralModules`.
2. Configure exact model and provider allowlists.
3. Call through `adapter_invoke` with `ephemeral:true`.
4. Provide exact `model` and `provider`.

Example:

```json
{
  "module": "openrouter",
  "operation": "private_chat",
  "args": {
    "model": "provider/model-id",
    "provider": "provider-slug",
    "prompt": "Classify this text."
  },
  "ephemeral": true
}
```

The operation verifies the live ZDR endpoint inventory, rejects implicit caching, denies provider data collection, disables fallbacks, and checks the provider/model reported in the result. This narrows the route; it does not turn an untrusted hosted provider into a local model.

### OpenAI-compatible

Operations: `chat`, `list_models`, and `embeddings`.

Fields: `Base URL`, `API key`, `Default model`, and optional `Custom headers (JSON)`. The base URL is normalized to one `/v1`.

For NVIDIA, use `https://integrate.api.nvidia.com/v1`, an `nvapi-` key, and an exact model id returned by `list_models`. Some models or tiers require separate access.

## Model selection

Each inference operation accepts a per-call model. If omitted, the configured default is used. Prefer explicit model IDs in repeatable workflows.

Do not guess IDs. Run `list_models` or use the provider catalogue, then copy the exact identifier.

Examples:

```text
Use Chinvat's OpenRouter worker with model anthropic/<model-id> to review this draft.
```

```text
Use Chinvat's openai-compatible worker with model nvidia/<model-id> to classify these records.
```

```text
Use Chinvat's Ollama worker with my local model, think disabled, and JSON output.
```

## Persistence and privacy

Normal `tasks_submit` and `adapter_invoke` calls create local job/result records. Treat the data directory as sensitive.

`adapter_invoke` with `ephemeral:true` creates no Chinvat job, event, log, result, or artifact persistence. It is allowed only for `read` operations in `ephemeralModules`. It does not prevent the selected external provider from processing the prompt according to its own service behavior.

Use local Ollama when the data must remain on the machine. For hosted calls, send only data suitable for the configured provider and route.

## Practical division of labor

- Use local models for private, repetitive, and inexpensive preprocessing.
- Use a hosted specialist for capability or quality that the local machine cannot provide.
- Keep the coordinator responsible for tool use, context selection, final synthesis, and user-facing decisions.
- Name the worker and model when the choice matters; automatic routing is not yet shipped.

## Troubleshooting

1. Check module health.
2. Run `list_models`.
3. Try a minimal `chat`.
4. Read the exact job or direct-call error.
5. Check provider credits, scopes, rate limits, and model availability.

Common distinctions:

- `401`: invalid or expired credential.
- `403`: missing permission, product, or entitlement.
- `402`: provider credits/billing.
- `404`: wrong model id or base URL.
- `429`: provider rate limit or access tier.
- connection refused: local endpoint is not running or the URL is wrong.
