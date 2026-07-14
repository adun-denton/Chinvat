# Chinvat Local App Bridges — Design Doc

**Status:** Draft for review — no code written yet.
**Scope:** Blender, GIMP, Rhino adapters + shared `local-app-bridge` helper; OrcaSlicer adapter (settings + slicing only — physical print control explicitly out of scope).
**Grounded against:** repo `main` @ `25ecffa` — `hub/src/types.ts` (ChinvatAdapter contract), `hub/src/registry.ts` (module loading), `hub/src/adapters/wordpress.ts` (static-ops pattern).

---

## 1. Architecture

```
AI caller ─MCP─ Chinvat hub
                 ├─ blender adapter ─┐
                 ├─ gimp adapter    ─┼─ lib/local-app-bridge.ts ─TCP/JSON (loopback)─ app-side plugin
                 ├─ rhino adapter   ─┘
                 └─ orca adapter ───── process spawn (pinned CLI) + profile-file I/O   (§5a — no socket, no plugin)
```

Together this makes Chinvat a local **design → slice → (someday: print)** pipeline: Blender prepares and exports STL, Orca turns STL into validated G-code/3MF, both flowing through the same artifact/approval machinery.

One shared transport helper; each app adapter is a thin op-map over it. No MCP-behind-MCP proxying — Chinvat speaks each app's bridge protocol directly. This matches GPT's recommendation and is validated by the fact that all three ecosystems converge on the same wire shape: app-side plugin exposing a loopback TCP socket with newline/length-framed JSON commands.

### Placement: built-in adapters, not external modules (correction to GPT sketch)

`Registry.loadExternal()` only picks up `modules/<name>/index.mjs|index.js` — plain ESM JavaScript with **no TypeScript compile step**. Built-in adapters live in `hub/src/adapters/*.ts` and get typechecking, the shared `tsc -p hub/tsconfig.json` build, and registration alongside `wordpress.ts`.

**Decision:** implement as built-ins:

```
hub/src/lib/local-app-bridge.ts     — shared TCP/JSON client
hub/src/adapters/blender.ts
hub/src/adapters/gimp.ts            (later)
hub/src/adapters/rhino.ts           (later)
app-bridges/blender/                — app-side plugin sources (versioned in monorepo,
app-bridges/gimp/                     installed into each app by the user, like the
app-bridges/rhino/                    WP plugin deploy split: agent develops, user deploys)
```

The `modules/` external path stays available for third parties; nothing about this design forecloses it.

### 1a. How the AI "sees" (vision loop)

Chinvat runs no vision itself. The eyes are the **MCP caller's** — any vision-capable model driving the hub (Claude, GPT, etc.) closes the loop:

```
caller: tasks_submit(blender.viewport_snapshot)
  → add-on captures viewport → base64 → adapter decodes → ctx.saveArtifact()
  → tasks_result returns the artifact path
caller: reads the image with its own file/vision access → reasons about geometry
caller: tasks_submit(next command) → repeat
```

Every app gets a cheap `read`-tier visual-verification primitive for exactly this: Blender `viewport_snapshot`, GIMP `snapshot`, Rhino `viewport_capture`, Orca `preview_toolpath` + the G-code embedded plate thumbnail. This is the operator's Auditor-protocol S4 QA loop (slice screenshots → review → delta) with the human screenshot-ferrying step automated. For callers without vision (lite text models), the hub's `openrouter`/NVIDIA modules can proxy a vision model to describe an artifact — supported but secondary.

---

## 2. Shared helper: `local-app-bridge.ts`

A small client class, not a framework. It consumes what `AdapterContext` already provides rather than duplicating it.

```ts
interface BridgeOptions {
  host: string;            // always 127.0.0.1 in practice; from module config
  port: number;            // from module config, per-app default
  timeoutMs: number;       // per-command; default 30_000, renders may override per-op
  framing: 'newline' | 'raw-json';  // per-app protocol dialect
  token?: string;          // shared-secret auth if/when app-side supports it (§6)
}

class LocalAppBridge {
  constructor(opts: BridgeOptions) {}
  /** One command per connection (connect → send → await reply → close).
   *  Aborts on ctx.signal (Chinvat cancellation) and on timeout. */
  send(cmd: { type: string; params?: object }, signal?: AbortSignal): Promise<BridgeResult>;
  /** Cheap liveness probe for adapter health(). */
  ping(): Promise<boolean>;
}
```

Design choices, with reasons:

- **Connection-per-command, single in-flight command per app.** Blender's add-on executes commands on the main thread via timers; concurrent commands interleave badly. A module-level mutex (promise chain) in each adapter serializes calls. Simpler and safer than pooling.
- **Cancellation = socket close + best-effort.** `ctx.signal` aborts the wait and closes the socket. Fact: none of the three app bridges support mid-command cancellation; a running `bpy` operation completes anyway. The doc-level contract is "cancel abandons the result," not "cancel stops the work." Long renders should go through Chinvat `async` mode.
- **Timeouts are per-operation, not global.** `scene_info` at 10 s; `render` at minutes. The op table (§4) carries a `timeoutMs` hint the adapter passes through.
- **Artifacts via `ctx.saveArtifact()`.** App bridges return images as base64 in the JSON reply (blender-mcp already does this for viewport screenshots); the adapter decodes and saves. Large files (renders, STL, .blend copies) are written by the app to a configured output directory and the adapter reads + saves them, or just returns the path (§5 file policy).
- **Health:** `ping()` with a short timeout; `health()` reports `{ ok, detail: 'blender bridge vX on :9876' }` mirroring the wordpress adapter's best-effort version detection.

---

## 3. Blender (first integration)

**Protocol source:** [`ahujasid/blender-mcp`](https://github.com/ahujasid/blender-mcp) — MIT, verified current. Add-on runs a socket server on `localhost:9876`; commands are JSON `{ "type": string, "params": object }`; replies are `{ "status": "success"|"error", "result"|"message": ... }`.

**Decision:** reuse the *add-on* (the app-side half) as-is; bypass its MCP server entirely. The Chinvat adapter speaks the add-on's TCP protocol directly. MIT → attribution note in README suffices. Fork the add-on into `app-bridges/blender/` (pinned copy) so upstream changes can't silently break the wire contract.

### Op table

| Chinvat op | Add-on command | Risk | Timeout | Notes |
|---|---|---|---|---|
| `scene_info` | `get_scene_info` | `read` | 15 s | object list, counts, active scene |
| `object_info` | `get_object_info` | `read` | 15 s | per-object transform/mesh/materials |
| `viewport_snapshot` | `get_viewport_screenshot` | `read` | 30 s | base64 → `ctx.saveArtifact()` — the visual-verification primitive |
| `execute_python` | `execute_code` | **`dangerous`** | 120 s | arbitrary `bpy`; the universal escape hatch |
| `render` | via `execute_code` (canned script) | `act` | 600 s | output confined to configured dir; artifact-saved |
| `export_stl` | via `execute_code` (canned script) | `act` | 120 s | ditto — the 3D-print money op |
| `save_copy` | via `execute_code` (canned script) | `act` | 60 s | `save_as_mainfile(copy=True)` into output dir; **never overwrite the open file** |
| `import_model` | via `execute_code` (canned script) | `act` | 120 s | path must be inside configured project dir |

**Stance — deliberate departure from GPT's table:** `transform_object` / `add_modifier` as bespoke ops are dropped from v0.1. Real modeling work (your aircraft chess set: import → scale → tilt → socket → export) doesn't decompose into a fixed micro-op vocabulary; it goes through `execute_python` anyway. Canned, parameter-validated scripts cover the high-value structured ops (render/export/save/import); everything else is `dangerous` python with approval. Add micro-ops later only if approval fatigue on `execute_python` proves real.

**Config schema** (`FieldSpec[]`): `host` (default `127.0.0.1`), `port` (default `9876`), `project_dir` (allowed import root), `output_dir` (renders/exports/copies), `python_enabled` (boolean toggle, default **off** — same pattern as the WP bridge's per-capability toggles).

---

## 4. GIMP (second)

**Protocol source:** `maorcc/gimp-mcp` — GIMP 3 plug-in on `localhost:9877`, JSON/TCP, layer/selection/transform/draw ops, snapshot for verification. **GPLv3.**

**Decision (license):** do not vendor GPL code into the MIT monorepo. Two clean options, choose at build time:
1. **Independent app-side plug-in** (preferred): a small GIMP 3 Python plug-in in `app-bridges/gimp/` written against the documented GObject-introspected API — the socket-server half is ~150 lines; the wire *protocol shape* (JSON type/params) is not copyrightable expression, and we implement it fresh.
2. Interim: user installs `maorcc/gimp-mcp`'s plug-in themselves as an optional external dependency; our adapter just speaks to its port. No GPL code enters the repo.

**Decision (operator):** option 2 — user installs the GPL plug-in as an optional external dependency; no GPL code enters the repo. GIMP is a low-value target kept as the **2D-environment testbed**: lessons transfer to Inkscape and others later.

Op sketch (final table when this slice starts): `image_info`, `snapshot` (`read`); `open_copy`, `resize/crop/transform`, `layer_*`, `adjust_*`, `export_png/jpg/webp` (`act`); `execute_python` / script-fu (`dangerous`, toggle-gated, default off).

---

## 5. Rhino (third — better news than "if possible")

**Fact (verified 2026-07-13):** the ecosystem is mature. McNeel ships an **official** [`mcneel/rhinomcp`](https://github.com/mcneel/rhinomcp); community options include [`jingcheng-chen/rhinomcp`](https://github.com/jingcheng-chen/rhinomcp) (MIT; Rhino plugin on TCP `127.0.0.1:1999`, same JSON pattern, drives Grasshopper: find/wire components, set sliders, solve) and larger ones like GOLEM-3DMCP (105 tools, Rhino 8).

**Decision:** defer protocol commitment until this slice starts; evaluate then whether the official McNeel server exposes a direct socket the adapter can speak (as with Blender) or only an MCP surface. Default plan if not: `jingcheng-chen`'s plugin half (MIT, proven wire contract on :1999). Rhino is the one place where MCP-to-MCP proxying might be the pragmatic exception — flag it, don't decide it now.

Op sketch: `document_info`, `object_info`, `viewport_capture` (`read`); `create_geometry`, `boolean_ops`, `export_3dm/stl/step` (`act`); `execute_rhinoscript/python`, Grasshopper definition edits (`dangerous`).

---

## 5a. OrcaSlicer (parallel track — different transport)

**Scope decision (user):** print *settings* and slicing only. No printer control — `upload_gcode`, `start_print`, `cancel_print` and all printer backends (Moonraker/OctoPrint/PrusaLink/Bambu) are **out of scope** for this design. That removes every physically-dangerous op and most of the guardrail surface GPT sketched; what remains is a pure file-in/file-out worker.

**Decision — no fork.** With physical printing out of scope, the fork's main value (a long-lived validated slicer service) disappears. The pinned-CLI wrapper covers the whole remaining op set. Fork (`--chinvat-server` JSON-RPC) stays documented as a Phase-2 contingency *only if* CLI limitations bite in practice — it is not planned work. This also keeps the AGPL boundary trivial: the adapter spawns an unmodified executable; no Orca code enters the MIT repo.

**Fact (verified 2026-07-13):** Orca CLI slicing is real and used in production (Printago runs it headless), shape: `orca-slicer --slice N --load-settings "machine.json;process.json" --load-filaments "filament.json" --export-3mf out.3mf input.stl|3mf`. Known quirks the adapter must absorb: profile values must be **strings even when numeric** (bare numbers break parsing); failures are often silent or cryptic; `--export-3mf` embeds G-code at `Metadata/plate_N.gcode` inside the archive rather than emitting raw `.gcode`; CLI validation differs from GUI and profile-specific crashes exist → **pin a tested Orca build**, never track nightlies.

**Transport:** unlike §3–§5, no socket and no app-side plugin. The adapter is a process-spawn worker (`child_process.execFile`, per-job temp `--datadir` so the GUI's live config is never touched, `ctx.signal` → kill process — real cancellation, better than the socket apps get). It does **not** use `local-app-bridge.ts`; it shares only the adapter contract. Slicing is CPU-bound and can take minutes → default to `async` job mode.

### Op table

| Chinvat op | Mechanism | Risk | Notes |
|---|---|---|---|
| `profiles_list` | read Orca config dir (JSON files) | `read` | machine / process / filament, vendor + user |
| `profile_read` | read JSON | `read` | |
| `profile_diff` | compare two profile JSONs | `read` | |
| `profile_clone` | write derived JSON into user profiles | `act` | vendor presets immutable — clones only |
| `profile_patch` | patch **derived** profile via allowlist | `act` | **broad** allowlist + numeric bounds (`profile-schema.ts`) — see below; raw `machine_start_gcode`/custom G-code keys **denied** — same denylist philosophy as WP options |
| `slice_model` | spawn pinned CLI | `act` | inputs: stl/3mf path (confined to `project_dir`), profile triplet, overrides through the same allowlist; outputs: 3mf + extracted gcode + config snapshot → artifacts |
| `analyze_gcode` | static parse (`gcode-validator.ts`) | `read` | temps, bed/volume bounds, disallowed commands, time/filament estimates |
| `preview_toolpath` | render from parsed gcode | `read` | artifact image; deferred if effort/value poor in practice |

**Snapshot rule (kept from GPT — good):** every `slice_model` saves the exact resolved profile set used as an artifact alongside the G-code, so any print is reproducible and auditable.

### Allowlist scope — decision + lesson from the operator's Auditor protocol (v4.1)

**Decision (operator): broad, not narrow.** The allowlist covers essentially the full process/filament tuning surface — the ~35-section / ~248-parameter space the operator's Anycubic "Profile Auditor" protocol enumerated (quality/precision, walls/shells/infill, full speed/accel/jerk/extrusion-smoothing block, cooling/fans, retraction/z-hop/wipe, seams, bridging, overhangs, supports/tree/raft, skirt/brim, special modes, filament basics: temps, flow ratio, pressure advance, max volumetric speed, shrinkage). Denied stays denied: custom start/end/layer-change G-code, machine limits/geometry, anything that changes what hardware the G-code claims to target.

**Lesson imported (why the old protocol was "too inefficient"):** its FSM forced a lite model to emit values for *all 248 ids* before iterating, with a human ferrying screenshots between model and slicer. The Chinvat design dissolves both bottlenecks structurally: real Orca profiles ARE the baseline (`profile_clone` carries every default; the model only patches deltas — the protocol's S5 with S2's full-coverage burden gone), and §1a's vision loop automates the screenshot ferry. The model is expected to reason from printer model + object geometry + user objective and touch only relevant keys — the FSM's CHANGE-GATE idea (structural input change → recompute the dependent cluster) survives as prompting guidance for callers, not adapter code.

**Config schema:** `orca_path` (pinned executable), `profiles_dir`, `project_dir`, `output_dir`, `max_slice_seconds` (kill timer).

**Field notes (live-validated 2026-07-13, Anycubic Slicer Next 1.4.1.2 = the actual installed Orca-lineage slicer):** the fork keeps the full Orca CLI dialect. Quirks the adapter now absorbs: raw model input requires `--slice 0` + `--arrange 1 --ensure-on-bed` (plate numbers only exist for 3mf projects, and un-arranged objects fail with "Nothing to be sliced"); `--export-3mf` must be a bare filename because the CLI prefixes `--outputdir` itself (absolute paths concatenate into garbage); the CLI helpfully drops a bare `plate_N.gcode` next to the 3mf (no unzip needed for future `analyze_gcode`); slicing is mesh-sensitive — degenerate triangles (e.g. float32 precision loss from exporting meter-scale geometry then upscaling) die in Voronoi/thin-wall processing with cryptic "Errors". Related Blender-side trap: STL is unitless and slicers read units as mm, so meter-scale Blender exports need `global_scale=1000` or a post-scale.

**Deferred with print control (not designed now):** printer backends, heating/homing approval flows, printer-state preconditions. When that day comes, `start_print` is `dangerous` + toggle, per the established pattern.

## 6. Security posture

Same philosophy as the WP bridge: **mitigation is operational, not absolute.** `execute_python` in any of these apps is local code execution by design — exactly like `theme-write` was RCE by design. What the gates buy is *intentionality*, not impossibility.

- **Script execution is permanently `dangerous`** and additionally behind a per-module boolean toggle, default **off** (mirrors `child_scaffold` / Developer Mode precedent). Risk tier → Chinvat's approval flow; toggle → can't even reach approval unless the user opted the module in.
- **File confinement:** canned ops validate paths against `project_dir` / `output_dir` from module config (realpath + prefix check, the same TOCTOU-aware pattern Grok forced on the scaffold). `execute_python` cannot be confined — that's what `dangerous` + toggle is for.
- **Never overwrite source projects by default.** All save/export ops write copies into `output_dir`. Destructive variants, if ever added, are separate `dangerous` ops.
- **Loopback + auth caveat (important, from GPT — correct):** Chinvat binds locally without auth, and so do all three app bridges. Every trusted MCP caller of the hub therefore transitively reaches app scripting. The tier/toggle gates are the control surface. The shared-token field in `BridgeOptions` is spec'd now but only enforceable once app-side bridges we own (GIMP §4 option 1, forked Blender add-on) implement it — a cheap add worth doing when we fork.
- **Grok adversarial pass before commit,** same offload split as before (Grok 4.5 security review; DeepSeek for boilerplate; budget still ~$4.85 headroom).

## 7. Non-goals (v0.1)

No app process lifecycle management (launching Blender/GIMP — user opens the app with the bridge enabled, like activating the WP plugin). No streaming/progress events from apps (Chinvat job logs only). No multi-instance / remote hosts. No runtime capability discovery — static op tables, per the `bridge_*` precedent.

## 8. Build order & validation (decisions locked 2026-07-13)

**v0.1 principle (operator decision 1):** each adapter ships connection-first — transport, health, one read op, one visual op — validated end-to-end before functions accrete in later updates.

1. **Blender**: `local-app-bridge.ts` + `blender.ts` + pinned add-on in `app-bridges/blender/`. Unit-test framing/timeout/abort against a mock TCP server (no Blender needed). Live validation (user-side, like WP deploys): install add-on → enable → `health` → `scene_info` → `viewport_snapshot` artifact.
2. **Orca (§5a) — second, priority (decision 5):** completes the design→slice 3D-printing stack. Acceptance: `slice_model` a Blender-exported STL with a cloned+patched profile; `analyze_gcode` passes bounds checks.
3. **GIMP** — 2D testbed, GPL-install path (decision 2).
4. **Rhino** — bonus to 3D modelling; protocol evaluation (§5) when it starts.
5. Grok adversarial pass gates each commit, as with the scaffold.

**WordPress pause was superseded on 2026-07-14:** live usage resumed the track. Bridge 0.4.2 and adapter 0.4.0 now ship DB-layer state plus Global Styles and Site Editor template/part get/update/reset primitives; core REST also supports existing-page editing, block-navigation editing, media-library management, featured media, and bounded URL/base64 media ingestion. The next WordPress slice is export/snapshot-on-approval; the local-app build order above remains unchanged. The Bridge validation/deployment target is `ehsanmaghsoudi.com`; the 1260 site remains on EasyMCP and is outside this track.

## 9. Resolved questions (operator, 2026-07-13)

1. Lean Blender op table — **agreed**; connection first, functions in later updates.
2. GIMP — **GPL install path**; low-value target, kept as 2D testbed whose lessons transfer to Inkscape etc.
3. Snapshot-on-approval for 3D — **no**; reverting in these apps is easy (undo, file copies), unlike WordPress. Not a priority.
4. WP items — the 2026-07-13 pause was **superseded by live DB-layer work on 2026-07-14** (see §8).
5. Orca — **second in build order**, prioritized over Rhino.
6. `profile_patch` allowlist — **broad** (see §5a): full tuning surface with bounds; the model compensates for printer model, object, and objective.

## Backlog (operator, not scheduled)

- Dashboard UX: newly loaded modules are easy to miss as disabled — either highlight the Enable control for new/never-enabled modules or make new modules enabled by default. (Hit during blender 0.1.0 live validation, 2026-07-13.)
- Session-spawned stdio hubs go stale after a rebuild: the dashboard hub restart doesn't touch them, and 'unknown module' is the only symptom. Consider a version/build stamp in workers_list or an MCP-visible staleness warning. (Workaround found: detached delayed kill of the stale PIDs; the client respawns on next call.)

## 10. Execution plan — token/cost efficiency

Offload split (proven last session; OpenRouter balance ~$9, operator authorizes ≥$5 if it buys quality):

- **Coordinator (me):** API/contract design, op tables, integration into the repo, final review, commits. Repo edits via the established chinvat `system`-module patch-script path.
- **DeepSeek / NVIDIA free pool** (`deepseek/deepseek-v4-flash`, NIM): boilerplate — op-map plumbing, canned `bpy` scripts, `profile-schema.ts` allowlist table generation, test scaffolding. Zero/near-zero cost.
- **Grok 4.5** (`x-ai/grok-4.5`, OpenRouter — cheap, last pass cost ~$0.15): adversarial security review before each commit; also the hard correctness pieces (`gcode-validator.ts` parsing rules, TCP framing edge cases) where a second strong model pays for itself.
- All offloads through the hub's `openrouter` module, artifacts + budget visible in the dashboard.
