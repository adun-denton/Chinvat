# Chinvat documentation

This directory is the maintained documentation set for Chinvat.

## Start here

- [Getting started](GETTING-STARTED.md) — install, connect a coordinator, and run the first job.
- [Configuration](CONFIGURATION.md) — modules, policy tiers, top-level settings, authentication, and reload behavior.
- [Modules](MODULES.md) — the complete built-in worker catalogue and operational boundaries.
- [Architecture](ARCHITECTURE.md) — process model, job engine, policy, transports, adapters, remote federation, and relay.
- [Remote nodes](REMOTE-NODES.md) — expose a governed hub over a private mesh and call it through `remote-node`.
- [Using models](MODELS.md) — Ollama, OpenRouter, and OpenAI-compatible inference.

## Specialist designs and evidence

- [Local-app bridges](DESIGN-local-app-bridges.md) — Blender, Orca, GIMP, and Rhino transport and safety model.
- [Mail Relay](DESIGN-mail-relay.md) — the human-gated repository packet, import, validation, and apply workflow.
- [Browser spike report](spike/WP-00-REPORT.md) — measured evidence for the reduced browser-automation direction. The spike code is disposable and is not a shipped module.
- [WordPress Bridge](../wp-plugin/chinvat-bridge/README.md) — the optional WordPress companion plugin.

## Planning and operator references

- [Roadmap](ROADMAP.md) — shipped state, immediate defects, and future work.
- [Development plan](DEVELOPMENT-PLAN.md) — historical v0.1 baseline plus a current-state note; not the authority for shipped inventory.
- [Agent handover](../AGENTS.md) — deployment, verification, repository map, and guardrails for coding agents.
- [Coordinator clients](../clients/README.md) — manual MCP connection formats and Connect-page guidance.
- [Persian guide](fa/README.md) — Persian entry point.

## Authority rules

When documents disagree, use this order:

1. Current code and tests on `main`.
2. `README.md`, this index, `CONFIGURATION.md`, `MODULES.md`, and `ARCHITECTURE.md`.
3. Specialist design documents for their named subsystem.
4. `ROADMAP.md` for planned work.
5. `DEVELOPMENT-PLAN.md`, old handoffs, and spike plans as historical context.

Keep secrets, deployment tokens, machine addresses, and client payloads out of documentation. Deployment-specific handoffs may record operational history, but the repository docs should describe reusable behavior and known limitations.
