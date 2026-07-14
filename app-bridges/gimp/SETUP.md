# GIMP module setup (read this — it differs from other modules)

GIMP is the only Chinvat local-app module with **two manual steps that no other
module needs**. Blender needs a running app + one Connect click; Orca needs no
running app at all (headless CLI). GIMP needs a running app **and** a per-session
menu action that does not autostart, **and** a non-obvious install location.

The plug-in itself is `maorcc/gimp-mcp` (GPLv3) — installed by you, not shipped
with Chinvat. Only Chinvat's MIT adapter talks to its socket (TCP 127.0.0.1:9877).

## 1. Install the plug-in (GIMP 3 folder quirk)
GIMP 3 will NOT load a loose `.py` in `plug-ins\`. It must live in its own
subfolder of the same name:

    <GIMP user dir>\plug-ins\gimp-mcp-plugin\gimp-mcp-plugin.py

On this machine the GIMP user dir is `C:\Users\Ehsan\AppData\Roaming\GIMP\3.2`,
so: `...\GIMP\3.2\plug-ins\gimp-mcp-plugin\gimp-mcp-plugin.py`.
(Preferences → Folders → Plug-ins shows the exact path.) Restart GIMP after.

## 2. Start the server every session (does NOT autostart)
1. Open any image — the menu only appears with an image window.
2. Tools → MCP → **Start MCP Server**. (Same submenu: Check / Restart.)
The status bar / console shows `GimpMCP server started on localhost:9877`.

This is a per-session action: the server is not remembered across GIMP restarts,
so it must be started again each time GIMP is relaunched.

## 3. Verify from Chinvat
Dashboard → gimp module → health should read `gimp bridge reachable on :9877`.
Then `gimp_info` and `snapshot` should work; `execute_python` requires the
`python_enabled` toggle (default off).

## Troubleshooting
- health says "no bridge on :9877" → server not started (step 2) or GIMP closed.
- menu entry missing → plug-in in wrong location (step 1: needs the subfolder).
- snapshot "no image_data" → no image open in GIMP.

## Verified
2026-07-13: GIMP 3.2.4, gimp_info + snapshot returned live (900x1548 image
captured and scaled). Read path confirmed working.
