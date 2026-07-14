# Chinvat WP Bridge

Version 0.4.2 · MIT

Companion WordPress plugin for the [Chinvat](https://github.com/adun-denton/Chinvat) MCP labor hub. The built-in `wordpress` adapter covers core REST operations for posts, pages, media, and taxonomy; this plugin adds guarded option access, active-theme file I/O, runtime-authoritative Global Styles and Site Editor template overrides, block-aware child-theme scaffolding, per-post RankMath fields, and installed-plugin activation/deactivation.

## What ships

The plugin registers 18 WordPress **Abilities** with JSON Schema, WordPress capability checks, and risk annotations. With the WordPress Abilities API and MCP Adapter installed, WordPress can expose them as MCP tools. An authenticated REST handshake at `GET /wp-json/chinvat-bridge/v1/info` reports the plugin/schema versions, environment, Developer Mode, write toggles, and available abilities.

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
| `chinvat-bridge/db-state` | `read` | `edit_theme_options` | — |
| `chinvat-bridge/global-styles-get` | `read` | `edit_theme_options` | — |
| `chinvat-bridge/global-styles-update` | `act` | `edit_theme_options` | **DB Layer (Global Styles & Templates)** |
| `chinvat-bridge/global-styles-reset` | `act` | `edit_theme_options` | **DB Layer (Global Styles & Templates)** |
| `chinvat-bridge/template-list` | `read` | `edit_theme_options` | — |
| `chinvat-bridge/template-get` | `read` | `edit_theme_options` | — |
| `chinvat-bridge/template-update` | `act` | `edit_theme_options` | **DB Layer (Global Styles & Templates)** |
| `chinvat-bridge/template-reset` | `act` | `edit_theme_options` | **DB Layer (Global Styles & Templates)** |

The risk tiers correspond to Chinvat policy: `read` runs at every tier, `act` and `dangerous` pause at `approve`, and `observe` rejects writes.

## Runtime-authoritative DB layer

Block/FSE sites can store user Global Styles in `wp_global_styles` and Site Editor overrides in `wp_template` / `wp_template_part`. These database records override `theme.json` and template files at runtime. Call `db-state` before styling work to learn which layer owns rendering.

- `global-styles-get` returns the theme.json-shaped user config or `exists:false`; `global-styles-update` replaces it or deep-merges when `merge:true`; `global-styles-reset` trashes it by default or permanently deletes it with `force:true`.
- `template-list` reports templates and parts with `source`, `has_db_override`, `has_theme_file`, and `area`; `template-get` returns the runtime-resolved content where DB wins.
- `template-update` creates or updates block markup. New parts accept `area`: `header`, `footer`, `sidebar`, or `uncategorized`. `template-reset` trashes by default, supports `force:true`, and reports whether a theme file remains.

Reads require `edit_theme_options`. Writes also require Developer Mode and **DB Layer (Global Styles & Templates)**. The shared insert helper temporarily removes KSES filters only when the actor lacks `unfiltered_html`; existing template overrides use WordPress's normal `wp_update_post` path. Global Styles writes force the `isGlobalStylesUserThemeJSON` and schema `version` markers required by WordPress.

On the production host that exposed the issue, `wp_update_post` hard-crashed PHP for `wp_global_styles` while insert/delete worked. Version 0.4.2 therefore implements every Global Styles update as hard-delete plus reinsert of the full config. Revisions are lost. A raw server `503` can mean PHP died after a partial mutation; call `db-state` before retrying.

## Block-aware child-theme scaffold

`chinvat-bridge/theme-scaffold-child` creates a fresh child of the active theme's base (`get_template()`, not the active stylesheet), avoiding the unsupported child-of-child case. It writes:

- `style.css` with the required `Template:` header;
- a minimal `theme.json`;
- a trusted plugin-authored `functions.php` that enqueues `get_stylesheet_uri()` on `wp_enqueue_scripts`;
- copies of `parts/header.html` and `parts/footer.html` when the parent supplies them;
- an empty `templates/` directory for block-template overrides.

Block themes do not automatically load a child `style.css`, so the generated `functions.php` supplies that loader. Its contents are static plugin-owned code, not agent input, and the scaffold writes it through its confined child writer rather than the `theme-write` PHP lint path. Inputs are `slug` (default `{parent}-child`), `name`, and `activate` (default `true`). Activation uses `switch_theme`. The result is a block-aware starting point and update-resistant target for `theme-write`; it is not a full clone of the parent theme. The ability and adapter operation `bridge_theme_scaffold_child` are `dangerous`, so Chinvat pauses them for human approval at the `approve` tier.

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

`theme-write`, `theme-scaffold-child`, `options-update`, `plugins-toggle`, and all four DB-layer writes require their matching toggle as well. Every toggle defaults off; the DB toggle is **DB Layer (Global Styles & Templates)**. `rankmath-update` requires Developer Mode but has no separate toggle. `DISALLOW_FILE_EDIT` disables all bridge writes, including non-file writes, in the current implementation.

## Security model

Authentication uses standard WordPress application passwords. Every ability also checks the WordPress capability shown above.

`theme-write` refuses every agent-supplied `.php` write when PHP CLI linting through `proc_open` is unavailable or unsuccessful; non-PHP writes are unaffected. The scaffold-generated `functions.php` is static plugin-authored content and therefore does not use that agent-input lint path.

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

Version 0.4.2 returns `schema_version: 3`. The response includes `version`, `schema_version`, `abilities_api`, `mcp_adapter`, `writes_enabled`, `developer_mode`, individual `toggles` (including `child_scaffold` and `db_layer`), active-theme confinement details, RankMath status, and 18 capability/risk records.

## Chinvat adapter integration

The TypeScript `wordpress` adapter version 0.3.1 calls the Bridge through normal Chinvat jobs and policy. Its separate core REST surface handles posts, pages, media-library management, and block navigation; the Bridge surface exposes 19 fixed operations: `bridge_info`, the original ten ability mappings, and eight DB-layer mappings (`bridge_db_state`, `bridge_global_styles_*`, and `bridge_template_*`). `bridge_info` returns the handshake; the other 18 call the corresponding known ability with the contract below:

```text
read:                    GET    /wp-json/wp-abilities/v1/abilities/{name}/run?input[key]=value
no-argument read:        GET    /wp-json/wp-abilities/v1/abilities/{name}/run?input=
destructive annotation: DELETE /wp-json/wp-abilities/v1/abilities/{name}/run?input[key]=value
other writes:            POST   /wp-json/wp-abilities/v1/abilities/{name}/run  {"input":{"key":"value"}}
```

The Abilities route requires `input` even for a no-argument GET; bare `input=` works, while a JSON query string such as `{}` is not decoded as an object. Destructive-annotated abilities must use DELETE on the deployed API version, and DELETE bodies are ignored, so those inputs use the query string. Only small-scalar operations retain that annotation; content-bearing writes such as `theme-write`, `options-update`, `global-styles-update`, and `template-update` use POST JSON. Query-borne booleans must be sanitized as REST booleans. HTTP annotations are independent of Chinvat policy risk.

The adapter preserves `read` / `act` / `dangerous` risk, uses the configured application password, and reports a detected Bridge version/write state in `health()`. Detection is best-effort: an absent Bridge does not fail core WordPress health. The operation list is static; the adapter does not dynamically expose arbitrary abilities returned by the handshake.

After rebuilding the hub, stdio clients must restart their spawned `node ... --stdio` process; restarting only the HTTP daemon does not reload their adapter. When installing plugin ZIPs, the top-level directory must be exactly `chinvat-bridge/`; wrapper directories create duplicate plugin entries. If WP Admin shows a stale version, trust `bridge_info` or `bridge_plugins_list`.

The next planned slice is export/snapshot-on-approval: read DB overrides, write verified content into the child theme, commit it to GitHub, then reset the DB layer so files become authoritative. Later slices include cache purge, named site targets, revisions/coherence operations, separately gated `file-write` and `wp-cli`, RankMath sitewide operations, and plugin install/update/delete.

## License

MIT.
