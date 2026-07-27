# Chinvat development plan

This is the current execution baseline. The original July 2026 v0.1 scaffold is historical: the core hub, dashboard, policy, durable jobs, connection workflow, 20 built-in modules, bearer auth, remote-node federation, Mail Relay, local-app bridges, guarded WordPress/WooCommerce surfaces, and the first browser spike have shipped.

## 1. Product direction

Chinvat is a governed labor market for AI and software workers, not a generic MCP proxy. Coordinators plan; Chinvat discovers workers, persists delegated jobs, applies risk policy, obtains human approval, records artifacts/results, and composes local machines and remote hubs.

The architecture must preserve:

- client-agnostic MCP control
- durable, inspectable job state
- explicit operation schemas and risk
- local human gates for consequential actions
- replaceable workers and transports
- independent trust domains per hub
- evidence-driven expansion rather than broad raw-tool surfaces

## 2. Current delivered baseline

### Core

- MCP stdio and Streamable HTTP
- dashboard, REST, WebSocket events
- SQLite jobs, events, approvals, parent/child lineage, recovery
- policy tiers: observe / approve / autonomous
- artifacts and bounded operation results
- safe coordinator connection/merge workflow
- bearer auth and fail-closed non-loopback bind policy

### Workers

Twenty built-ins spanning models, Windows/system, infrastructure, local creative apps, WordPress/WooCommerce, social/messaging, Gmail/relay, and remote hubs. External drop-in modules load at boot.

### Major governed subsystems

- WordPress core REST plus optional WP Bridge abilities
- guarded WooCommerce fixed-operation surface
- Blender, GIMP, Rhino, and Orca local-app bridge family
- Mail Relay packet/validation/apply lifecycle
- remote-node hub federation
- ephemeral read-only invocation for allowlisted modules
- hardened private OpenRouter routing

### Browser research

WP-00 Track B/C supports an adapter + governed data-plane architecture on Playwright and rejects a custom browser driver protocol for now. Track A connection modes remain unmeasured on the intended Windows/headed environment.

## 3. Immediate reliability work

Complete these before adding another remote node or making the GPU path operational:

1. **TASK-CHINVAT-008a — preserve remote job identity.** Automatically use async for remote non-read operations, or otherwise return the remote job id before a local sync timeout can lose it.
2. **TASK-CHINVAT-008b — remote recovery surfaces.** Add remote job and approval listing so an operator can recover lost ids and inspect waiting work.
3. **TASK-CHINVAT-008c — fail process on listen failure.** Exit non-zero when the HTTP listener cannot bind, especially `EADDRINUSE`, so supervisors can restart or alert correctly.
4. **Configuration lifecycle.** Decide and implement explicit reload/restart behavior; do not leave dashboard and stdio processes silently divergent.
5. **Hub settings surface.** Add safe editing for bind/port/auth without locking the operator out mid-form.

## 4. Remote GPU/media node slice

After the remote reliability defects:

1. Verify Ollama service and pulled models on the node.
2. Verify NVIDIA driver, VRAM, and CUDA availability.
3. Install and validate ComfyUI.
4. Implement a ComfyUI adapter against its HTTP/queue API, following Chinvat policy rather than wrapping it as an opaque shell call.
5. Define artifact movement, queue ownership, cancellation, health, and long-job async behavior.
6. Add a reproducible deployment/service recipe for Windows nodes.

The node remains a complete independent hub. The coordinator must not bypass its local policy or job ledger.

## 5. Browser/data-plane slice

Before production implementation:

1. Run WP-00 Track A on Windows with headed Chrome, a persistent profile, extension path, and a human approval flow.
2. Fix the supported connection model from measured evidence.
3. Build the smallest production surface:
   - direct Playwright runtime
   - adapter interface with stable entity identity
   - record/data-plane envelope with coverage accounting
   - consequence-bound proposal and exact canonical hashing
   - approval, deterministic verification, and hash-chained ledger
   - one read-only platform adapter
4. Keep positional DOM paths prohibited for consequential actions.
5. Use paired value/shape digests; do not use structure-only state hashes.
6. Do not import the disposable spike or build a custom driver protocol without new evidence.

## 6. Routing and persistent orchestration

Once reliability and observability are stable:

- `module:"auto"` routing using declared capability, privacy, cost, latency, availability, and historical outcome
- objectives that persist across restarts and accumulate child results
- scheduled and event-triggered work
- artifacts browser and job re-run with edited args
- named instances of OpenAI-compatible providers

Routing must remain inspectable: the selected worker, reason, and fallback behavior belong in the job record.

## 7. Hosted and multi-user phase

Bearer auth is shipped but is only hub authentication. Hosted/multi-user work requires:

- TLS deployment recipes
- OIDC or equivalent identity
- per-user access levels mapped to modules, operations, and risk ceilings
- approval routing by role
- fleet dashboard over several hubs
- audit export and retention controls

Do not represent the current bearer token as multi-user authorization.

## 8. Definition of done for any slice

A slice passes only when:

- operation schemas and risk labels are explicit
- policy cannot be bypassed through a raw escape hatch
- failure is visible and recoverable
- persistent state survives restart where promised
- secrets are bounded to their intended service
- cancellation/timeouts are defined
- tests cover the safety invariant, not only the happy path
- Windows deployment is exercised for Windows-specific behavior
- user, architecture, module, roadmap, and agent-handover docs are reconciled

## 9. Documentation discipline

Use `docs/README.md` as the map. Reference docs describe what ships; design docs explain subsystem decisions; spike reports preserve evidence; the roadmap contains only future or open work. When a feature ships, update all authoritative entry points in the same change.
