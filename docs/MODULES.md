# Modules guide

The dashboard **Modules** page is the primary configuration surface. Every worker has:

- an enabled switch;
- a policy tier: `observe`, `approve`, or `autonomous`;
- schema-driven configuration fields;
- a health check through **Test connection**;
- fixed operations with declared `read`, `act`, or `dangerous` risk.

Health proves the configured endpoint or identity can answer. It may not prove every optional scope, product entitlement, credit balance, or destructive action. After health succeeds, test one real low-impact operation.

Chinvat registers 20 built-ins:

```text
ollama openrouter openai-compatible system telegram wordpress woocommerce
coolify blender orca gimp rhino whatsapp facebook instagram linkedin x
gmail chat-relay remote-node
```

First-boot enabled: `ollama`, `openrouter`, `system`, `telegram`, `wordpress`. The rest are disabled until configured.

## Model workers

### `ollama` — local models

Fields: base URL (`http://127.0.0.1:11434`) and default model (`qwen3`).

Operations: `chat`, `generate`, `embeddings`, `list_models`, `pull_model`. Inference and inventory are `read`; model pulling is `act`. Default tier: `autonomous`.

`chat` and `generate` forward top-level `think` and `format` values, including JSON Schema objects. Ollama is in the default `ephemeralModules` allowlist, so read operations may use `adapter_invoke {ephemeral:true}` with no persistence.

### `openrouter` — hosted specialists

Fields: API key, default model, and allowlists for private models/providers. The base URL is fixed to `https://openrouter.ai/api/v1`.

Operations: `chat`, `private_chat`, `list_models`, `key_info`. `private_chat` is ephemeral-only, validates the live zero-data-retention endpoint inventory, pins an allowlisted route, denies fallbacks/data collection, and returns the actual route used. Default tier: `autonomous`.

### `openai-compatible` — direct compatible endpoints

Use one worker for NVIDIA NIM/Nemotron, Groq, Together, Azure, LM Studio, vLLM, and similar APIs.

Fields: base URL, provider API key, default model, optional custom headers JSON. The base URL is normalized to one `/v1`.

Operations: `chat`, `list_models`, `embeddings`. Inference is `read`. Provider-named instances are not shipped yet.

## Machine and infrastructure

### `system` — shell, files, processes, and applications

Default tier: `approve`.

Key operations:

- reads: `list_dir`, `read_file`, `process_list`, `system_info`;
- acts: `write_file`, `move_path`, `open_app`;
- dangerous: `run_command`, `delete_path`.

Filesystem access is fenced by `allowedRoots` (array or semicolon/comma-delimited string). Legacy `allowedRoot` remains supported. Relative paths resolve under the first root. `allowFullAccess:true` disables the fence deliberately.

On Windows, the adapter repairs stripped MCP launcher environments before spawning (`PATHEXT` and `ComSpec`) and its health check requires real child-process stdout evidence. This prevents detached/no-output false success.

### `coolify` — managed workloads

Connects to a self-hosted Coolify API with a scoped token. Inventory covers servers, projects, applications, databases, services, deployments, and a compact infrastructure overview.

Reads run immediately. Deploy/start/restart/validate are `act`; downtime-causing stop/cancel operations are `dangerous`. Use a team-scoped token with only required permissions, never a root token. This worker manages resources represented inside Coolify, not raw OpenStack infrastructure.

### `remote-node` — other Chinvat hubs

Version `0.1.0`, disabled by default, tier `approve`.

Fields: `nodes` JSON array of `{name,url,token,note?}`, `timeoutMs`, and `allowInsecureHttp`.

Operations:

| Operation | Risk |
|---|---|
| `nodes_list`, `node_health`, `node_workers`, `node_capabilities` | read |
| `node_job_status`, `node_job_result` | read |
| `node_invoke`, `node_job_cancel` | act |
| `node_invoke_privileged` | dangerous |

Each node is a complete governed hub with its own modules, tiers, approvals, and ledger. Plain HTTP is accepted only for loopback, RFC1918, Tailscale/Headscale ranges, or `*.ts.net`; public hosts require HTTPS unless explicitly overridden. Off-box nodes require a token. Embedded URL credentials are refused and tokens are never returned.

`node_invoke` resolves remote risk before submission and refuses remote `dangerous`. `node_invoke_privileged` additionally requires `confirm:"REMOTE_EXECUTE"`; the node’s own policy still applies.

Current limitation: use async for non-read calls that may wait for approval, because a sync timeout can hide the returned remote job id. There is not yet a remote jobs/approvals list operation. See [Remote Nodes](REMOTE-NODES.md).

## Publishing and commerce

### `wordpress` — core REST plus optional WP Bridge

Configure site URL, username, and a WordPress Application Password.

Core REST covers site info, posts, pages, categories, tags, media, featured media, and `wp_navigation`. Creation makes drafts; publishing and destructive content/navigation operations are `dangerous`.

Media upload accepts exactly one source:

- bounded public `source_url`, with redirect/address/MIME checks; or
- `content_base64` with filename and MIME, suitable after an authenticated connector downloads a private file.

The optional [Chinvat WP Bridge](../wp-plugin/chinvat-bridge/README.md) `0.4.3` exposes 18 WordPress Abilities plus an authenticated schema-4 handshake. The TypeScript adapter maps them to 19 fixed `bridge_*` operations—no arbitrary ability discovery—including options, theme files, RankMath, plugin toggle, child-theme scaffold, DB state, Global Styles, and Site Editor templates/parts.

Bridge writes require Developer Mode and their dedicated toggles. `bridge_theme_write` and `bridge_theme_scaffold_child` are `dangerous`. Agent-supplied PHP is parsed by the running Zend engine or a verified CLI fallback and fails closed if no lint backend exists. This reduces risk; it does not make remote code execution safe.

Before style/template work, call `bridge_db_state`. DB overrides win over theme files at runtime. On hosts where WordPress fatals while updating `wp_global_styles`, the bridge uses delete-and-reinsert; revisions are lost, so inspect state before retrying an ambiguous `503`.

### `woocommerce` — guarded store management

Separate from `wordpress`, disabled by default, tier `approve`. Configure site URL, a user with `manage_woocommerce`, and a WordPress Application Password.

The worker exposes 144 fixed `/wc/v3` operations with no raw-request escape hatch. It covers catalogue, orders, customers, coupons, shipping, taxes, payment, settings, webhooks, reports, and reference data.

- Reads are `read`.
- Bounded catalogue writes are generally `act`.
- Financial, customer, checkout, configuration, webhook, batch, publication, system-tool, and destructive writes are `dangerous`.

Every write supports `dry_run`. Updates/deletes capture before-state; scalar writes are read back. Permanent deletion, batch deletion, refunds, and system tools require `force:true` plus `confirm:"PERMANENT_DELETE"`. Product creation is forced to draft and status changes go through explicit publication operations.

Targets are validated before credentials are attached. Public stores require HTTPS; local/private HTTP requires `allowInsecureHttp`; link-local/cloud-metadata targets and embedded credentials are always rejected.

## Messaging and social

### `telegram` — messaging and approvals

Fields: bot token, chat id, optional approval buttons and job notifications. Operations include `send_message`, `send_document`, `get_me`, and `get_updates`. Default tier: `approve`.

Only one process should long-poll a bot token. Telegram buttons can approve or deny waiting jobs through the hub facade.

### `whatsapp` — WhatsApp Business Cloud API

Requires a Meta access token and phone-number id. Inside the 24-hour service window use `send_text`; outside it use an approved template through `send_template`. `phone_info` checks configuration.

### `facebook` — Page publishing

Requires a Page id and long-lived page access token with `pages_manage_posts`. Operations include page info, list/create posts, and dangerous deletion.

### `instagram` — business/creator Graph API

Requires an Instagram business/creator account linked to a Facebook Page, its account id, and suitable token. `publish_photo` needs a publicly reachable image URL. Inventory operations are read-only.

### `linkedin` — member publishing

Requires three-legged OAuth and `w_member_social`. Run `me` to obtain the exact author URN. Publishing is side-effecting and should remain approval-gated.

### `x` — X/Twitter API

Requires an OAuth 2.0 user token with `tweet.read`, `tweet.write`, and `users.read`. Operations: `post_tweet`, `delete_tweet`, `me`, `search_recent`. Deletion is `dangerous`; API access tiers and rate limits are provider constraints.

### `gmail` — OAuth2 mail carrier

Disabled by default, tier `approve`. Configure OAuth installed-app `client_id`, `client_secret`, `refresh_token`, optional poll interval, and processed label. Setup: [Gmail module setup](../app-bridges/gmail/SETUP.md).

Operations:

- `send_mail` — `act`;
- `poll_matching`, `read_message`, `list_drafts`, `read_draft` — `read`;
- `label_processed` — `act`.

A short-lived access token is minted per call and not persisted. Gmail is usable standalone, but its primary role is transport for `chat-relay`.

## Local applications

### `blender` — 3D scenes

TCP `127.0.0.1:9876` through the pinned Blender add-on. Read operations: `scene_info`, `object_info`, `viewport_snapshot`. `execute_python` is arbitrary local `bpy` execution, therefore `dangerous` and separately gated by `python_enabled`.

Setup: [Blender bridge](../app-bridges/blender/README.md).

### `orca` — profiles and slicing, not printer control

Launches a pinned CLI-capable Orca-lineage slicer. Fields: executable, slicer data dir, confined project dir, output dir, timeout.

Operations: `profiles_list`, `profile_read`, `slice_model`. Inputs/outputs/profiles are path-confined; resolved profile snapshots are saved beside output for reproducibility. It does not control printers or expose raw G-code editing. Stock Windows OrcaSlicer is currently not headless-capable; use a compatible CLI build such as the tested Anycubic Slicer Next lineage.

### `gimp` — GIMP 3 image bridge

TCP `127.0.0.1:9877` through user-installed `maorcc/gimp-mcp`; the GPL plug-in is not vendored. Read operations: `gimp_info`, `image_metadata`, `snapshot`. `execute_python` is `dangerous` and requires `python_enabled`.

Each GIMP session requires opening an image and selecting **Tools → MCP → Start MCP Server**. Setup: [GIMP](../app-bridges/gimp/SETUP.md).

### `rhino` — Rhino 8 bridge

Framed TCP `127.0.0.1:1999` through the user-installed `jingcheng-chen/rhinomcp` plug-in. Run `mcpstart` each Rhino session.

Read operations: `document_summary`, `object_info`, `viewport_snapshot`. `execute_rhinoscript` is `dangerous` and separately gated by `rhinoscript_enabled`. Setup: [Rhino](../app-bridges/rhino/SETUP.md).

All visual workers return PNG snapshots as artifacts for a vision-capable coordinator. Chinvat itself does not perform visual inference.

## Governed coding relay

### `chat-relay` — repository packet, validation, and apply

Disabled by default, tier `approve`. Fields: default return instruction/address, default lane (`chatgpt`, `gemini`, `generic`), optional file-import directory.

Lifecycle:

```text
compiled → dispatched → imported → validated_pass → applied
                               └→ validated_fail → repair | rejected
```

Operations:

| Operation | Risk | Meaning |
|---|---|---|
| `relay_create`, `relay_import`, `relay_status`, `relay_list`, `relay_repair` | read | compile/parse/inspect; no execution or live mutation |
| `relay_dispatch`, `relay_validate`, `relay_reject` | act | egress, scratch execution, or scratch cleanup |
| `relay_apply` | dangerous | mutate the live repository branch |

The packet compiler refuses tracked secret files, redacts inline credential patterns, computes a classification, and enforces the caller’s ceiling. Replies must match `TASK_ID`, `PACKET_SHA`, and `BASE_COMMIT`. Validation occurs in a disposable worktree. Gmail is an optional carrier; clipboard and file remain first-class transports.

See [Mail Relay design](DESIGN-mail-relay.md).

## Adding an external module

Create `modules/<name>/index.mjs` or `index.js` exporting a default adapter (or `adapter`) implementing `ChinvatAdapter` from `hub/src/types.ts`. At boot it is loaded, materialized in config, defaults to tier `approve`, and appears in the dashboard.

Keep external adapters small, fixed-surface, and explicit about risk. Do not expose arbitrary method/path escape hatches where a bounded operation catalogue is possible.
