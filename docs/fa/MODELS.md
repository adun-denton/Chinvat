<p align="center">
  <b>فارسی</b> &nbsp;·&nbsp; <a href="../MODELS.md">English</a>
</p>

<p align="center"><a href="README.md">فهرست راهنمای فارسی</a></p>

# کار با مدل‌ها

| ماژول | کاربرد | تنظیمات دقیق |
|---|---|---|
| `ollama` | پردازش محلی | `Base URL` با پیش‌فرض `http://127.0.0.1:11434` و `Default model` با پیش‌فرض `qwen3` |
| `openrouter` | مدل‌های ابری متعدد | `API key` و `Default model` با پیش‌فرض `openrouter/auto` |
| `openai-compatible` | اتصال مستقیم به NVIDIA و APIهای سازگار | `Base URL`، `API key`، `Default model` و `Custom headers (JSON)` |

چینوات فقط یک نمونهٔ `openai-compatible` دارد. نام‌هایی مانند `nvidia`، `groq`، `together`، `lmstudio` و `vllm` Provider نمونه‌اند، نه ماژول‌های موجود.

## Operationها

- `ollama`: `chat`، `generate`، `embeddings`، `list_models`، `pull_model`.
- `openrouter`: `chat`، `list_models`، `key_info`. Base URL آن ثابت و برابر `https://openrouter.ai/api/v1` است.
- `openai-compatible`: `chat`، `list_models`، `embeddings`. `Base URL` به یک `/v1` نرمال می‌شود. `chat` یک `prompt` یا `messages` و Optionهای `model`، `temperature` و `max_tokens` می‌پذیرد. اگر Endpoint از Embeddings پشتیبانی نکند، خطای Capability روشن برمی‌گردد.

Model ID را حدس نزنید؛ `list_models` را اجرا و ID دقیق را کپی کنید.

```text
Use Chinvat's openai-compatible worker with model nvidia/<model-id> to analyze this Persian text.
```

## NVIDIA

`Base URL` را `https://integrate.api.nvidia.com/v1` قرار دهید. `API key` از build.nvidia.com با `nvapi-` شروع می‌شود. نمونهٔ `Default model`: `nvidia/llama-3.3-nemotron-super-49b-v1.5`؛ برای ID دقیق `list_models` را اجرا کنید. بعضی Modelها یا Tierها نیازمند Access هستند و Free tier دارای Rate limit است. کلید NVIDIA را هرگز از OpenRouter عبور ندهید.

هزینهٔ API جدا از اشتراک ChatGPT یا Claude است. Jobهای چینوات Input و Result را محلی نگه می‌دارند؛ Data directory را حساس تلقی کنید.
