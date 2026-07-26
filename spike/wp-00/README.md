# WP-00 — disposable browser spike

**This code is disposable.** Per PLAN v1.1 §11, nothing here may be imported by WP-01 or any later package. It exists to produce measurements and a G0 recommendation, both of which live in [`docs/spike/WP-00-REPORT.md`](../../docs/spike/WP-00-REPORT.md).

## Layout

| path | what it is |
|---|---|
| `fixture/` | synthetic hostile fixture app — rerendering metrics strip, virtualized 500-row grid, open + closed shadow roots, same-origin iframe, async validation, four seeded UI-drift modes |
| `lib/injected.js` | in-page probe: 4 candidate ref strategies, 4 candidate regionDigest recipes, compact AX projection, coverage + hit-test helpers |
| `lib/canonical.mjs` | canonical JSON + full-proposal hashing (PLAN v1.1 §2.2) |
| `lib/ledger.mjs` | hash-chained JSONL event log |
| `track-a/` | connection-mode comparison — **Windows only, not yet run**. See `track-a/RUN-ON-WINDOWS.md` |
| `track-b/` | observation-quality measurements |
| `track-c/` | governed lifecycle + negative tests, and the stock-Playwright-MCP compose baseline |
| `results/` | raw evidence cited by the report |

## Running

```
npm install
npx playwright install chromium
node fixture/server.mjs        # terminal 1
```

Then see §8 of the report for the exact command sequence. `track-b/run.mjs` accepts `--phase` and `--scenarios` so the suite can be run in bounded chunks and merged with `track-b/merge.mjs`; this affects nothing but scheduling.

## Guardrails observed

Fixture-only. No credentials handled by code. No live platform touched. No Meta mutation of any kind. `track-a` refuses any profile directory whose path does not contain `chinvat-spike`, so the operator's real Chrome profile cannot be launched by accident.
