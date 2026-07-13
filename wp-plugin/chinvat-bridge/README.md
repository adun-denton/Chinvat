# Chinvat WP Bridge

Version 0.1.0 · MIT

Companion WordPress plugin for the [Chinvat](https://github.com/adun-denton/Chinvat) MCP labor hub. It gives an agent the extended admin access that core REST (and general-purpose MCP plugins) don't expose — theme file I/O, arbitrary options, RankMath SEO, and plugin management — behind capability checks, a schema-validated contract, and an explicit `wp-config.php` opt-in.

## Overview

Each capability is registered as a WordPress **Ability** (`wp_register_ability`) with a JSON Schema, a per-operation `permission_callback`, and `readonly`/`destructive`/`idempotent` annotations. When the WordPress Abilities API and MCP Adapter are installed, those abilities are exposed as MCP tools automatically, with the annotations mapped to protocol risk hints. The plugin also registers a thin REST handshake route, `GET /chinvat-bridge/v1/info`, which the Chinvat adapter calls first to learn the plugin version and which capabilities are live — so adapter and plugin never drift.

## Requirements

- WordPress 6.4+
- PHP 7.4+ (PHP CLI reachable via `proc_open` for the theme-write lint gate)
- Optional: the WordPress Abilities API + MCP Adapter plugins — without them the plugin still serves the REST handshake and the Chinvat adapter falls back accordingly
- Optional: RankMath, for the two `rankmath-*` abilities

## Installation

1. Copy the `chinvat-bridge` folder to `wp-content/plugins/`.
2. Activate it from the Plugins screen.
3. Create an application password (Users → Profile → Application Passwords) for the account the hub will authenticate as.
4. To enable any write, add the opt-in described below to `wp-config.php`.

## The kill switch

Every write is inert until the site owner adds, to `wp-config.php`:

```php
define( 'CHINVAT_BRIDGE_ENABLE', true );
```

Without it, `read`-tier abilities still run (subject to their capability check) but every `act`/`dangerous` operation returns `chinvat_writes_disabled`. The plugin also honors `DISALLOW_FILE_EDIT`: if that is true, theme writes are refused regardless. Remove the constant (or set it `false`) to instantly cut all write access without deactivating the plugin.

## Capabilities

Risk tiers map to Chinvat policy (`read` runs at every tier; `act` pauses at the approve tier; `dangerous` pauses at approve and is logged at autonomous).

| Ability | Risk | Capability | Notes |
|---|---|---|---|
| `chinvat-bridge/options-get` | read | `manage_options` | denylist-guarded (auth keys/salts/secrets blocked) |
| `chinvat-bridge/options-update` | act | `manage_options` | denylist-guarded |
| `chinvat-bridge/theme-list` | read | `edit_themes` | active (child) theme only |
| `chinvat-bridge/theme-read` | read | `edit_themes` | path-allowlisted |
| `chinvat-bridge/theme-write` | **dangerous** | `edit_themes` | lint + backup + allowlist (see below) |
| `chinvat-bridge/rankmath-get` | read | `edit_posts` | per-post; requires RankMath |
| `chinvat-bridge/rankmath-update` | act | `edit_posts` | per-post; requires RankMath |
| `chinvat-bridge/plugins-list` | read | `activate_plugins` | |
| `chinvat-bridge/plugins-toggle` | act | `activate_plugins` | activate / deactivate |

## Security notes

Authentication is standard WordPress REST auth via **application passwords** — no custom token scheme. Every ability runs its own `permission_callback` (the capability column above); a failure returns a generic error so it doesn't leak which check failed. Sensitive argument keys are redacted from logs.

**Writing a file into the theme is remote code execution by design.** `theme-write` is therefore wrapped in layered safeguards, all required:

1. `edit_themes` capability, and `DISALLOW_FILE_EDIT` honored.
2. Path confined to the active child theme: the target is resolved with `realpath` and rejected unless it sits strictly inside `get_stylesheet_directory()` — no `..`, no symlink escape, no parent-theme writes.
3. Extension allowlist (`php, css, js, json, html, twig, txt, md`), filterable.
4. For `.php`, the content is written to a temp file and checked with `php -l` before commit; a parse error aborts the write. If PHP can't be invoked, the write is refused rather than risked.
5. The prior version of the file is copied to a timestamped `.chinvat-bak/` sibling before overwrite, and the backup path is returned.
6. Every write is auditable via the Abilities API `wp_after_execute_ability` hook.

Consider whether WP-CLI over SSH already covers your theme-editing needs with no new web-facing surface before enabling this route.

## Handshake response

`GET /chinvat-bridge/v1/info` (requires `manage_options`) returns:

```json
{
  "plugin": "chinvat-bridge",
  "version": "0.1.0",
  "schema_version": 1,
  "abilities_api": true,
  "mcp_adapter": true,
  "writes_enabled": false,
  "theme": {
    "stylesheet": "my-child-theme",
    "template": "my-theme",
    "is_child": true,
    "allowed_root": "/var/www/wp-content/themes/my-child-theme",
    "allowed_extensions": ["php", "css", "js", "json", "html", "twig", "txt", "md"]
  },
  "rankmath": { "active": true, "version": "1.0.0" },
  "capabilities": [
    { "name": "chinvat-bridge/options-get", "risk": "read", "cap": "manage_options" },
    { "name": "chinvat-bridge/theme-write", "risk": "dangerous", "cap": "edit_themes" }
  ]
}
```

## License

MIT.
