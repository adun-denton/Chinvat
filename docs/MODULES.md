# Modules guide

Every module is configured on the dashboard's **Modules** page. Secrets are stored only in `data/chinvat.config.json` on your machine and are sent only to the service they belong to. Each module has a policy **tier** (observe / approve / autonomous) — see the [README](../README.md#policy-what-crosses-the-bridge). Every card has a **Test connection** button that re-runs the module's health check.

## ollama — local models
Install [Ollama](https://ollama.com) and pull a model (`ollama pull qwen3`). Default base URL `http://127.0.0.1:11434`. Operations: `chat`, `generate`, `embeddings`, `list_models`, `pull_model`. Default tier: autonomous (all read-level).

## openrouter — remote specialists
Create a key at openrouter.ai → **API key**. Set a default model (`openrouter/auto` lets OpenRouter choose). Operations: `chat`, `list_models`, `key_info`. Default tier: autonomous.

## openai-compatible — any OpenAI-compatible API
One reusable worker for **NVIDIA NIM/Nemotron, Groq, Together, LM Studio, vLLM, Azure**, and similar. Config: `baseUrl` (with or without a trailing `/v1` — it's normalized, never duplicated), `apiKey` (**the provider's own key**, sent only to that baseUrl — not routed through OpenRouter), `defaultModel` (run `list_models` to see valid ids), and optional `customHeaders` (a JSON object of extra headers; merged last so it can override `Authorization`, e.g. `{"api-key":"…"}` for Azure). Operations: `chat` (`prompt` or `messages`, optional `model`/`temperature`/`max_tokens`), `list_models`, `embeddings` (returns a clear capability error if the provider has no embeddings endpoint). Inference is `read`-risk. Disabled by default; enable it after configuring, then hit **Test connection**.

**NVIDIA example** — `baseUrl` `https://integrate.api.nvidia.com/v1`, `apiKey` from [build.nvidia.com](https://build.nvidia.com), `defaultModel` e.g. `nvidia/llama-3.3-nemotron-super-49b-v1.5` (or run `list_models` for exact ids). Note: only one `openai-compatible` instance runs today; named instances (`nvidia`, `groq`, …) are a small follow-up once the registry supports multiple instances per provider — the provider layer is already a factory, so it's a one-line registration each.

## system — the Windows machine
Runs PowerShell commands and file operations, fenced to **allowedRoot** (your home directory by default; widen it or set `allowFullAccess` deliberately). Operations include `run_command` and `delete_path` (both `dangerous`), `read_file`/`write_file`/`move_path`, `open_app`, `process_list`, `system_info`. Default tier: **approve** — dangerous ops wait for you.

## telegram — messaging + approvals
Create a bot with [@BotFather](https://t.me/botfather) and paste the token. To get your `chatId`, send the bot a message then use the `get_updates` operation (Playground) and read the chat id. Enable **approvalButtons** to approve/deny jobs from your phone; enable **notifyJobs** for completion pings. Operations: `send_message`, `send_document`, `get_me`, `get_updates`.

## wordpress — publishing
In WP Admin → **Users → Profile → Application Passwords**, create one for Chinvat. Enter site URL, username, and the application password. `create_post`/`create_page` make **drafts**; `publish_post` and `delete_post` are `dangerous`. Also: `upload_media`, `list_posts`, `list_categories`, `list_tags`, `site_info`.

## whatsapp — WhatsApp Business Cloud API
Requires a Meta app with WhatsApp added: a permanent **access token** and a **phone number ID** (Meta for Developers → WhatsApp → API Setup). Recipients outside the 24-hour window need an approved **template** (`send_template`); inside it, `send_text` works. `phone_info` checks setup.

## facebook — Page publishing
Needs a **Page ID** and a long-lived **page access token** with `pages_manage_posts` (Graph API Explorer → generate → extend). Operations: `create_post`, `list_posts`, `delete_post` (`dangerous`), `page_info`.

## instagram — Graph API (business/creator)
Needs the IG **business account ID** and an access token with Instagram permissions, linked to a Facebook Page. `publish_photo` takes a **publicly reachable** image URL (two-step container publish). Also `list_media`, `account_info`.

## linkedin — member posts
A 3-legged OAuth **access token** with the `w_member_social` scope (Share on LinkedIn product). Find your **author URN** by running the `me` operation — it returns `urn:li:person:<sub>`. Operation: `create_post`.

## x — X (Twitter)
A 3-legged OAuth 2.0 **user access token** from an app at [developer.x.com](https://developer.x.com) with scopes `tweet.read`, `tweet.write`, `users.read`. Operations: `post_tweet` and `delete_tweet` (delete is `dangerous`), `me`, `search_recent`. Note: posting and search require a **write/read-enabled API access tier** — the free tier is limited, and `search_recent` needs at least Basic.

---

### Adding your own module
Drop a folder in `modules/` exporting a default object that implements the `ChinvatAdapter` contract (`hub/src/types.ts`): `name`, `configSchema`, `capabilities()`, `health()`, `invoke()`. It loads at boot, defaults to the `approve` tier, and appears in the dashboard automatically.
