# Roadmap

## v0.2 — routing & reach
- **WordPress bridge delivered:** v0.1.2 security hardening ✓; v0.2.0 Developer Mode/toggles ✓; v0.3.x block-aware child-theme scaffold/loader ✓; v0.4.0–0.4.2 DB-layer state, Global Styles, and template/part primitives ✓. The plugin exposes 18 Abilities plus the authenticated schema-3 handshake.
- **WordPress adapter extension delivered ✓:** 19 static `bridge_*` operations (handshake + 18 abilities) use the verified GET / DELETE-query / POST-body Abilities contract through normal Chinvat jobs/policy.
- **WordPress core REST editing delivered ✓:** adapter 0.3.1 adds `get_page`/`update_page`, featured-media fields for post/page drafts and updates, authenticated-connector base64 media handoff, and bounded SSRF-aware public URL ingestion.
- **Next WordPress slice:** export/snapshot-on-approval—read verified DB overrides, write them into child-theme files, commit to the site's GitHub repository, then reset the DB overrides so files become authoritative.
- **Later WordPress slices:** cache purge, named site targets, revisions, coherence operations; separately gated `file-write` and `wp-cli`; RankMath sitewide controls (redirections, 404 monitor, sitemap, modules); plugin install/update/delete.
- `module:"auto"`: route by task type, cost, latency, context window, availability, historical success (metrics already captured per job in v0.1).
- **Named openai-compatible instances** (`nvidia`, `groq`, `together`, `lmstudio`, `vllm`, …) once the registry supports multiple instances per provider — the provider layer is already a factory, so each is a one-line registration.
- Blender module (Python RPC), browser-automation module.
- Objectives: persistent parent goals that survive restarts and accumulate child results.
- Scheduled + event triggers (cron-like, webhook-in).
- Artifacts browser in dashboard; job re-run with edited args.

## v0.3 — surfaces
- WordPress editorial workflows beyond the v0.2 bridge slices: Gutenberg blocks, previews, and structured draft review.
- Tauri desktop shell: tray icon, native notifications, same dashboard inside.
- WhatsApp alternative driver (desktop/browser session) for personal accounts, clearly flagged for ToS risk.
- Module marketplace format: installable module packages with signed manifests.

## v1.0 — remote & multi-user
- Hosted deployment: VPS/cloud image + reverse-proxy/tunnel recipes; hub reachable over TLS.
- AuthN/AuthZ: tokens → OIDC; **access levels per user mapped to modules/operations/risk ceilings** — the "user levels → tool calls" system (e.g. *editor* may `wordpress.create_post` as draft but never `system.run_powershell`).
- Approval routing per level (whose Telegram gets the button).
- Fleet view: one dashboard over several hubs (home PC, office PC, VPS).
- Audit export, retention policies.

## Shipped
- Eleven modules incl. the reusable **openai-compatible** worker (NVIDIA NIM/Nemotron, Groq, Together, LM Studio, vLLM, Azure), **X (Twitter)**, LinkedIn, Instagram, Facebook, WhatsApp, WordPress, Telegram, OpenRouter, Ollama.
- **Chinvat WP Bridge 0.4.2 + adapter 0.3.1:** 18 Abilities including runtime-authoritative DB state, Global Styles, and Site Editor template/part get/update/reset primitives; Developer Mode and per-surface toggles; authenticated schema-3 handshake. Hub invocation exposes 19 static `bridge_*` operations with policy-preserving risks and best-effort health detection.
- First-class **Connect** flow: per-client config, safe auto-install, endpoint self-test; per-module **Test connection**.

## Standing chores
- Track MCP spec releases (2026-07-28 RC → final) and SDK upgrades.
- Keep the Connect matrix current as clients change their config schemas.
- Add modules by demand; keep each a single reviewable file where possible.
