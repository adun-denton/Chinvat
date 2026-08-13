# Project-owned VI Media configuration

Keep `vi-media.config.json` in the root of each website repository. That committed file is the
image-pipeline source of truth for the repository: it defines the available preset IDs, exact
technical transformations, modification codes, and minimum compatible VI Media Processor version.
The Chinvat tool supplies the deterministic engine only; it does not own a website's image policy.

Start from [`../examples/vi-media.config.json`](../examples/vi-media.config.json), rename the
`SITE_*` IDs and labels for the project, and commit the resulting config with its project
instructions. A config must use `schema_version: 1` and contain one or more strict presets. Unknown
keys, unsafe suffixes, unsupported transformations, duplicate IDs, and duplicate suffixes fail
before any image is processed.

## Local-session handoff

For a new local session or PC:

1. Clone the website repository and read its `vi-media.config.json` before preparing images.
2. Install Node.js 20+ and an appropriately licensed local NConvert binary. NConvert remains
   user-installed and unbundled.
3. Install or clone a VI Media Processor version at least as new as
   `minimum_processor_version` in the project config.
4. Put originals in the project-approved input folder and run the project preset. Discovery walks
   upward from that folder to the nearest `vi-media.config.json`.
5. Review the preflight, keep generated outputs and run records according to the repository's own
   tracking policy, and commit only intentional image-policy changes.

For example, if `assets/incoming` is beneath the repository root:

```powershell
vi-media --preset SITE_HERO --in .\assets\incoming --yes
```

On Windows, a session can invoke the checked-in `vi-media.cmd` launcher from its Chinvat checkout
instead of installing a global command.

The same run can pin an exact config location explicitly. An explicit path always wins; a missing
or invalid explicit config is an error and never falls back to another config.

```powershell
vi-media --preset SITE_HERO --in .\assets\incoming --config .\vi-media.config.json --yes
```

Every JSONL outcome records the selected preset/version and modification code plus processor
version, config source/path, config SHA-256, config schema version, and minimum processor
requirement. This lets later sessions verify which committed policy produced a derivative without
adding AI, Bridge, MCP, or repository-write behavior to the processor.

The config SHA-256 covers the exact bytes read on that PC, including a UTF-8 BOM and line-ending
style. It proves the local policy artifact used for a run; use the website repository commit as the
cross-PC identity because Git checkout settings can produce different bytes for the same JSON.

## Change discipline

- Treat a preset edit as a website-repository policy change: review it, increment that preset's
  `version`, commit it, and preserve the corresponding run records.
- Do not use built-in presets as a hidden fallback once a project config exists. Fix or explicitly
  select the project config instead.
- Keep generated derivatives out of version control unless the website repository explicitly
  requires them. The project config and pipeline instructions should remain committed.
- A config's `minimum_processor_version` is a strict SemVer minimum such as `0.2.0`, not an npm
  range such as `^0.2.0`.
