# Roadmap

## v0.2 — routing & reach
- `module:"auto"`: route by task type, cost, latency, context window, availability, historical success (metrics already captured per job in v0.1).
- Blender module (Python RPC), browser-automation module.
- Objectives: persistent parent goals that survive restarts and accumulate child results.
- Scheduled + event triggers (cron-like, webhook-in).
- Artifacts browser in dashboard; job re-run with edited args.

## v0.3 — surfaces
- **WordPress destination plugin**: WP-side companion exposing richer, safer operations (Gutenberg blocks, previews, drafts workflow) to the Chinvat WordPress module.
- Tauri desktop shell: tray icon, native notifications, same dashboard inside.
- WhatsApp alternative driver (desktop/browser session) for personal accounts, clearly flagged for ToS risk.
- Module marketplace format: installable module packages with signed manifests.

## v1.0 — remote & multi-user
- Hosted deployment: VPS/cloud image + reverse-proxy/tunnel recipes; hub reachable over TLS.
- AuthN/AuthZ: tokens → OIDC; **access levels per user mapped to modules/operations/risk ceilings** — the "user levels → tool calls" system (e.g. *editor* may `wordpress.create_post` as draft but never `system.run_powershell`).
- Approval routing per level (whose Telegram gets the button).
- Fleet view: one dashboard over several hubs (home PC, office PC, VPS).
- Audit export, retention policies.

## Standing chores
- Track MCP spec releases (2026-07-28 RC → final) and SDK upgrades.
- Add modules by demand; keep each a single reviewable file where possible.
