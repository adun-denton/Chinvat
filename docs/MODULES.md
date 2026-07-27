# Modules guide

Every module is configured on the dashboard's **Modules** page. Secrets live only in `data/chinvat.config.json` and are sent only to the configured service. Each module has a policy tier: `observe`, `approve`, or `autonomous`.

Chinvat ships 20 built-ins:

`ollama`, `openrouter`, `openai-compatible`, `system`, `telegram`, `wordpress`, `woocommerce`, `coolify`, `blender`, `orca`, `gimp`, `rhino`, `whatsapp`, `facebook`, `instagram`, `linkedin`, `x`, `gmail`, `chat-relay`, and `remote-node`.

The first-boot enabled set is `ollama`, `openrouter`, `system`, `telegram`, and `wordpress`. Other built-ins remain disabled until configured.

## Model workers

### `ollama` — local models

Fields: `Base URL` and `Default model`.

Operations: `chat`, `generate`, `embeddings`, `list_models`, and `pull_model`. `chat` and `generate` forward optional `think`, `format`, and `options`; `format` may be `"json"` or a JSON Schema object. `pull_model` is `act`; inference and discovery are `read`. Default tier: `autonomous`.

### `openrouter` — hosted specialists and private routes

Fields: `API key`, `Default model`, `Private model allowlist`, and `Private provider allowlist`. The base URL is fixed to `https://openrouter.ai/api/v1`.

Operations: `chat`, `private_chat`, `list_models`, and `key_info`.

`private_chat` is ephemeral-only. It requires exact server-side model/provider allowlists, verifies the live ZDR endpoint inventory, rejects implicit caching, denies data collection, disables fallbacks, and checks the actual route. Add `openrouter` to top-level `ephemeralModules` and call with `adapter_invoke` plus `ephemeral:true`.

Default tier: `autonomous`.

### `openai-compatible` — direct compatible APIs

Use one reusable worker for NVIDIA NIM/Nemotron, Groq, Together, LM Studio, vLLM, Azure, and similar endpoints.

Fields: `Base URL`, `API key`, `Default model`, and optional `Custom headers (JSON)`.

Operations: `chat`, `list_models`, and `embeddings`. The base URL is normalized to one `/v1`. Disabled by default; default tier `autonomous`.

## Machine and infrastructure

### `system` — the machine

Operations: `run_command`, `list_dir`, `read_file`, `write_file`, `move_path`, `delete_path`, `open_app`, `process_list`, and `system_info`.

Filesystem controls:

- `allowedRoots`: preferred multi-root fence. Use a list or semicolon/comma-delimited string.
- `allowedRoot`: legacy single-root fallback.
- `allowFullAccess`: explicitly disables the fence.
- Relative paths resolve against the first root.

`run_command` and `delete_path` are `dangerous`; writes/moves/app launches are `act`; reads are `read`. Default tier: `approve`.

### `coolify` — managed server workloads

Fields: Coolify URL, scoped API token, and optional timeout.

Reads cover servers, projects, applications, databases, services, deployments, and compact infrastructure summaries. Lifecycle operations deploy, validate, start, restart, stop, or cancel supported resources. Stop/cancel are `dangerous`. Use a least-privilege team token rather than `root`. Disabled by default; default tier `approve`.

### `remote-node` — complete hubs on other machines

Fields: `nodes` JSON array (`name`, `url`, `token`, optional `note`), `timeoutMs`, and `allowInsecureHttp`.

Operations:

- discovery: `nodes_list`, `node_health`, `node_workers`, `node_capabilities`
- invocation: `node_invoke`, `node_invoke_privileged`
- known-job control: `node_job_status`, `node_job_result`, `node_job_cancel`

Plain HTTP is restricted to loopback, private/RFC1918 targets, Tailscale/Headscale mesh ranges, and `*.ts.net`. Public targets require HTTPS unless explicitly overridden. Non-loopback nodes require tokens.

Normal invocation refuses remote `dangerous` operations. Privileged invocation is itself `dangerous`, requires `confirm:"REMOTE_EXECUTE"`, and remains subject to the remote hub's own tier.

Use async for remote work that may wait for approval. Remote job/approval listing and fail-fast listener behavior remain open MVP defects. See [Remote Nodes](REMOTE-NODES.md). Disabled by default; default tier `approve`.

## Local applications

### `blender`

Connects to the pinned Blender bridge on loopback TCP, normally port `9876`.

Operations: `scene_info`, `object_info`, `viewport_snapshot`, and optional `execute_python`. Python execution is `dangerous` and requires both `python_enabled` and normal policy approval. See [Blender setup](../app-bridges/blender/README.md).

### `orca`

Runs a pinned CLI-capable Orca-lineage slicer. It controls profiles and slicing, not printer control or raw G-code editing.

Operations include profile listing/reading and `slice_model`. Paths must be absolute and model inputs are confined to the configured project directory. Use a shipped printer/nozzle preset triplet rather than inventing a profile. See [local-app bridge design](DESIGN-local-app-bridges.md).

### `gimp`

Connects GIMP 3 to the user-installed `maorcc/gimp-mcp` plugin on loopback TCP, normally port `9877`. The GPL plugin is not vendored into this MIT repository.

Operations: `gimp_info`, `image_metadata`, `snapshot`, and optional `execute_python`. Python is `dangerous` and requires an explicit toggle plus approval. See [GIMP setup](../app-bridges/gimp/SETUP.md).

### `rhino`

Connects to the Rhino MCP plugin on loopback TCP, normally port `1999`. Start the plugin each Rhino session with `mcpstart`.

Operations include document/object reads, viewport snapshots, and optional `execute_rhinoscript`. Script execution is `dangerous` and requires the explicit toggle. See [Rhino setup](../app-bridges/rhino/SETUP.md).

## Publishing and commerce

### `wordpress`

Uses WordPress core REST with an Application Password. Operations cover posts, pages, media, taxonomy, navigation, and optional fixed `bridge_*` abilities supplied by the companion WP Bridge plugin.

Draft creation and bounded metadata edits are lower risk; publication, deletion, navigation changes, theme writes, and scaffolding are consequential. The optional plugin adds guarded theme, options, RankMath, plugin-toggle, Global Styles, and template/part capabilities. See the [plugin guide](../wp-plugin/chinvat-bridge/README.md).

Default tier: `approve`.

### `woocommerce`

Uses authenticated `/wp-json/wc/v3` with 144 fixed operations and no raw-request escape hatch.

Reads run immediately. Catalog writes are `act`; financial, customer, checkout, configuration, webhook, batch, publish, and destructive writes are `dangerous`. Every write supports `dry_run`; high-consequence deletes/refunds/tools require additional force/confirmation fields.

Credentials are attached only after target validation. HTTPS is required except for explicitly allowed private/loopback development stores. Disabled by default; default tier `approve`.

## Messaging and social

### `telegram`

Operations: `send_message`, `send_document`, `get_me`, and `get_updates`. Optional approval buttons can approve/deny jobs from Telegram. Default tier: `approve`.

### `whatsapp`

Uses WhatsApp Business Cloud API. Configure a permanent access token and phone number id. `send_text` works inside the conversation window; outside it use an approved template. Disabled by default; default tier `approve`.

### `facebook`

Uses a Page id and long-lived page access token. Operations include page info, listing, creating, and deleting Page posts. Deletion is `dangerous`.

### `instagram`

For Business/Creator accounts linked to a Facebook Page. Operations include account info, media listing, and photo publication from a publicly reachable image URL.

### `linkedin`

Uses three-legged OAuth with `w_member_social`. Obtain the exact author URN through `me`; publication is consequential.

### `x`

Uses an OAuth 2.0 user token. Operations: `me`, `search_recent`, `post_tweet`, and `delete_tweet`; deletion is `dangerous`. Availability depends on the X API access tier.

## Relay

### `gmail` — mail carrier

Uses the OAuth2 installed-app flow. Store `client_id`, `client_secret`, and `refresh_token`; optional fields control polling interval and the processed-message label. The adapter mints short-lived access tokens per call and does not persist them.

Operations:

- `send_mail` — `act`
- `poll_matching` — `read`
- `read_message` — `read`
- `list_drafts` — `read`
- `read_draft` — `read`
- `label_processed` — `act`

`gmail` is a generic mail worker and the carrier for the Mail Relay lane; it does not own relay lifecycle state. See [Gmail setup](../app-bridges/gmail/SETUP.md). Disabled by default; default tier `approve`.

### `chat-relay` — human-gated coding relay

Compiles a bounded repository packet, dispatches it through mail/clipboard/file, imports an inert response envelope, validates in a disposable worktree, and gates live apply.

Fields: return address/instruction, default lane, and optional file-import directory.

Operations:

- `relay_create`, `relay_import`, `relay_repair`, `relay_status`, `relay_list` — `read`
- `relay_dispatch`, `relay_validate`, `relay_reject` — `act`
- `relay_apply` — `dangerous`

The module owns lifecycle state under `data/relay/<taskId>/` but owns no network transport. Compose `gmail.send_mail` as a child job for the mail lane. Imported replies never execute directly; only `relay_apply` mutates the live branch. See [Mail Relay design](DESIGN-mail-relay.md). Disabled by default; default tier `approve`.

## Adding an external module

Drop a folder under `modules/<name>/` exporting a default object that implements `ChinvatAdapter`. The registry loads `index.mjs` or `index.js` at boot. New external modules default to `approve` and appear in the dashboard automatically.
