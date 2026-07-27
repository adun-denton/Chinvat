# Chinvat — development plan and historical baseline

> **Status:** This document records the original v0.1 architecture and the major deviations that followed. It is not the authority for the current module inventory or shipped behavior. Use [Documentation index](README.md), [Architecture](ARCHITECTURE.md), [Modules](MODULES.md), and [Roadmap](ROADMAP.md) for current state.

## 1. Original vision

Chinvat began as a local MCP labor hub: any coordinator delegates work to local models, hosted specialists, Windows, messaging, and publishing workers; Chinvat persists jobs and gates risky operations behind human approval.

The distinguishing idea remains unchanged: gateways multiplex tools, while Chinvat manages **labor**—durable work with lineage, artifacts, policy, approvals, and an operator-facing ledger.

## 2. Original v0.1 architecture

The baseline design was one Node/TypeScript process with:

- MCP stdio and Streamable HTTP;
- SQLite tables for jobs, events, and approvals;
- risk × tier policy;
- adapter registry with built-ins and external drop-ins;
- React/Vite dashboard over REST/WebSocket;
- artifacts outside SQLite;
- safe coordinator configuration.

That core survived. The system expanded rather than being replaced.

## 3. Original v0.1 definition of done

A coordinator could:

- discover workers and operation schemas;
- submit sync/async jobs with parent/child lineage;
- survive hub restarts and retrieve results/artifacts;
- invoke machine and service workers;
- stop at human approval for risky work;
- supervise jobs from the dashboard.

This baseline is shipped.

## 4. Major delivered expansions

### Worker surface

The initial five-worker core grew to 20 built-ins:

```text
ollama openrouter openai-compatible system telegram wordpress woocommerce
coolify blender orca gimp rhino whatsapp facebook instagram linkedin x
gmail chat-relay remote-node
```

### Authentication and federation

The original plan reserved remote deployment for later. It is now partially delivered:

- bearer authentication on MCP, REST, and WebSocket;
- fail-closed non-loopback binding;
- dashboard token prompt and token-aware Connect snippets;
- federated remote hubs through `remote-node`.

Multi-user roles, OIDC, hosted recipes, and a fleet dashboard remain future work.

### Safer direct inference

- reusable OpenAI-compatible worker;
- hardened OpenRouter private routing with live ZDR route checks and no fallback;
- allowlisted read-only ephemeral invocation with no persistence;
- Ollama reasoning/structured-format forwarding.

### Application and publishing depth

- local bridges for Blender, Orca, GIMP, and Rhino;
- Coolify infrastructure control;
- WordPress core editing plus optional WP Bridge DB/theme/plugin surfaces;
- guarded WooCommerce management with fixed operations and dry-run/confirmation layers.

### Human-gated coding relay

Mail Relay added a provider-neutral repository packet and validation pipeline:

- minimal deterministic context compilation;
- secret and classification firewall;
- verified reply envelope;
- disposable worktree validation;
- dangerous live-branch apply;
- optional Gmail transport, with clipboard/file fallbacks.

### Browser evidence

The WP-00 spike measured observation, approval binding, verification, coverage, token cost, and ledger behavior. It supports a reduced adapter/data-plane direction over Playwright and rejects an early custom general driver protocol.

## 5. Current architecture principles

These are the durable design rules:

1. Coordinators plan; Chinvat governs and executes.
2. Operations have fixed declared risk.
3. Side effects pass through persistent jobs unless a narrow read-only ephemeral path is explicitly allowed.
4. Bounded operation catalogues are preferred to raw method/path escape hatches.
5. Remote machines remain independent governed hubs.
6. Imported model output is inert until deterministic validation.
7. Visual evidence becomes artifacts; Chinvat does not pretend to be a vision model.
8. Code/tests are the authority when historical plans drift.

## 6. Windows deployment baseline

```powershell
git clone https://github.com/adun-denton/Chinvat.git
cd Chinvat
npm install
npm run build
npm start
```

Data defaults to `data/`. Optional autostart exists through `scripts/install.ps1 -Autostart`.

Operational lessons added after deployment:

- never clone into `C:\Windows\System32`;
- avoid mixing elevated and unelevated processes/files;
- restart separate stdio hubs after config/code changes;
- verify the listening port, not only process liveness;
- use a private mesh and strong token for remote nodes.

## 7. Current development priorities

The active priorities are maintained in [Roadmap](ROADMAP.md). Near-term work is dominated by:

- remote-node reliability and discoverability;
- ComfyUI/GPU-node integration;
- top-level settings and config reload behavior;
- the reduced browser adapter/data-plane path;
- WordPress DB-to-file snapshot/export;
- automatic worker routing and durable objectives.

## 8. Definition of done for new work

A feature is not complete when code merely compiles. It should include, where applicable:

- fixed capability schemas and risk declarations;
- conservative default tier and explicit activation;
- target/credential validation before secrets are attached;
- bounded inputs/outputs and cancellation;
- deterministic verification for side effects;
- tests for policy and failure paths;
- Windows build/smoke verification for native dependencies;
- updates to `README`, `MODULES`, `ARCHITECTURE`, `CONFIGURATION`, or `ROADMAP` as required;
- no contradictory built-in counts, security posture, or shipped/planned status.
