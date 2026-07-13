# Roadmap

## v0.2 — routing & reach
- **WordPress bridge delivered:** v0.1.2 security hardening ✓; v0.2.0 Developer Mode and per-capability toggles ✓. The companion plugin exposes nine Abilities plus the authenticated `/wp-json/chinvat-bridge/v1/info` handshake.
- **WordPress adapter extension:** discover the bridge and call the Abilities API `run` endpoint through normal Chinvat jobs/policy; not shipped yet.
- **Remaining WordPress v0.2 slices:** child-theme scaffold; mirror-on-write to commit live edits into the site's GitHub repository; separately gated `file-write` and `wp-cli`; RankMath sitewide controls (redirections, 404 monitor, sitemap, modules); plugin install/update/delete.
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
- **Chinvat WP Bridge 0.2.0** companion plugin: nine Abilities, Developer Mode/write toggles, hardened theme writes, option guards, RankMath post metadata, plugin activation/deactivation, and authenticated capability handshake. Hub-side ability invocation remains roadmap work.
- First-class **Connect** flow: per-client config, safe auto-install, endpoint self-test; per-module **Test connection**.

## Standing chores
- Track MCP spec releases (2026-07-28 RC → final) and SDK upgrades.
- Keep the Connect matrix current as clients change their config schemas.
- Add modules by demand; keep each a single reviewable file where possible.
