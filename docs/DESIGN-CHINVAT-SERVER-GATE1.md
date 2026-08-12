# Chinvat Server Gate 1 — Frozen Control-Plane Contract

Status: frozen for Gate 1 implementation
Date: 2026-08-12

## Governing principle

**Chinvat is a bridge, not a hotel.**

Chinvat Server is an internet-facing capability bridge and coordination surface. It is not a hosted desktop, browser farm, model runtime, VPN, large-file relay, or replacement for Local Chinvat. Local Chinvat remains autonomous and must function when Server is unavailable.

## Shared architecture

```text
AI client
   |
external adapter (MCP first)
   |
Chinvat capability core
contracts / policy / identity / effects
   |
capability resolver
  / \
server provider   node provider
  |                    |
SaaS/API           NodeTransport
                       |
                  Local Chinvat
```

MCP is an adapter, not the canonical internal protocol. External tools are semantic capabilities; generic shell and raw GUI primitives are not exposed through the Server MCP boundary.

## Capability identity

A routable capability instance is identified by:

- logical capability name;
- `principal_ref` — account/credential identity under which the effect occurs;
- provider instance / endpoint identity;
- contract/schema version.

Two providers with different principals are not interchangeable even when they expose the same logical capability.

## Resolver

Default model: resolver chooses; explicit `target` override is optional.

Resolver inputs in Gate 1:

- capability contract match;
- `principal_ref`;
- endpoint/capability liveness;
- effect class;
- execution-mode support;
- static preference order;
- optional explicit target.

Rules:

1. Explicit target must resolve exactly or fail; never fall through to another target.
2. Zero live candidates => `capability_unavailable`.
3. One live candidate => select it.
4. Multiple read candidates sharing the same principal may use a deterministic configured preference.
5. Multiple effectful candidates, differing principals, or otherwise ambiguous candidates => `ambiguous_target`; do not silently choose.
6. Effectful mid-execution failure never triggers re-resolution/failover.
7. Results report `executed_at` and `principal_ref`.

Cost, latency optimization, workload scoring, data-locality scoring, and dynamic load balancing are deferred.

## Execution authority

Execution location and connectivity are orthogonal:

- execution: `local | server`
- connectivity: `online | offline/degraded`

Originator owns coordination state. Executor owns effect truth.

- Server-originated work is coordinated by Server.
- Local-originated work is coordinated locally.
- Local never requires a Server lock to execute.
- No shared distributed ledger, global consensus, or full event replication.

Reconnect exchanges request summaries only.

## Request identity and idempotency

Every request has a globally unique `request_id` (UUIDv7 recommended, origin-attributable prefix permitted). Retries reuse the same ID.

Idempotency is enforced at the executor/effect-producing boundary, not merely by the coordinator.

Provider idempotency classes:

- `native` — backing provider accepts and enforces an idempotency key;
- `chinvat_verifiable` — Chinvat can persist and independently verify the effect against the backing system (for Gate 1 WordPress, stamp `request_id` in draft post metadata);
- `unverifiable` — the backing provider cannot prove whether a timed-out effect committed; automated retry must not risk duplicate effects.

Dedupe/result retention is configurable policy. Gate 1 may use a finite test default but no duration is architectural.

## Request lifecycle / resume

Canonical states may be projected differently by runtimes, but must distinguish:

`created -> dispatched -> accepted/executing -> succeeded|failed|cancelled`

and an explicit `unknown` state for unresolved commit/result-loss cases.

On reconnect, peers exchange only:

- requests they originated that remain unresolved;
- requests they executed whose terminal result may not have reached the originator.

Terminal results are replayed idempotently. Local ledgers, local-originated work, artifacts, files, general logs, and unrelated history are not synchronized to Server.

## Concurrency semantics

Request idempotency does not resolve independent actors modifying the same resource.

Capabilities may declare optional concurrency semantics:

- `none`
- `optimistic`
- `exclusive`

Providers implementing optimistic concurrency may expose `resource_key`, `if_match`, version tokens, or equivalent provider-specific fields. Chinvat supplies the contract vocabulary; conflict resolution remains capability/provider-specific.

## NodeTransport v0

`NodeTransport` is the core-facing abstraction. Gate 1 implements one outbound persistent WSS transport from Local Chinvat to Server.

Required behavior:

- connect/authenticate;
- advertise capability set and schema hashes;
- invoke correlated by `request_id`;
- return result/error;
- heartbeat/liveness;
- reconnect;
- resume request summaries.

No global ordering. Independent requests may complete out of order. Correctness is correlated by request ID.

### Capacity / backpressure

TCP flow control is transport-level only and does not represent application capacity.

Local advertises bounded execution capacity (`max_concurrent`; Gate 1 may use 1–2). Server does not persist a workload queue for remote nodes. If Local is at capacity, invocation returns structured `busy` / retryable status. `busy` is not `unavailable` and must not cause automatic rerouting of effectful work.

### Authentication

Gate 1 uses WSS/TLS plus an application-level device credential. Preferred design: Local-generated asymmetric device key with enrollment/revocation at Server; a bearer token may be used only as the simplest spike if the implementation explicitly keeps device authentication replaceable. mTLS/X.509 lifecycle is deferred.

Excluded from Gate 1: streaming, binary chunking, priority lanes, persistent Server work queues, large-file relay, generic store-and-forward brokering.

## Capability registry

Local module state is local truth. Server stores a soft-state remote view.

Registry separates:

- contract/schema known (`advertised`);
- endpoint/capability currently executable (`live`).

Advertisement includes at minimum endpoint identity, capability name, principal, contract version/schema hash, enabled/disabled state, and capacity metadata.

Endpoint reconnect replaces/supersedes its prior advertisement; do not merge stale inventories.

Invocation-time resolution is authoritative. MCP/tool-list availability is advisory.

Stable proxy tools are preferred for MCP: if a known capability is currently offline/disabled, return structured `temporarily_unavailable` rather than depending on every client to support dynamic tool withdrawal. Client-supported list-change notifications may be emitted but are never required for correctness.

## MCP adapter invariant

Canonical Chinvat capability contracts do not depend on ChatGPT, Claude, or any other MCP client.

Adapters may normalize or degrade representation, and may refuse to expose a capability a client cannot safely represent. Adapter adaptation may change representation, never capability semantics, authorization, effect class, idempotency guarantee, concurrency guarantee, or execution result meaning.

Gate 1 exposes sync-only, small-payload tools. Jobs, streaming, binary transfer, and client-specific emulation are deferred.

Canonical structured error envelope should preserve at least:

- `code`
- `message`
- `retryable`
- `request_id`
- `executed_at`

## Gate 1 scope

Exactly two end-to-end capability paths:

1. Server-native reversible write: `wordpress.create_draft`.
2. Remote-local bounded read: `files.list_dir` restricted to a safe test directory.

Gate 1 must validate:

- MCP adapter -> canonical capability core;
- resolver behavior and optional target override;
- principal-aware routing;
- outbound NodeTransport connection;
- endpoint authentication/enrollment;
- registry advertisement/liveness/schema hash;
- application capacity and `busy` behavior;
- executor-side persisted idempotency for the draft mutation;
- reconnect/resume after lost result;
- `executed_at` and audit records;
- Local autonomous operation while Server is absent.

## Required empirical tests

1. Basic server-native and remote-local invocation in one AI session.
2. Ambiguous-target refusal (simulated second provider).
3. Commit-then-disconnect/kill on `create_draft`; same request ID retry must produce exactly one draft.
4. Reconnect after Wi-Fi interruption, Local sleep/wake, Server restart, endpoint restart, and duplicate socket.
5. Resume unresolved requests without synchronizing full ledgers.
6. Capability becomes unavailable mid-session; MCP call returns `temporarily_unavailable` without core/schema corruption.
7. Schema-hash mismatch is detected and fails closed.
8. Capacity test: flood bounded reads; excess receives `busy` rather than a persistent Server backlog.
9. MCP compatibility baseline across at least two clients/adapters using the same canonical contract.
10. Verify Local Chinvat continues local operation with Server unavailable and reconnect does not upload unrelated local history.

## Explicit deferrals

- browser/desktop automation;
- shell exposure through Server MCP;
- large files and binary relay;
- local LLM streaming;
- general async job platform;
- multi-user tenancy;
- automatic effectful failover;
- load balancing/cost routing;
- mTLS certificate lifecycle;
- Browser Bridge / Android / Familiar / 9Router work.

## Gate decision

Council phase is closed for this layer. Gate 1 implementation may begin. Reopen architecture only if empirical tests reveal a kill criterion: duplicate unbounded effects, Local dependence on Server, persistent Server workload accumulation, client-specific contamination of canonical contracts, or inability to maintain coherent capability identity/liveness.