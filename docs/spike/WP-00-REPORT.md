# WP-00 — Empirical Browser Spike: Report

**Date:** 2026-07-26 · **Status:** Track B and Track C executed and measured. Track A built, **not executed** (requires the Windows host).
**Authority:** PLAN v1.1 §6 (spike specification), §7 (gate G0).
**Recommendation:** **PROCEED, REDUCED** — build the adapter + Data Plane path; do **not** build a general CBP driver protocol in WP-01/02.

Spike code is disposable and lives at `spike/wp-00/`. Per PLAN v1.1 §11 it must not be imported by any later package. Raw evidence is in `spike/wp-00/results/`.

---

## 0. What was actually run, and where

| Track | Status | Environment |
|---|---|---|
| A — connection modes | **built, UNMEASURED** | needs headed Chrome, a persistent profile, an extension, and a human. The spike host is a headless Linux sandbox; it cannot produce these numbers honestly. |
| B — observation quality | **measured** | Linux, Node v22.22.3, Playwright 1.62.0, `chromium-headless-shell` 151.0.7922.34, viewport 1280×900, 3 repetitions per scenario |
| C — lifecycle + compose baseline | **measured** | same, plus `@playwright/mcp` 0.0.78 over stdio |

Two honesty notes about the environment, because they bound what the numbers mean:

1. **Headless shell, not full Chromium.** The full `chromium` build could not be fetched within the host's command-timeout limits; `chromium-headless-shell` was used instead. AX-tree construction is the same Blink code path, so ref/digest results should transfer, but **headed-vs-headless differences were not measured** and rendering-dependent numbers (hit-test, screenshot) should be re-confirmed on Windows.
2. **No human approved anything.** Track C ran with `--auto-approve`, which issues the approval with the operator recorded as `simulated-operator`. What was tested is the *binding mechanism*, not the human. The interactive path (a real local approval page) is implemented and runnable; it has not been exercised end-to-end with a person.

Track A's absence matters for the G0 ruling and is called out in §7.

---

## 1. Headline findings

1. **Element identity is the project's real risk, and it is solvable — but only with adapters.** A positional DOM-path ref silently resolved to *a different campaign* in **100%** of trials after a routine scroll. An adapter-style ref built on the platform's own entity id had a **0%** silent-mismatch rate across every scenario tested. This is the difference between "the approval landed on campaign X" and "the approval landed on whatever was in row 4."
2. **Generic snapshot refs fail safe but fail often.** The accessibility-path ref never mis-resolved, but went unresolvable under every UI-drift scenario (100%). Safe, unusable for durable automation.
3. **A structure-only digest is worthless and would have shipped.** The "structural skeleton" recipe — plausible, cheap, the kind of thing that gets written on a Tuesday — detected **0%** of semantic changes, including a budget value change. It is a false-validation machine. G2 must be tested against value changes, not just DOM changes.
4. **The adapter path costs ~17× fewer tokens than stock Playwright MCP for the same task**: 992 vs 16,860 estimated tokens (plus 4,617 tokens of tool schema the MCP client pays on every context refresh).
5. **The decisive build-vs-compose result is not cost, it is what the approval can say.** Seven of nineteen required proposal fields — including `accountId`, `entityId`, `oldValue`, and `expectedMaxConsequence` — **cannot be populated at all** from the stock MCP surface. An approval over that surface reads *"approve browser_click on ref e42."* The operator approves a gesture, not a consequence.
6. **Virtualization silently truncates, and nothing warns you.** The fixture's grid rendered 25 of 500 rows. A collector that treats rendered rows as complete under-reports by 95%. PLAN v1.1 §4's coverage-accounting requirement is not defensive over-engineering; it is the difference between a report and a fabrication.

---

## 2. Track B — observation quality

### 2.1 Ref stability

Target set: the daily-budget control of every rendered row (25 per trial), 3 repetitions, 9 scenarios. Each ref was captured, the world was perturbed, then the ref was re-resolved and compared against the entity it was *supposed* to address.

- **false validation** = the ref resolved to a *different* entity, silently. This is the failure that lets an approved action hit the wrong campaign.
- **unresolved** = the ref stopped resolving. Costly, not dangerous.

Values are `false-validation% / unresolved%`.

| strategy | metrics tick | force rerender | scroll away+back | **scroll shift** | value change | status change | drift: rename labels | drift: reorder cols | drift: restructure DOM |
|---|---|---|---|---|---|---|---|---|---|
| `dom-path` (positional) | 0/0 | 0/0 | 0/0 | **100/0** | 0/0 | 0/0 | 0/0 | 0/0 | 0/100 |
| `ax-path` (role+name chain) | 0/0 | 0/0 | 0/0 | 0/100 | 0/4 | 0/4 | 0/100 | 0/100 | 0/100 |
| `entity-id` (adapter) | 0/0 | 0/0 | 0/0 | **0/20** | 0/0 | 0/0 | 0/0 | 0/0 | 0/0 |
| `text-anchor` (role+exact name) | 0/0 | 0/0 | 0/0 | 0/20 | 0/4 | 0/0 | 0/100 | 0/0 | 0/0 |

Reading:

- `dom-path` is **disqualified**. Under `scroll-shift` — the grid scrolled ten rows and stayed there, which is a user's idlest possible action — every single ref resolved cleanly to the wrong campaign. No error, no exception, no signal.
- `ax-path` is safe but brittle: any label change, column reorder, or re-parenting takes it to 100% unresolved.
- `entity-id` is the only strategy with **0% false validation and near-0% unresolved**. Its 20% unresolved under `scroll-shift` is correct behaviour: those rows left the render window, so the ref *should* stop resolving.
- `text-anchor` is a reasonable fallback where no entity id exists, and it degrades safely (unresolved, never mis-resolved) — but it dies on label drift, which is the most common platform change.

### 2.2 Digest integrity

Region: the campaign grid. Values are `% of trials where the digest changed`. For a **semantic** scenario, anything below 100% is false validation. For a **cosmetic** scenario, anything above 0% is false invalidation.

| recipe | metrics tick *(cosmetic)* | force rerender *(cosmetic)* | scroll away+back *(cosmetic)* | scroll shift | value change | status change | rename labels | reorder cols | restructure DOM |
|---|---|---|---|---|---|---|---|---|---|
| `R1-text` | 0 | 0 | 0 | 100 | 100 | 100 | 100 | 100 | 0 |
| `R2-structure` | 0 | 0 | 0 | **0** | **0** | **0** | **0** | **0** | 0 |
| `R3-ax-tuples` | 0 | 0 | 0 | 100 | 100 | 100 | 100 | 100 | 0 |
| `R4-entity-fields` | 0 | 0 | 0 | 100 | 100 | 100 | 0 | 0 | 0 |

Reading:

- **`R2-structure` is disqualified outright.** It detected nothing. A grid with the same shape and different numbers hashes identically. If a state digest is ever built on element structure, the approval binding is decorative.
- `R1-text` and `R3-ax-tuples` catch every value and label change but are noisy by construction — any presentational churn moves them.
- `R4-entity-fields` (project the adapter-declared fields, key by entity id, sort) is the best value-change detector and is deliberately blind to label and column-order drift. **That blindness is a feature and a trap:** it means R4 alone cannot serve as drift telemetry.
- **`restructure-DOM` shows 0% for every recipe, and that is correct.** Re-parenting the grid and renaming its container changed no operational content. What broke was the *locator*, not the data. This is the finding that separates two concerns the plan currently blends: a **state digest** answers "did the values move?"; **drift telemetry** answers "did the page shape move?" They need different mechanisms.

**Recommendation for WP-02:** `stateDigests` is a *pair* — `{ value: R4-entity-fields, shape: R3-ax-tuples }` — both bound into the proposal hash. R4 alone false-validates on UI drift; R3 alone false-invalidates on every rerender.

### 2.3 Snapshot cost and latency

| scope | median ms | chars | est. tokens |
|---|---|---|---|
| `ariaSnapshot(body)` — full page | 29.9 | 15,619 | 3,905 |
| `ariaSnapshot(grid)` — region only | 13.9 | 14,389 | 3,598 |
| compact projection, full page | 3.6 | 14,363 | 3,591 |
| compact projection, **viewport only** | 2.6 | 9,022 | 2,256 |
| compact projection, grid only | 2.1 | 11,653 | 2,914 |
| raw page HTML (worst case) | 3.0 | 24,104 | 6,026 |
| **R4 digest** | **1.3** | **8** | **~2** |

Median full `ariaSnapshot` latency over 5 runs: **12.6 ms**. Median all-four-digests: **1.3 ms**.

The operative ratio is not snapshot-vs-snapshot, it is **snapshot-vs-digest**: ~3,900 tokens to re-read the page versus ~2 tokens to ask whether it changed. Any design that re-snapshots to detect change is paying four orders of magnitude too much. Budget guidance: **≤4,000 tokens per full page observation, ≤2,300 viewport-scoped**, with change detection never going through a snapshot.

### 2.4 Snapshot fidelity

| property | result |
|---|---|
| open shadow-root content in `ariaSnapshot` | ✅ present |
| **closed** shadow-root content in `ariaSnapshot` | ❌ absent (correct) |
| closed shadow root reachable from page JS | ❌ no (correct) |
| same-origin iframe content in `ariaSnapshot` | ✅ present |
| iframe content via `frameLocator` | ✅ present |
| controls with no accessible name | 2 of 2 appear, **nameless** |

The last row is the one to carry forward: an unnamed control is *addressable but not describable*. It can be clicked and it cannot be explained to a human in an approval dialog. Under PLAN v1.1 §2.2 that is exactly the `unknown` action class — barred from unattended execution. The mapping is now empirical, not theoretical.

Closed shadow roots are genuinely opaque. This is the concrete instance of the plan's **known-unknowns** requirement (§4): an adapter must *declare* that a region exists and cannot be read, or downstream analysis will treat "unreadable" as "empty."

### 2.5 Hit-test agreement and coverage

- **Hit-test:** 30 of 30 on-screen elements agreed — the centre of the DOM bounding box hit the element itself (or a descendant). 20 further elements were off-screen and correctly excluded. DOM geometry and rendered geometry can be trusted for click targeting on this fixture; **re-confirm headed on Windows**.
- **Coverage:** 25 rows rendered, 500 rows reported by the platform. **5% coverage, presented by the UI as a complete-looking grid.** A collector must reconcile against the platform's own totals and record truncation as truncation.

---

## 3. Track C — governed lifecycle

`observe → prepare → approve → execute → verify → ledger`, executed on the fixture, end to end, in **1,977 ms**.

### 3.1 Deterministic verification (PLAN v1.1 §3.3 order)

| check | result |
|---|---|
| V1 different read path (server API, not the DOM we acted on) | ✅ |
| V2 reload persistence | ✅ |
| V3 list/detail reconciliation (summary total moved by exactly the delta) | ✅ |
| V4 sanctioned acknowledgment (platform's own 200 response) | ✅ |
| V5 mechanical comparison against the approved proposal | ✅ |

**No AI auditor was invoked and none was needed.** For a bounded numeric field change, the deterministic ladder is sufficient, and it is cheap: the verification payload is ~93 tokens. PLAN v1.1 §3.3's demotion of the AI countersign to an exception path is empirically supported.

### 3.2 Negative tests — all seven refused mechanically

| attack | rejected as |
|---|---|
| replay a consumed approval | `replay` |
| tamper the parameter after approval (`newValue` → 9999.99) | `proposal-drift` |
| swap the entity (same value, different campaign) | `proposal-drift` |
| state drifted between approval and execution | `proposal-drift` |
| expired approval | `expired` |
| undeclared extra field in the proposal | `unhashable-proposal` |
| **dropped** `accountId` | `unhashable-proposal` |

The last two are the ones worth keeping. Requiring the proposal schema to be **exactly** the declared field set — no extras, no omissions — means "the approval didn't actually cover the account id" cannot happen by accident. A field-drop is a hard error, not a silently different hash.

Full-proposal canonical hashing (REVIEW-DISPOSITION §4.2) is **confirmed workable**: canonicalisation is ~40 lines, hashing is sub-millisecond, and every drift class collapses to a single comparison at execute time. WP-02 should adopt it as specified.

### 3.3 Ledger

21 events, hash chain valid, full run reconstructable from the log alone. A single-byte edit to event 0 was detected at seq 0. Honest label unchanged: **tamper-evident, not tamper-proof**.

---

## 4. Build vs compose — the decisive comparison

Same task (change one campaign's daily budget), same page, same run conditions.

| | adapter path (this spike) | stock `@playwright/mcp` 0.0.78 |
|---|---|---|
| agent-facing tokens | **992** | **16,860** |
| tool-schema tokens (per context refresh) | n/a | 4,617 |
| round trips | 3 | 8 |
| wall clock | 1,977 ms | 5,721 ms |
| stale-ref retries needed | 0 | 1 |
| deterministic verification | 5 checks, built in | **none available** — outcome had to be confirmed out-of-band |

Cost is ~17× — real, but not by itself decisive; a wrapper could scope its snapshots.

**What is decisive is the approval surface.** Of the nineteen fields PLAN v1.1 §2.2 requires in a proposal hash:

- **cannot be derived at all** from the MCP surface: `accountId`, `entityType`, `entityId`, `actionClass`, `oldValue`, `unit`, `expectedMaxConsequence`
- **partial only**: `operation` (tool name, not intent), `parameters` (`{target, text}`, not `{field: dailyBudget}`), `newValue` (only if the wrapper intercepts `browser_type`), `stateDigests` (hash of snapshot text, which churns on every rerender — a false-invalidation generator by construction)

A wrapper can therefore bind an approval to *"browser_click, target=e42, described as 'Edit budget for Prime Summit Blitz'"* — a human-readable string the wrapper cannot verify, produced by the page. It cannot bind to *"campaign `cmp_0004`, daily budget 180.81 → 184.06 USD/day, max consequence +3.25 USD/day."*

Against the REVIEW-DISPOSITION §6 kill criteria — proceed only on material advantage in ≥1 of token cost, action reliability, approval safety, audit reconstruction, cross-model reuse — the custom path wins on **three**: token cost (17×), approval safety (7 fields structurally unavailable to the wrapper), and audit reconstruction (ledger replays the run; MCP transcripts do not carry entity identity).

**One caveat stated plainly.** Almost all of that advantage comes from the **adapter**, not from a custom driver protocol. The adapter is what knows `data-entity-id` means campaign identity, that the field is `dailyBudget`, and that the class is `financial`. Nothing in the measurements shows that replacing Playwright with a bespoke CBP driver adds anything. **The evidence supports building adapters and the Data Plane on top of Playwright — not building a driver protocol.** See §6.

---

## 5. Required answers to the PLAN v1.1 §6 questions

**Which connection mode(s) go forward, and for what roles?**
**UNANSWERED.** Track A is built and runnable (`spike/wp-00/track-a/`, instructions in `RUN-ON-WINDOWS.md`) but was not executed — the sandbox has no display, no real Chrome, no extension host, and no human. This is the one §6 question this report cannot close, and it should be closed before WP-01 fixes a connection model.

**Achievable ref-stability numbers (→ G1/G2 thresholds):**

- **G1 (observation reliability):** adapter-id refs — false validation **0%**, unresolved ≤5% excluding elements legitimately outside the render window. Generic positional refs are **prohibited** for any consequential action, at any measured rate.
- **G2 (digest integrity):** false validation **0%** on value changes for the value digest, and **0%** on structural/label drift for the shape digest, both measured on the hostile fixture. `R2`-style structure-only digests are prohibited.
- Snapshot latency budget: ≤50 ms per full-page observation (measured 12.6–29.9 ms headless; re-baseline headed).

**Viable digest recipe:** the **pair** `{value: R4-entity-fields, shape: R3-ax-tuples}`, both bound into the proposal hash. Neither alone is sufficient (§2.2).

**Token budget per snapshot:** ≤4,000 tokens full page, ≤2,300 viewport-scoped, ~2 tokens for change detection. Steady-state operation should read **records (~750 tokens for 25 rows)**, not snapshots.

**Does custom CBP beat wrapped Playwright MCP on ≥1 durable dimension?** Yes, on three — but the win belongs to the *adapter + governance* layer, not to a custom driver. See §4's caveat and §6.

**Estimated smallest useful product surface:**

1. Playwright, driven directly, on a dedicated persistent profile — no custom driver protocol
2. one adapter interface: declared operations, declared extraction schema, declared entity-id source, declared known-unknowns
3. the proposal/approval kernel exactly as spiked (~250 lines proved sufficient)
4. the hash-chained ledger (~60 lines)
5. the Data Plane record envelope with coverage accounting
6. one read-only Meta adapter

Items 3 and 4 are already effectively demonstrated. The unproven work is 2, 5, and 6.

**Recommendation:** **proceed, reduced** (§6).

---

## 6. G0 recommendation

**PROCEED with a reduced scope**, conditional on Track A.

Build:

- `kernel/approval` and `kernel/ledger` substantially as spiked — validated, cheap, and they carried every negative test without a model in the loop
- the **adapter interface** and the **Browser Data Plane**, which is where all measured value actually came from
- coverage/reconciliation accounting as a first-class field, not a flag

Do **not** build, for now:

- **a custom CBP driver protocol.** Nothing measured here justifies replacing Playwright. Keep the *abstraction boundary* (agents never see Playwright types) — that is a code-organisation decision costing one interface file — but drop the bespoke wire protocol from WP-01/02 scope until something forces it.
- **the recipe compiler (WP-09/10)** until an adapter exists to compile against; §3.4 of the plan already narrowed it, and the measurements give no reason to start it early.

Revise in the plan:

- **§2.2** — `stateDigests` becomes an explicit `{value, shape}` pair; add the "exact field set, no extras, no omissions" invariant that caught the dropped-`accountId` case.
- **§3.3** — record that deterministic verification was sufficient for a bounded numeric change, with V1–V5 as the standing ladder.
- **§4** — coverage accounting is upgraded from a required behaviour to a **G5 blocking criterion**: 5% coverage presented as a complete grid is the default failure mode, not an edge case.
- **§7 G2** — must be tested against *value* changes, not only DOM changes. The structure-only digest would have passed a DOM-only test at 0% detection.

**Before WP-01 starts:** run Track A on Windows (§7). A connection-model decision made without it is a guess.

---

## 7. What is still unmeasured

| gap | why it matters | how to close |
|---|---|---|
| **Track A entirely** — persistent profile vs extension vs CDP, session persistence, takeover ergonomics, crash behaviour, event coverage | decides the runtime topology of the whole Bridge | run `spike/wp-00/track-a/run-connection-modes.mjs` on Windows per `RUN-ON-WINDOWS.md`; ~20 minutes, one 15-second human interaction |
| headed vs headless differences | all Track B numbers are headless-shell | re-run Track B on Windows with `--headed` |
| real platform page | the fixture is hostile by design but synthetic; Meta's grids may be worse | one read-only, human-present measurement on a throwaway account (PLAN v1.1 §6 guardrails) |
| human approval path | only the binding was tested; the page was never used by a person | run `run-lifecycle.mjs` without `--auto-approve` |
| adapter drift telemetry | R3/R4 pairing is inferred from the drift scenarios, not built | WP-06 |
| multi-page / pagination coverage | only single-viewport truncation was measured | WP-07 |

---

## 8. Reproducing

```
cd spike/wp-00
npm install
npx playwright install chromium

node fixture/server.mjs                 # terminal 1 — http://127.0.0.1:8177

node track-b/run.mjs --phase=snapshot --out=../results/track-b.snapshot.json
node track-b/run.mjs --phase=latency  --out=../results/track-b.latency.json
node track-b/run.mjs --phase=refs --reps=3 --scenarios=metrics-tick,force-rerender --out=../results/track-b.refs1.json
#   ... remaining scenario chunks ...
node track-b/merge.mjs

node track-c/run-lifecycle.mjs          # interactive approval; add --auto-approve to skip
node track-c/compose-baseline.mjs

node track-a/run-connection-modes.mjs   # Windows only
```

`--phase` and `--scenarios` exist because the measurement host caps single-command runtime; they change nothing about the measurements. Set `PW_CHANNEL=chromium-headless-shell` to reproduce the exact configuration used here.

Raw evidence: `spike/wp-00/results/track-b.json`, `track-c.json`, `track-c-compose.json`, `track-c.ledger.jsonl`.

---

*WP-00 is disposable. Nothing in `spike/wp-00/` may be imported by WP-01 or later packages (PLAN v1.1 §11).*
