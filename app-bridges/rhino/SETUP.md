# Rhino bridge setup

The Chinvat `rhino` module speaks to the **rhinomcp** Rhino plugin by
[Jingcheng Chen](https://github.com/jingcheng-chen/rhinomcp) (MIT, third-party
— not McNeel) over loopback TCP `127.0.0.1:1999`. The plugin is **not
vendored** in this repo: it is a compiled RhinoCommon plugin distributed
through Rhino's own package manager, so you install and update it there.
Chinvat talks straight to the plugin's TCP listener — the project's Python MCP
server (`uvx rhinomcp`) is not needed and should not be running alongside.

Requires **Rhino 8** (Windows or macOS). Protocol pinned against rhinomcp
release **0.3.x**: 4-byte big-endian length-prefixed JSON frames in both
directions. Plugins older than the framing change will produce a clear
"unframed response" error from the module — update the plugin.

## Install (once)

1. In Rhino: **Tools → Package Manager**.
2. Search **`rhinomcp`**, click **Install**.
3. Restart Rhino.

## Activate (every Rhino session)

Type **`mcpstart`** in the Rhino command line. This starts the TCP listener on
:1999. `mcpstop` ends it. It does **not** autostart — a healthy machine with
Rhino open still shows the module unhealthy until you run `mcpstart`.

Activation model comparison (see design doc §Dashboard backlog):
Orca = no app needed · Blender = app + N-panel Connect click ·
GIMP = app + per-session Tools→MCP→Start · **Rhino = app + per-session `mcpstart`**.

## Operations (v0.1 connection slice)

| op | risk | notes |
| --- | --- | --- |
| `document_summary` | read | objects, layers, counts |
| `object_info` | read | by `id` (GUID) or `name` |
| `viewport_snapshot` | read | PNG artifact; viewport/width/height/zoom_to_fit; image returned inline (base64) — no temp file |
| `execute_rhinoscript` | dangerous | RhinoScript-Python; gated on the `rhinoscript_enabled` toggle (default off) |

## Security notes

- The plugin's listener is unauthenticated — loopback only. The module's
  bridge refuses non-loopback hosts by construction.
- `execute_rhinoscript` is arbitrary local code execution by design; the
  toggle default is off. The plugin also exposes `run_command` and C#
  execution, which this module deliberately does not surface in v0.1.
- Test without Rhino: `node scripts/test-rhino-bridge.mjs <repoRoot>`
  (mock framed server; run after `tsc` build).
