# Chinvat documentation

This page is the documentation map. Start here when you are not sure which file is authoritative for a question.

## Hierarchy

```text
README.md                         product overview and first entry point
AGENTS.md                         operational handover for coding/desktop agents

docs/README.md                    this map and documentation maintenance rules
docs/GETTING-STARTED.md           first successful installation and delegated job
docs/CONFIGURATION.md             hub, authentication, modules, jobs, and approvals
docs/MODELS.md                    Ollama, OpenRouter, and OpenAI-compatible workers
docs/MODULES.md                   complete built-in module reference
docs/REMOTE-NODES.md              federated hubs over a private mesh

docs/ARCHITECTURE.md              current implementation architecture
docs/DESIGN-*.md                  subsystem design and security decisions
docs/spike/                       experiments, measurements, and rejected paths
docs/DEVELOPMENT-PLAN.md          current development baseline and execution order
docs/ROADMAP.md                   future work and known open slices

clients/                          coordinator-specific connection instructions
app-bridges/                      app-side setup for Blender, GIMP, Rhino, Gmail, etc.
wp-plugin/chinvat-bridge/         optional WordPress companion plugin
```

## Choose by task

| Need | Read |
|---|---|
| Install Chinvat and run one job | [Getting started](GETTING-STARTED.md) |
| Configure ports, auth, modules, jobs, or approvals | [Configuration](CONFIGURATION.md) |
| Select and operate model workers | [Models](MODELS.md) |
| Look up an operation or module prerequisite | [Modules](MODULES.md) |
| Connect Codex, Claude, Cursor, Hermes, or another client | [Client guide](../clients/README.md) |
| Run another computer as a governed worker | [Remote nodes](REMOTE-NODES.md) |
| Understand jobs, policy, transports, and trust boundaries | [Architecture](ARCHITECTURE.md) |
| Understand the human-gated coding relay | [Mail Relay design](DESIGN-mail-relay.md) and [Gmail setup](../app-bridges/gmail/SETUP.md) |
| Understand Blender/GIMP/Rhino/Orca bridges | [Local-app bridge design](DESIGN-local-app-bridges.md) |
| Understand the browser-automation direction | [WP-00 empirical report](spike/WP-00-REPORT.md) |
| See what is next | [Roadmap](ROADMAP.md) |
| Hand work to another coding agent | [AGENTS.md](../AGENTS.md) |
| Read the Persian guide | [راهنمای فارسی](fa/README.md) |

## Authority order

When documents disagree, use this order:

1. Shipped code and passing tests.
2. Module-specific setup/reference documents.
3. `ARCHITECTURE.md` and `CONFIGURATION.md`.
4. `DEVELOPMENT-PLAN.md` and `ROADMAP.md`.
5. Spike reports and historical plans.

A spike report is evidence, not a promise that its prototype is production code. A roadmap item is intent, not a shipped capability.

## Current system shape

Chinvat is one governed MCP labor hub per machine. A hub owns its own module registry, policy tiers, job ledger, approvals, artifacts, REST API, WebSocket event stream, dashboard, and MCP transports. Hubs can federate through `remote-node`; they do not merge their policy or ledgers.

The shipped built-in set is 20 modules:

- Models: `ollama`, `openrouter`, `openai-compatible`
- Machine/infrastructure: `system`, `coolify`, `remote-node`
- Local apps: `blender`, `orca`, `gimp`, `rhino`
- Publishing/commerce: `wordpress`, `woocommerce`
- Messaging/social: `telegram`, `whatsapp`, `facebook`, `instagram`, `linkedin`, `x`
- Relay: `gmail`, `chat-relay`

## Maintenance rules

- Update `MODULES.md`, `ARCHITECTURE.md`, `README.md`, and the smoke-test module count when adding or removing a built-in module.
- Put operational setup in the nearest module/app guide; link it from the hierarchy instead of copying long instructions into several files.
- Keep `ROADMAP.md` future-facing. Move delivered work into the shipped section or the relevant reference guide.
- Mark experiments with status, environment, and whether they were actually executed.
- Document security boundaries beside the feature that creates them.
- Do not put credentials, private host addresses, or client payloads in documentation.
