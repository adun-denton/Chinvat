/*
 * WP-00 Track B — observation quality. DISPOSABLE spike code.
 *
 * Measures, against the hostile fixture app:
 *   1. element-identity ("ref") stability under 4 candidate strategies
 *   2. regionDigest integrity under 4 candidate recipes
 *   3. snapshot token cost at several scopes/budgets
 *   4. snapshot fidelity (shadow DOM, iframe, unnamed controls)
 *   5. DOM/screenshot hit-test agreement
 *   6. latency (full snapshot vs region snapshot vs digest vs screenshot)
 *
 * Terminology used throughout (matches PLAN v1.1 gates G1/G2):
 *   FALSE INVALIDATION — the mechanism says "changed" when nothing that
 *     matters changed. Costs tokens and re-work. Tolerable in small amounts.
 *   FALSE VALIDATION  — the mechanism says "same" (or resolves a ref to the
 *     wrong element) when the world moved underneath it. This is the failure
 *     that lets an approved action land on the wrong entity. G2 requires 0%.
 *
 * Usage: node run.mjs [--reps=3] [--out=../results/track-b.json] [--headed]
 */

import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve as presolve } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const INJECTED = readFileSync(presolve(HERE, '../lib/injected.js'), 'utf8');
const FIXTURE_SERVER = presolve(HERE, '../fixture/server.mjs');
const PORT = Number(process.env.PORT || 8177);
const BASE = `http://127.0.0.1:${PORT}`;
const GRID = '#campaign-grid';

const argv = Object.fromEntries(
  process.argv.slice(2).map((a) => {
    const [k, v] = a.replace(/^--/, '').split('=');
    return [k, v === undefined ? true : v];
  })
);
const REPS = Number(argv.reps || 3);
const OUT = presolve(HERE, String(argv.out || '../results/track-b.json'));
const PHASE = String(argv.phase || 'all');           // all | snapshot | latency | refs
const ONLY = argv.scenarios ? String(argv.scenarios).split(',') : null;

// --------------------------------------------------------------- utilities

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
/** Crude but stable token estimate. Absolute value is indicative; the ratios
 *  between scopes are the number that matters for budgeting. */
const estTokens = (s) => Math.ceil(s.length / 4);
const pct = (n, d) => (d === 0 ? null : Number(((n / d) * 100).toFixed(2)));

async function startFixture() {
  const proc = spawn(process.execPath, [FIXTURE_SERVER], {
    env: { ...process.env, PORT: String(PORT) },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  await new Promise((ok, bad) => {
    const t = setTimeout(() => bad(new Error('fixture did not start in 10s')), 10000);
    proc.stdout.on('data', (d) => {
      if (String(d).includes('listening')) { clearTimeout(t); ok(); }
    });
    proc.on('exit', (c) => { clearTimeout(t); bad(new Error('fixture exited ' + c)); });
  });
  return proc;
}

async function openPage(context, drift) {
  const page = await context.newPage();
  await page.addInitScript({ content: INJECTED });
  // Always pass drift explicitly: the fixture persists drift mode server-side,
  // so an implicit load would inherit whatever the previous scenario set.
  const url = `${BASE}/?drift=${drift || 'none'}`;
  await page.goto(url, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(
    () => !!window.__probe && document.querySelectorAll('[data-entity-id]').length > 0,
    null,
    { timeout: 15000 }
  );
  await sleep(300); // let the first virtualization pass settle
  return page;
}

// -------------------------------------------------------------- scenarios
// kind:'cosmetic'   — nothing an operator would care about changed.
//                     refs must survive; digests must NOT change.
// kind:'semantic'   — something an operator WOULD care about changed.
//                     digests MUST change; refs must not silently retarget.

const ALL_SCENARIOS = [
  {
    id: 'metrics-tick',
    kind: 'cosmetic',
    note: 'live-metrics strip rewrites its own subtree every 800ms',
    apply: async (page) => { await sleep(2000); }
  },
  {
    id: 'force-rerender',
    kind: 'cosmetic',
    note: 'grid re-rendered with fresh render keys, same data, same scroll',
    apply: async (page) => {
      await page.evaluate(() => window.__fixture.forceRerender());
      await sleep(400);
    }
  },
  {
    id: 'scroll-away-return',
    kind: 'cosmetic',
    note: 'scroll 20 rows down and back to the top — same rows visible again',
    apply: async (page) => {
      await page.evaluate(() => { document.getElementById('grid-viewport').scrollTop = 800; });
      await sleep(600);
      await page.evaluate(() => { document.getElementById('grid-viewport').scrollTop = 0; });
      await sleep(600);
    }
  },
  {
    id: 'scroll-shift',
    kind: 'semantic',
    note: 'scroll 10 rows down and STAY — different campaigns now occupy the same positions',
    apply: async (page) => {
      await page.evaluate(() => { document.getElementById('grid-viewport').scrollTop = 400; });
      await sleep(700);
    }
  },
  {
    id: 'value-change',
    kind: 'semantic',
    note: 'one campaign daily budget changed underneath us',
    apply: async (page) => {
      await page.evaluate(() => {
        const id = window.__fixture.getVisibleEntityIds()[2];
        window.__fixture.seedRow(id, { dailyBudget: 987.65 });
      });
      await sleep(500);
    }
  },
  {
    id: 'status-change',
    kind: 'semantic',
    note: 'one campaign flipped ACTIVE <-> PAUSED underneath us',
    apply: async (page) => {
      await page.evaluate(() => {
        const id = window.__fixture.getVisibleEntityIds()[1];
        window.__fixture.seedRow(id, { status: 'PAUSED' });
      });
      await sleep(500);
    }
  },
  {
    id: 'drift-rename-labels',
    kind: 'semantic',
    note: 'platform UI drift: all accessible names suffixed, Save renamed to Apply',
    apply: async (page) => { await page.goto(`${BASE}/?drift=rename-labels`, { waitUntil: 'domcontentloaded' }); await settle(page); }
  },
  {
    id: 'drift-reorder-columns',
    kind: 'semantic',
    note: 'platform UI drift: Spend and Clicks columns swapped',
    apply: async (page) => { await page.goto(`${BASE}/?drift=reorder-columns`, { waitUntil: 'domcontentloaded' }); await settle(page); }
  },
  {
    id: 'drift-restructure-dom',
    kind: 'semantic',
    note: 'platform UI drift: grid re-parented and container id renamed',
    apply: async (page) => { await page.goto(`${BASE}/?drift=restructure-dom`, { waitUntil: 'domcontentloaded' }); await settle(page); }
  }
];

const SCENARIOS = ONLY ? ALL_SCENARIOS.filter((s) => ONLY.includes(s.id)) : ALL_SCENARIOS;

async function settle(page) {
  await page.waitForFunction(
    () => !!window.__probe && document.querySelectorAll('[data-entity-id]').length > 0,
    null,
    { timeout: 15000 }
  );
  await sleep(400);
}

// ----------------------------------------------------------- measurements

async function measureRefsAndDigests(context) {
  const strategies = ['dom-path', 'ax-path', 'entity-id', 'text-anchor'];
  const recipes = ['R1-text', 'R2-structure', 'R3-ax-tuples', 'R4-entity-fields'];

  // accumulator[strategy][scenario] = {stable, invalidated, silentMismatch, total}
  const refAcc = {};
  const digestAcc = {};
  for (const s of strategies) refAcc[s] = {};
  for (const r of recipes) digestAcc[r] = {};

  const perScenarioNotes = {};

  for (let rep = 0; rep < REPS; rep++) {
    for (const sc of SCENARIOS) {
      const page = await openPage(context, 'none');
      try {
        const before = await page.evaluate(() => ({
          targets: window.__probe.targets(),
          digests: window.__probe.digestAll('#campaign-grid'),
          coverage: window.__probe.coverage()
        }));

        await sc.apply(page);

        const after = await page.evaluate(() => ({
          digests: window.__probe.digestAll('#campaign-grid'),
          coverage: window.__probe.coverage()
        }));

        // ---- refs (batched: one round trip per strategy, not per element)
        for (const s of strategies) {
          refAcc[s][sc.id] ??= { stable: 0, invalidated: 0, silentMismatch: 0, noRef: 0, total: 0 };
          const bucket = refAcc[s][sc.id];
          const batch = before.targets.map((t) => ({ entityId: t.entityId, ref: t.refs[s] }));
          const outcomes = await page.evaluate(
            ([st, items]) =>
              items.map((it) => {
                if (it.ref == null) return 'no-ref';
                const res = window.__probe.resolveRef(st, it.ref);
                if (res.status !== 'resolved') return 'invalidated';
                return res.entityId === it.entityId ? 'stable' : 'silent-mismatch';
              }),
            [s, batch]
          );
          for (const o of outcomes) {
            bucket.total++;
            if (o === 'no-ref') bucket.noRef++;
            else if (o === 'invalidated') bucket.invalidated++;
            else if (o === 'stable') bucket.stable++;
            else bucket.silentMismatch++;
          }
        }

        // ---- digests
        for (const r of recipes) {
          digestAcc[r][sc.id] ??= { changed: 0, unchanged: 0, missing: 0, total: 0 };
          const b = digestAcc[r][sc.id];
          b.total++;
          const bv = before.digests?.[r];
          const av = after.digests?.[r];
          if (bv == null || av == null) b.missing++;
          else if (bv === av) b.unchanged++;
          else b.changed++;
        }

        perScenarioNotes[sc.id] = {
          kind: sc.kind,
          note: sc.note,
          coverageBefore: before.coverage,
          coverageAfter: after.coverage,
          targetsObserved: before.targets.length
        };
      } finally {
        await page.close();
      }
    }
  }

  // ---- reduce to rates
  const refRates = {};
  for (const s of strategies) {
    refRates[s] = {};
    for (const sc of SCENARIOS) {
      const b = refAcc[s][sc.id];
      refRates[s][sc.id] = {
        kind: sc.kind,
        total: b.total,
        stablePct: pct(b.stable, b.total),
        // cosmetic churn that broke the ref = false invalidation
        falseInvalidationPct: sc.kind === 'cosmetic' ? pct(b.invalidated, b.total) : null,
        // ref silently landed on a DIFFERENT entity = false validation
        falseValidationPct: pct(b.silentMismatch, b.total),
        unresolvedPct: pct(b.invalidated, b.total),
        noRefPct: pct(b.noRef, b.total)
      };
    }
  }

  const digestRates = {};
  for (const r of recipes) {
    digestRates[r] = {};
    for (const sc of SCENARIOS) {
      const b = digestAcc[r][sc.id];
      digestRates[r][sc.id] = {
        kind: sc.kind,
        runs: b.total,
        changedPct: pct(b.changed, b.total),
        // semantic change that the digest failed to notice = false validation
        falseValidationPct: sc.kind === 'semantic' ? pct(b.unchanged, b.total) : null,
        // cosmetic churn that tripped the digest = false invalidation
        falseInvalidationPct: sc.kind === 'cosmetic' ? pct(b.changed, b.total) : null,
        missing: b.missing
      };
    }
  }

  return { refRates, digestRates, perScenarioNotes };
}

async function measureSnapshotCost(context) {
  const page = await openPage(context, 'none');
  const out = {};
  try {
    const t = async (label, fn) => {
      const s = process.hrtime.bigint();
      const v = await fn();
      const ms = Number(process.hrtime.bigint() - s) / 1e6;
      return { ms: Number(ms.toFixed(1)), value: v };
    };

    const fullAria = await t('aria-full', () => page.locator('body').ariaSnapshot());
    const gridAria = await t('aria-grid', () => page.locator(GRID).ariaSnapshot());
    const projFull = await t('project-full', () => page.evaluate(() => window.__probe.project(null, {})));
    const projView = await t('project-viewport', () => page.evaluate(() => window.__probe.project(null, { viewportOnly: true })));
    const projGrid = await t('project-grid', () => page.evaluate(() => window.__probe.project('#campaign-grid', {})));
    const digest = await t('digest-R4', () => page.evaluate(() => window.__probe.digest('#campaign-grid', 'R4-entity-fields')));
    const shot = await t('screenshot-viewport', () => page.screenshot());
    const html = await t('raw-html', () => page.content());

    const size = (label, r, text) => ({
      label,
      ms: r.ms,
      chars: text.length,
      estTokens: estTokens(text)
    });

    out.scopes = [
      size('ariaSnapshot(body) — full page', fullAria, fullAria.value),
      size('ariaSnapshot(grid) — region only', gridAria, gridAria.value),
      size('__probe.project(body) — compact projection', projFull, projFull.value),
      size('__probe.project(body, viewportOnly)', projView, projView.value),
      size('__probe.project(grid)', projGrid, projGrid.value),
      size('raw page HTML (worst case)', html, html.value)
    ];
    out.digestR4 = { ms: digest.ms, chars: String(digest.value).length };
    out.screenshotViewport = { ms: shot.ms, bytes: shot.value.length };

    // fidelity
    const shadow = await page.evaluate(() => window.__probe.shadowFacts());
    const ariaText = fullAria.value;
    out.fidelity = {
      openShadowContentInAriaSnapshot: /Switch account|Account:/.test(ariaText),
      closedShadowContentInAriaSnapshot: /Quick budget amount/.test(ariaText),
      closedShadowExposedToJs: shadow.closedShadowExposed,
      iframeContentInAriaSnapshot: /Notification/i.test(ariaText),
      iframeContentViaFrameLocator: await page
        .frameLocator('#notif-frame')
        .locator('#notif-list')
        .count()
        .then((n) => n > 0)
        .catch(() => false),
      unnamedControlsPresentInAriaSnapshot: (ariaText.match(/^\s*- (button|textbox)\s*$/gm) || []).length,
      note: 'unnamed controls appear in the snapshot with no name — they are addressable but not describable'
    };

    // hit-test agreement (DOM box centre vs elementFromPoint)
    out.hitTest = await page.evaluate(() =>
      window.__probe.hitTest('[data-entity-id] [data-action="budget-edit"], [data-entity-id] input, header button')
    );

    // reconciliation: rendered rows vs platform-reported total
    const cov = await page.evaluate(() => window.__probe.coverage());
    const summary = await (await fetch(`${BASE}/api/campaigns/summary`)).json();
    out.reconciliation = {
      renderedRows: cov.renderedRows,
      platformTotalRows: summary.totalRows,
      coverageComplete: cov.renderedRows === summary.totalRows,
      note: 'virtualized grid renders a window; a scraper that treats rendered rows as complete would under-report by ' +
        (summary.totalRows - cov.renderedRows) + ' rows'
    };
  } finally {
    await page.close();
  }
  return out;
}

async function measureDiffLatency(context) {
  const page = await openPage(context, 'none');
  try {
    const runs = [];
    for (let i = 0; i < 5; i++) {
      let s = process.hrtime.bigint();
      const full = await page.locator('body').ariaSnapshot();
      const fullMs = Number(process.hrtime.bigint() - s) / 1e6;

      s = process.hrtime.bigint();
      await page.evaluate(() => window.__probe.digestAll('#campaign-grid'));
      const digestMs = Number(process.hrtime.bigint() - s) / 1e6;

      runs.push({ fullSnapshotMs: +fullMs.toFixed(1), digestAllMs: +digestMs.toFixed(1), fullChars: full.length });
      await sleep(300);
    }
    const med = (k) => {
      const v = runs.map((r) => r[k]).sort((a, b) => a - b);
      return v[Math.floor(v.length / 2)];
    };
    return { runs, medianFullSnapshotMs: med('fullSnapshotMs'), medianDigestAllMs: med('digestAllMs') };
  } finally {
    await page.close();
  }
}

// ------------------------------------------------------------------- main

async function main() {
  const fixture = await startFixture();
  const browser = await chromium.launch({
    channel: process.env.PW_CHANNEL || undefined,
    headless: !argv.headed
  });
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });

  const results = {
    generatedAt: new Date().toISOString(),
    node: process.version,
    platform: `${process.platform} ${process.arch}`,
    channel: process.env.PW_CHANNEL || 'default',
    reps: REPS,
    scenarios: SCENARIOS.map((s) => ({ id: s.id, kind: s.kind, note: s.note }))
  };

  try {
    // Phases are separable so the suite can be run in bounded chunks on a
    // host with a short command timeout, then merged (see merge.mjs).
    if (PHASE === 'all' || PHASE === 'snapshot') {
      results.snapshot = await measureSnapshotCost(context);
    }
    if (PHASE === 'all' || PHASE === 'latency') {
      results.latency = await measureDiffLatency(context);
    }
    if (PHASE === 'all' || PHASE === 'refs') {
      const rd = await measureRefsAndDigests(context);
      results.refStability = rd.refRates;
      results.digestIntegrity = rd.digestRates;
      results.scenarioDetail = rd.perScenarioNotes;
      results.scenariosRun = SCENARIOS.map((s) => s.id);
    }
  } catch (e) {
    results.error = String(e && e.stack ? e.stack : e);
  } finally {
    await context.close().catch(() => {});
    await browser.close().catch(() => {});
    fixture.kill('SIGKILL');
  }

  mkdirSync(dirname(OUT), { recursive: true });
  writeFileSync(OUT, JSON.stringify(results, null, 2));
  console.log('wrote', OUT);

  // compact console summary
  if (results.refStability) {
    console.log('\n=== ref stability (falseValidation% / unresolved%) ===');
    for (const [s, byScenario] of Object.entries(results.refStability)) {
      const parts = Object.entries(byScenario).map(
        ([id, v]) => `${id}:${v.falseValidationPct}/${v.unresolvedPct}`
      );
      console.log(s.padEnd(13), parts.join('  '));
    }
    console.log('\n=== digest integrity (changed%) ===');
    for (const [r, byScenario] of Object.entries(results.digestIntegrity)) {
      const parts = Object.entries(byScenario).map(([id, v]) => `${id}:${v.changedPct}`);
      console.log(r.padEnd(17), parts.join('  '));
    }
  }
  if (results.error) { console.error(results.error); process.exitCode = 1; }
}

main();
