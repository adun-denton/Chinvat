# Chinvat local tools

This directory is the home for deterministic utilities that complement Chinvat without becoming
Bridge transports, MCP workers, remote-execution primitives, or orchestration components.

Each tool must remain independently executable and keep third-party backends behind a narrow
adapter. A later Chinvat integration may invoke a stable tool; it must not move Bridge concerns
into the utility itself.

Current tools:

- [`vi-media-processor`](vi-media-processor/README.md) — deterministic image derivative creation
  through NConvert.
