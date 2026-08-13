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

Non-interactive invocation uses the same preflight and processing policy:

```powershell
vi-media --preset WP_HERO --in 'D:\Brand\Product-X\Images' --yes
```

Without `--yes`, the tool shows a preflight and asks for confirmation.

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
- Each derivative is written to a unique temporary file, inspected, and then atomically renamed.

Outputs and JSONL run records are placed under:

```text
<source>\processed\<PRESET>\
```

Run records contain technical provenance only: source/output basenames, preset/version/code,
dimensions, source hash, byte size, backend version, timing, status, reason, and warnings.

## Architecture

- `presets.mjs` owns transformation policy and naming codes.
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
