# Chinvat Blender bridge (app side)

`addon.py` is a pinned copy of the BlenderMCP add-on from
[ahujasid/blender-mcp](https://github.com/ahujasid/blender-mcp) (MIT license),
commit `6e99eb5a442b83766a5796975ec7bb5bfc791341` (2026-06-11).
Only the add-on (app-side socket server) is used; its MCP server is bypassed —
the Chinvat `blender` adapter speaks the add-on's TCP/JSON protocol directly
on `127.0.0.1:9876` via `hub/src/lib/local-app-bridge.ts`.

## Install (user step)
1. Blender → Edit → Preferences → Add-ons → Install… → select `addon.py`.
2. Enable "Interface: Blender MCP".
3. In the 3D viewport sidebar (N), BlenderMCP tab → Connect to Claude (starts the socket server).
4. Chinvat dashboard → blender module → check health.

## Protocol (verified against the pinned commit)
Request `{"type": <cmd>, "params": {...}}` → response `{"status": "success"|"error", "result"|"message": ...}`.
Commands used by the adapter: `get_scene_info`, `get_object_info(name)`,
`get_viewport_screenshot(max_size, filepath, format)`, `execute_code(code)`.

Update policy: pin, never track upstream automatically; re-verify the four
command signatures before bumping the pinned commit.
