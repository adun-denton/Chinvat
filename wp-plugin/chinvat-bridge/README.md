# Chinvat WP Bridge

Version 0.3.0 · MIT

Companion WordPress plugin for the [Chinvat](https://github.com/adun-denton/Chinvat) MCP labor hub. The built-in `wordpress` adapter covers core REST operations for posts, pages, media, and taxonomy; this plugin adds guarded option access, active-theme file I/O, block-aware child-theme scaffolding, per-post RankMath fields, and installed-plugin activation/deactivation.

## What ships

The plugin registers ten WordPress **Abilities** with JSON Schema, WordPress capability checks, and risk annotations. With the WordPress Abilities API and MCP Adapter installed, WordPress can expose them as MCP tools. An authenticated REST handshake at `GET /wp-json/chinvat-bridge/v1/info` reports the plugin/schema versions, environment, Developer Mode, write toggles, and available abilities.

| Ability | Risk | WordPress capability | Write toggle |
|---|---|---|---|
| `chinvat-bridge/options-get` | `read` | `manage_options` | — |
| `chinvat-bridge/options-update` | `act` | `manage_options` | **Options Update** |
| `chinvat-bridge/theme-list` | `read` | `edit_themes` | — |
| `chinvat-bridge/theme-read` | `read` | `edit_themes` | — |
| `chinvat-bridge/theme-write` | `dangerous` | `edit_themes` | **Theme Write** |
| `chinvat-bridge/theme-scaffold-child` | `dangerous` | `edit_themes` (+ `switch_themes` to activate) | **Child Theme Scaffold** |
| `chinvat-bridge/rankmath-get` | `read` | `edit_posts` + access to the post | — |
| `chinvat-bridge/rankmath-update` | `act` | `edit_posts` + access to the post | Developer Mode |
| `chinvat-bridge/plugins-list` | `read` | `activate_plugins` | — |
| `chinvat-bridge/plugins-toggle` | `act` | `activate_plugins` | **Plugins Toggle** |

The risk tiers correspond to Chinvat policy: `read` runs at every tier, `act` and `dangerous` pause at `approve`, and `observe` rejects writes.

## Block-aware child-theme scaffold

`chinvat-bridge/theme-scaffold-child` creates a fresh child of the active theme's base (`get_template()`, not the active stylesheet), avoiding the unsupported child-of-child case. It writes:

- `style.css` with the required `Template:` header;
- a minimal `theme.json`;
- copies of `parts/header.html` and `parts/footer.html` when the parent supplies them;
- an empty `templates/` directory for block-template overrides.

Inputs are `slug` (default `{parent}-child`), `name`, and `activate` (default `true`). Activation uses `switch_theme`. The result is a block-aware starting point and update-resistant target for `theme-write`; it is not a full clone of the parent theme. The ability and adapter operation `bridge_theme_scaffold_child` are `dangerous`, so Chinvat pauses them for human approval at the `approve` tier.

## Requirements and installation

- WordPress 6.4+
- PHP 7.4+
- PHP CLI reachable through `proc_open` for the `theme-write` PHP lint gate
- WordPress Abilities API to register/expose the abilities
- MCP Adapter when WordPress should expose the abilities through MCP
- RankMath only for `rankmath-get` and `rankmath-update`

Install:

1. Copy `chinvat-bridge/` to `wp-content/plugins/` and activate **Chinvat WP Bridge**.
2. Install/activate the WordPress Abilities API and, for direct MCP exposure, MCP Adapter.
3. Create a dedicated application password for an administrator account at **Users → Profile → Application Passwords**.
4. Keep **Developer Mode** and every write toggle off until the exact workflow has been reviewed.

## Developer Mode and write gates

All writes are inert unless **Settings → Chinvat Bridge → Developer Mode** is enabled. The back-compatible `wp-config.php` constant below also forces Developer Mode on:

```php
define( 'CHINVAT_BRIDGE_ENABLE', true );
```

`theme-write`, `theme-scaffold-child`, `options-update`, and `plugins-toggle` each require their own toggle as well. Every toggle defaults off; the scaffold toggle is **Child Theme Scaffold**. `rankmath-update` requires Developer Mode but has no separate toggle. `DISALLOW_FILE_EDIT` disables all bridge writes, including non-file writes, in the current implementation.

## Security model

Authentication uses standard WordPress application passwords. Every ability also checks the WordPress capability shown above.

**`theme-write` is remote code execution by design.** An agent able to write PHP into the active theme can execute code as the web-server user. Operational rules:

- use a dedicated, admin-only application password;
- do not expose the MCP endpoint to untrusted callers;
- do not feed untrusted content to an agent with any write ability enabled;
- disable Developer Mode immediately after the maintenance window.

The v0.1.2/v0.2.0 hardening, informed by two adversarial reviews, adds layered mitigations:

- read/write paths are confined to the active stylesheet theme; traversal and symlink escape are rejected;
- writes use a temporary file and atomic rename;
- PHP content must pass `php -l`; missing lint support fails closed;
- existing files are backed up outside the theme under protected `wp-content/chinvat-bak/` before replacement;
- the default option denylist blocks auth keys/salts, credentials, roles, active plugins, site URLs, secret-like names, and related protected options;
- `chinvat_bridge_settings` is always denied, so an ability cannot enable its own Developer Mode or toggles;
- the bridge and protected security plugins cannot be deactivated through `plugins-toggle`.

The child-theme scaffold adds its own checks:

- the destination must be a fresh directory directly under the theme root; existing paths and symlinks are refused;
- after directory creation, `realpath` and `is_link` re-check confinement to close the create-window/TOCTOU gap;
- every output path segment is validated and the writer refuses overwrites;
- the display name is stripped of comment-breaking characters before it enters the `style.css` header;
- activation requires `switch_themes`, a recognised child with no theme errors, and an installed parent theme.

These are mitigations, not absolute security. The plugin also exposes explicit **Expert: Relax Option Denylist** and **Expert: Relax Backup** settings. They are off by default and materially weaken protection; the bridge's own settings option remains blocked even when the denylist override is enabled.

## Handshake

Authenticated administrators can call:

```text
GET /wp-json/chinvat-bridge/v1/info
```

Version 0.3.0 returns `schema_version: 3`. The response includes `version`, `schema_version`, `abilities_api`, `mcp_adapter`, `writes_enabled`, `developer_mode`, individual `toggles` (including `child_scaffold`), active-theme confinement details, RankMath status, and ten capability/risk records.

## Chinvat adapter integration

The TypeScript `wordpress` adapter calls the Bridge through normal Chinvat jobs and policy. It exposes eleven fixed operations: `bridge_info`, `bridge_option_get`, `bridge_option_update`, `bridge_theme_list`, `bridge_theme_read`, `bridge_theme_write`, `bridge_rankmath_get`, `bridge_rankmath_update`, `bridge_plugins_list`, `bridge_plugins_toggle`, and `bridge_theme_scaffold_child`. `bridge_info` returns the handshake; the other ten call the corresponding known ability with the contract below:

```text
read:          GET  /wp-json/wp-abilities/v1/abilities/{name}/run?input[key]=value
act/dangerous: POST /wp-json/wp-abilities/v1/abilities/{name}/run
               {"input":{"key":"value"}}
```

The adapter preserves `read` / `act` / `dangerous` risk, uses the configured application password, and reports a detected Bridge version/write state in `health()`. Detection is best-effort: an absent Bridge does not fail core WordPress health. The operation list is static; the adapter does not dynamically expose arbitrary abilities returned by the handshake.

Remaining planned slices include mirror-on-write to the site's GitHub repository, separately gated `file-write` and `wp-cli`, RankMath sitewide operations, and plugin install/update/delete.

## License

MIT.
