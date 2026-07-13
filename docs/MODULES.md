# Modules guide

Every module is configured on the dashboard's **Modules** page. Secrets are stored only in `data/chinvat.config.json` on your machine and are sent only to the service they belong to. Each module has a policy **tier** (observe / approve / autonomous) — see the [README](../README.md#policy-what-crosses-the-bridge). Every card has a **Test connection** button that re-runs the module's health check.

The 11 built-ins are `ollama`, `openrouter`, `openai-compatible`, `system`, `telegram`, `wordpress`, `whatsapp`, `facebook`, `instagram`, `linkedin`, and `x`. The first-boot enabled set is `ollama`, `openrouter`, `system`, `telegram`, and `wordpress`; the remaining modules are disabled until configured.

## ollama — local models
Install [Ollama](https://ollama.com) and pull a model (`ollama pull qwen3`). Fields: `Base URL` (default `http://127.0.0.1:11434`) and `Default model` (default `qwen3`). Operations: `chat`, `generate`, `embeddings`, `list_models`, `pull_model`. Default tier: autonomous; `pull_model` is `act`, while the other operations are `read`.

## openrouter — remote specialists
Create a key at openrouter.ai. Fields: `API key` and `Default model` (default `openrouter/auto`). The base URL is fixed to `https://openrouter.ai/api/v1` and is not configurable. Operations: `chat`, `list_models`, `key_info`. Default tier: autonomous.

## openai-compatible — any OpenAI-compatible API
One reusable worker for **NVIDIA NIM/Nemotron, Groq, Together, LM Studio, vLLM, Azure**, and similar. Fields: `Base URL` (with or without a trailing `/v1` — it is normalized, never duplicated), `API key` (the provider's own key, sent only to that Base URL), `Default model`, and optional `Custom headers (JSON)`. Operations: `chat` (`prompt` or `messages`, optional `model`/`temperature`/`max_tokens`), `list_models`, `embeddings` (returns a clear capability error if the provider has no embeddings endpoint). Inference is `read`-risk. Disabled by default; enable it after configuring, then select **Test connection**.

**NVIDIA example** — `Base URL` `https://integrate.api.nvidia.com/v1`, `API key` from [build.nvidia.com](https://build.nvidia.com) beginning `nvapi-`, and `Default model` e.g. `nvidia/llama-3.3-nemotron-super-49b-v1.5` (run `list_models` for exact IDs). The key goes directly to NVIDIA, never through OpenRouter. Some models and tiers require enabled access; the free tier is rate-limited. Only one `openai-compatible` instance runs today; named instances (`nvidia`, `groq`, …) are roadmap work, not shipped modules.

## system — the Windows machine
Runs PowerShell commands and file operations, fenced to **allowedRoot** (your home directory by default; widen it or set `allowFullAccess` deliberately). Operations include `run_command` and `delete_path` (both `dangerous`), `read_file`/`write_file`/`move_path`, `open_app`, `process_list`, `system_info`. Default tier: **approve** — dangerous ops wait for you.

## telegram — messaging + approvals
Create a bot with [@BotFather](https://t.me/botfather) and paste the token. To get your `chatId`, send the bot a message then use the `get_updates` operation (Playground) and read the chat id. Enable **approvalButtons** to approve/deny jobs from your phone; enable **notifyJobs** for completion pings. Operations: `send_message`, `send_document`, `get_me`, `get_updates`.

## wordpress — publishing
In WP Admin → **Users → Profile → Application Passwords**, create one for Chinvat. Enter site URL, username, and the application password. Core REST operations: `site_info`, `list_posts`, `get_post`, `create_post`, `update_post`, `publish_post`, `delete_post`, `upload_media`, `list_categories`, `list_tags`, `create_page`, `list_pages`, `publish_page`, `delete_page`. Bridge operations: `bridge_info`, `bridge_option_get`, `bridge_option_update`, `bridge_theme_list`, `bridge_theme_read`, `bridge_theme_write`, `bridge_rankmath_get`, `bridge_rankmath_update`, `bridge_plugins_list`, `bridge_plugins_toggle`, `bridge_theme_scaffold_child`. `create_post`/`create_page` make **drafts**; `publish_post`, `delete_post`, `publish_page`, `delete_page`, `bridge_theme_write`, and `bridge_theme_scaffold_child` are `dangerous`.

The optional [Chinvat WP Bridge](../wp-plugin/chinvat-bridge/README.md) complements this core-REST adapter with ten WordPress Abilities for options, active-theme files, per-post RankMath data, installed-plugin activation/deactivation, and block-aware child-theme scaffolding. The plugin advertises version `0.3.1`, schema `3`, write gates, environment, and abilities through authenticated `GET /wp-json/chinvat-bridge/v1/info`.

The TypeScript adapter now ships the fixed `bridge_*` operation list above. `bridge_info` returns the handshake; the other operations call the Abilities API `run` endpoint with GET for `read` and POST for `act`/`dangerous`, as detailed in [Architecture](ARCHITECTURE.md#wordpress-integration-paths). Calls use normal Chinvat jobs/policy. `health()` performs best-effort detection and appends the Bridge version and write state when available; an absent Bridge does not make core WordPress health fail. This is not runtime discovery of arbitrary abilities.

Writes require **Developer Mode** (or the back-compatible `CHINVAT_BRIDGE_ENABLE` constant); `theme-write`, `theme-scaffold-child`, `options-update`, and `plugins-toggle` also have dedicated toggles. **Child Theme Scaffold** creates a block-aware child of the active theme's base and activates it by default, giving `theme-write` an update-resistant target; it is `dangerous` and pauses for approval at the `approve` tier. It writes `style.css`, minimal `theme.json`, a trusted plugin-authored `functions.php` that enqueues `get_stylesheet_uri()`, optional header/footer parts, and `templates/`. This loader is needed because block themes do not automatically load a child `style.css`. It is a scaffold, not a full theme clone. `theme-write` is **RCE by design** and refuses agent-supplied `.php` whenever PHP CLI linting through `proc_open` is unavailable; non-PHP writes are unaffected. The scaffold's static `functions.php` uses its confined child writer rather than the `theme-write` lint path. Use a dedicated admin application password, do not expose MCP to untrusted callers, and do not feed a write-enabled agent untrusted content. Confinement, validation, linting, backup, and policy gates are mitigations, not absolute security. See the plugin README for the full security model and its explicit Expert overrides.

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
