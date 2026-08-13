# VI Dumb Media Processor

An independently executable, deterministic Chinvat utility for creating technically prepared
image derivatives. It transforms pixels and technical metadata only. It does not classify images,
name content, generate text, perform OCR, choose placements, or call AI models.

## Requirements

- Node.js 20 or newer.
- NConvert on `PATH`, in `NCONVERT_PATH`, or supplied with `--nconvert`.

NConvert is not bundled. Download it from the official XnView NConvert page and review its license;
commercial use requires a paid license.

## Install and invoke

From this directory, `npm link` provides the `vi-media` command:

```powershell
npm link
$env:NCONVERT_PATH = 'C:\Tools\NConvert\nconvert.exe'
vi-media 'D:\Brand\Product-X\Images'
```

On Windows, the checked-in launcher works without `npm link` and forwards every CLI option:

```powershell
.\vi-media.cmd --preset WP_HERO --in 'D:\Brand\Product-X\Images' --yes
```

Non-interactive invocation uses the same preflight and processing policy:

```powershell
vi-media --preset WP_HERO --in 'D:\Brand\Product-X\Images' --yes
```

Without `--yes`, the tool shows a preflight and asks for confirmation.

## Project-owned presets

For a website repository, put a committed `vi-media.config.json` at its root. The processor walks
upward from the input folder and uses the nearest valid project config; built-in presets are used
only when no project config exists. An explicit config path has priority and fails closed if it is
missing or invalid:

```powershell
vi-media --preset SITE_HERO --in '.\assets\incoming' --config '.\vi-media.config.json' --yes
```

The config is a strict versioned JSON contract. It owns that project's preset IDs, safe
modification codes, transformation policy, and compatible minimum processor version. See the
[example config](examples/vi-media.config.json) and the
[project integration guide](docs/PROJECT-INTEGRATION.md).

## Presets

| Preset | Code | Geometry | Too-small behavior | Output |
| --- | --- | --- | --- | --- |
| `WP_HERO` | `HERO` | 1920×800 cover, center | skip | WebP 82 |
| `WP_GALLERY` | `GAL` | fit within 1600×1600 | output at original or bounded size | WebP 82 |
| `WP_THUMB` | `THUMB` | 600×600 cover, center | skip | WebP 82 |

All presets prohibit upscaling, apply orientation before geometry, use NConvert ICC conversion to
sRGB, preserve alpha in WebP, remove metadata after conversion, and validate the derivative before
publishing it. The background field is reserved for a future non-alpha output preset.

## Safety and outputs

- Only top-level `.jpg`, `.jpeg`, `.png`, `.tif`, `.tiff`, `.bmp`, `.gif`, and `.webp` files are
  discovered; traversal is non-recursive.
- Originals are read and hashed, never moved, renamed, overwritten, or passed to a destructive flag.
- Known `_HERO`, `_GAL`, and `_THUMB` derivatives are excluded.
- Existing outputs are skipped. Same-stem collisions are refused before processing.
- Animated/multipage and unreadable files receive explicit skipped/failed outcomes.
- Each derivative is written to a short, unique temporary file inside the output folder, inspected,
  and only then published with an exclusive-create copy that can never overwrite an existing output.
- When a project config is active, its own modification codes define which files are treated as
  existing derivatives; built-in codes are not applied on top of it.

Outputs and JSONL run records are placed under:

```text
<source>\processed\<PRESET>\
```

Run records contain technical provenance only: source/output basenames, preset/version/code,
dimensions, source hash, byte size, backend version, processor version, config source, resolved
config path, config SHA-256/schema/minimum version, timing, status, reason, and warnings.

## Architecture

- `project-config.mjs` loads the strict project-owned preset contract and its SHA-256 provenance.
- `presets.mjs` owns built-in fallback policy and validates the same safe preset shape.
- `processor.mjs` owns discovery outcomes, immutable-source checks, staging, validation, and records.
- `nconvert-adapter.mjs` is the only file that knows NConvert command syntax.
- `cli.mjs` owns the select → verify → run operator flow.

This boundary allows a future executor to replace NConvert without redesigning presets, workflow,
output naming, or records. It is intentionally not a Chinvat Bridge module.

## Test

```powershell
npm test
```

The automated suite uses a deterministic fake backend for policy/orchestration tests and directly
tests NConvert information parsing and command construction. Backend integration should also be run
with real NConvert and deliberately problematic fixtures before production use.
