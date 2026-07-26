/*
 * WP-00 Track C — one end-to-end governed lifecycle on the fixture, plus the
 * negative tests that make the governance claim mean something.
 * DISPOSABLE spike code.
 *
 *   observe -> prepare (full-proposal hash) -> human approval (local page)
 *           -> execute -> deterministic verification -> hash-chained log
 *
 * Deterministic verification order is the PLAN v1.1 §3.3 order:
 *   V1 different read path (server API, not the DOM we acted on)
 *   V2 reload persistence  (survives a fresh page load)
 *   V3 list/detail reconciliation (summary total moved by exactly the delta)
 *   V4 sanctioned acknowledgment (the platform's own success response)
 *   V5 mechanical comparison against the approved proposal
 * No AI auditor is invoked. That is the point: on this class of action the
 * deterministic path is sufficient and cheaper.
 *
 * Usage: node run-lifecycle.mjs [--auto-approve] [--out=../results/track-c.json]
 */
import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve as presolve } from 'node:path';
import { createInterface } from 'node:readline';
import { Ledger } from '../lib/ledger.mjs';
import { proposalHash } from '../lib/canonical.mjs';
import { ApprovalService } from './approval-service.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const INJECTED = readFileSync(presolve(HERE, '../lib/injected.js'), 'utf8');
const FIXTURE_SERVER = presolve(HERE, '../fixture/server.mjs');
const PORT = Number(process.env.PORT || 8177);
const BASE = `http://127.0.0.1:${PORT}`;

const argv = Object.fromEntries(process.argv.slice(2).map((a) => {
  const [k, v] = a.replace(/^--/, '').split('=');
  return [k, v === undefined ? true : v];
}));
const OUT = presolve(HERE, String(argv.out || '../results/track-c.json'));
const LEDGER_PATH = presolve(HERE, '../results/track-c.ledger.jsonl');
const AUTO = !!argv['auto-approve'];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function startFixture() {
  const proc = spawn(process.execPath, [FIXTURE_SERVER], {
    env: { ...process.env, PORT: String(PORT) }, stdio: ['ignore', 'pipe', 'pipe']
  });
  await new Promise((ok, bad) => {
    const t = setTimeout(() => bad(new Error('fixture start timeout')), 10000);
    proc.stdout.on('data', (d) => String(d).includes('listening') && (clearTimeout(t), ok()));
    proc.on('exit', (c) => (clearTimeout(t), bad(new Error('fixture exited ' + c))));
  });
  return proc;
}

const api = async (path, init) => (await fetch(`${BASE}${path}`, init)).json();

/** Everything the proposal needs about the world, read through the browser. */
async function observe(page, entityId) {
  return page.evaluate((id) => {
    const row = document.querySelector(`[data-entity-id="${id}"]`);
    const btn = row?.querySelector('[data-action="budget-edit"]');
    const text = btn ? btn.textContent.trim() : null;
    return {
      entityId: id,
      budgetText: text,
      budgetValue: text ? Number(text.replace(/[^0-9.]/g, '')) : null,
      regionDigest: window.__probe.digest('#campaign-grid', 'R4-entity-fields'),
      shapeDigest: window.__probe.digest('#campaign-grid', 'R3-ax-tuples')
    };
  }, entityId);
}

function buildProposal(obs, newValue, { policyVersion = 'spike-0', ttlSeconds = 120 } = {}) {
  return {
    workspace: 'wp00-spike',
    session: 'sess-1',
    originScope: BASE,
    accountId: 'fixture-account-1',
    entityType: 'campaign',
    entityId: obs.entityId,
    actionClass: 'financial',              // budget change => permanently fresh-approval-only
    operation: 'set_daily_budget',
    parameters: { field: 'dailyBudget' },
    oldValue: obs.budgetValue,
    newValue,
    unit: 'USD/day',
    expectedMaxConsequence: { maxDailySpendDelta: Number((newValue - obs.budgetValue).toFixed(2)) },
    stateDigests: { region: obs.regionDigest, shape: obs.shapeDigest },
    adapterVersion: 'fixture-adapter@0.0.0',
    laneVersion: 'bridge-spike@0.0.0',
    policyVersion,
    requestingPrincipal: 'agent:spike',
    expiresAt: new Date(Date.now() + ttlSeconds * 1000).toISOString()
  };
}

/** Perform the mutation through the UI, exactly as an adapter op would. */
async function execute(page, entityId, newValue) {
  const acks = [];
  const onResponse = (r) => {
    if (r.url().includes('/budget')) acks.push({ url: r.url(), status: r.status() });
  };
  page.on('response', onResponse);
  await page.click(`[data-entity-id="${entityId}"] [data-action="budget-edit"]`);
  await page.fill(`[data-entity-id="${entityId}"] [data-action="budget-input"]`, String(newValue));
  await page.click(`[data-entity-id="${entityId}"] [data-action="budget-save"]`);
  await page.waitForFunction(
    (id) => {
      const row = document.querySelector(`[data-entity-id="${id}"]`);
      return row && !row.querySelector('[data-action="budget-input"]');
    },
    entityId,
    { timeout: 15000 }
  );
  page.off('response', onResponse);
  return { sanctionedAcks: acks };
}

async function verify(page, proposal, execResult) {
  const id = proposal.entityId;
  const checks = {};

  // V1 — different read path: the server's own record, not the DOM we touched.
  const list = await api(`/api/campaigns?offset=0&limit=500`);
  const row = list.rows.find((r) => r.id === id);
  checks.V1_differentReadPath = { ok: row?.dailyBudget === proposal.newValue, observed: row?.dailyBudget };

  // V2 — reload persistence.
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => !!window.__probe && document.querySelectorAll('[data-entity-id]').length > 0);
  await sleep(400);
  const after = await observe(page, id);
  checks.V2_reloadPersistence = { ok: after.budgetValue === proposal.newValue, observed: after.budgetValue };

  // V3 — list/detail reconciliation: the summary total must move by the delta.
  const summary = await api('/api/campaigns/summary');
  const expectedDelta = Number((proposal.newValue - proposal.oldValue).toFixed(2));
  checks.V3_reconciliation = {
    ok: Math.abs((summary.totalBudget - proposal.__baselineTotalBudget) - expectedDelta) < 0.011,
    expectedDelta,
    observedDelta: Number((summary.totalBudget - proposal.__baselineTotalBudget).toFixed(2))
  };

  // V4 — sanctioned acknowledgment from the platform itself.
  checks.V4_sanctionedAck = {
    ok: execResult.sanctionedAcks.some((a) => a.status === 200),
    acks: execResult.sanctionedAcks
  };

  // V5 — mechanical comparison with what was approved.
  checks.V5_matchesApproved = {
    ok: row?.dailyBudget === proposal.newValue && after.budgetValue === proposal.newValue,
    approvedNewValue: proposal.newValue
  };

  checks.allPassed = Object.values(checks).every((c) => c === true || c.ok !== false);
  return checks;
}

async function humanApproval(svc, hash) {
  const url = `http://127.0.0.1:${svc.port}/approve/${hash}`;
  if (AUTO) {
    // Honestly labelled: no human was present. The mechanism under test is
    // the binding, not the human; the human path is exercised interactively.
    return svc.approve(hash, 'simulated-operator (--auto-approve)');
  }
  console.log('\nOpen this page and approve:\n  ' + url + '\n');
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  await new Promise((r) => rl.question('press enter once approved... ', () => (rl.close(), r())));
  const rec = [...svc.approvals.values()].filter((a) => a.proposalHash === hash).pop();
  if (!rec) throw new Error('no approval was issued');
  return rec;
}

async function main() {
  // Truncate rather than unlink: some mounts permit writes but not deletes.
  mkdirSync(dirname(LEDGER_PATH), { recursive: true });
  writeFileSync(LEDGER_PATH, '');
  const ledger = new Ledger(LEDGER_PATH);
  const fixture = await startFixture();
  const svc = new ApprovalService({ ttlMs: 120000, ledger });
  await svc.listen(0);
  const browser = await chromium.launch({ channel: process.env.PW_CHANNEL || undefined, headless: !argv.headed });
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const page = await context.newPage();
  await page.addInitScript({ content: INJECTED });

  const results = {
    generatedAt: new Date().toISOString(),
    node: process.version,
    approvalMode: AUTO ? 'simulated' : 'human-in-the-loop',
    negativeTests: {}
  };

  try {
    await page.goto(`${BASE}/?drift=none`, { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => !!window.__probe && document.querySelectorAll('[data-entity-id]').length > 0);
    await sleep(400);

    const entityId = (await page.evaluate(() => window.__fixture.getVisibleEntityIds()))[3];
    const baselineSummary = await api('/api/campaigns/summary');

    // ---------------------------------------------------------- happy path
    const t0 = Date.now();
    const obs = await observe(page, entityId);
    ledger.append('observation.captured', { entityId, digest: obs.regionDigest, budget: obs.budgetValue });

    const newValue = Number((obs.budgetValue + 3.25).toFixed(2));
    const proposal = buildProposal(obs, newValue);
    const hash = svc.register(proposal);
    proposal.__baselineTotalBudget = baselineSummary.totalBudget; // harness-only, not hashed

    const approval = await humanApproval(svc, hash);

    // The live proposal is re-derived at execute time and re-hashed. Nothing
    // trusts the in-memory object that was approved.
    const live = { ...proposal };
    delete live.__baselineTotalBudget;
    const auth = svc.authorize(approval.nonce, live);
    if (!auth.ok) throw new Error('authorization unexpectedly denied: ' + auth.reason);
    ledger.append('execution.authorized', { proposalHash: auth.proposalHash, approvedBy: auth.approvedBy });

    const execResult = await execute(page, entityId, newValue);
    ledger.append('execution.completed', { proposalHash: hash, acks: execResult.sanctionedAcks });

    const checks = await verify(page, proposal, execResult);
    ledger.append('verification.completed', { proposalHash: hash, checks });

    results.happyPath = {
      entityId,
      oldValue: obs.budgetValue,
      newValue,
      proposalHash: hash,
      elapsedMs: Date.now() - t0,
      verification: checks
    };

    // ---------------------------------- agent-facing token cost (vs compose)
    // The comparison that decides build-vs-compose: what does the AGENT have
    // to read to do this job? In the adapter path it reads records, not a
    // page. Measured on the same page, in the same run, as the MCP baseline.
    const est = (x) => Math.ceil(JSON.stringify(x).length / 4);
    const records = await page.evaluate(() => window.__probe.records());
    const ariaFull = await page.locator('body').ariaSnapshot();
    results.agentFacingTokens = {
      observation_records: est(records),
      observation_records_rows: records.length,
      proposal: est(live),
      verification: est(checks),
      total: est(records) + est(live) + est(checks),
      forReference_ariaSnapshotFullPage: Math.ceil(ariaFull.length / 4),
      note: 'compare with results/track-c-compose.json .totals.totalEstTokens for the stock-MCP path'
    };

    // ------------------------------------------------------ negative tests
    // Each of these must be refused by the mechanism, with no model in the loop.

    // N1 replay: reuse a consumed approval.
    results.negativeTests.replay = svc.authorize(approval.nonce, live);

    // N2 parameter tamper: same approval, different newValue.
    const p2 = { ...live, newValue: 9999.99 };
    const a2 = svc.approve(hash, 'test');            // fresh approval for the ORIGINAL proposal
    results.negativeTests.parameterTamper = svc.authorize(a2.nonce, p2);

    // N3 entity swap: same value, different campaign.
    const p3 = { ...live, entityId: 'cmp_0499' };
    const a3 = svc.approve(hash, 'test');
    results.negativeTests.entitySwap = svc.authorize(a3.nonce, p3);

    // N4 state drift: the page moved after approval, so the state digest differs.
    await page.evaluate(() => window.__fixture.seedRow(window.__fixture.getVisibleEntityIds()[0], { status: 'PAUSED' }));
    await sleep(400);
    const obs4 = await observe(page, entityId);
    const p4 = { ...live, stateDigests: { region: obs4.regionDigest, shape: obs4.shapeDigest } };
    const a4 = svc.approve(hash, 'test');
    results.negativeTests.stateDrift = svc.authorize(a4.nonce, p4);

    // N5 expiry.
    const svcShort = new ApprovalService({ ttlMs: 1, ledger });
    const h5 = svcShort.register(live);
    const a5 = svcShort.approve(h5, 'test');
    await sleep(30);
    results.negativeTests.expired = svcShort.authorize(a5.nonce, live);

    // N6 unhashable proposal: a field the schema does not declare.
    const p6 = { ...live, sneakyExtra: true };
    const a6 = svc.approve(hash, 'test');
    results.negativeTests.undeclaredField = svc.authorize(a6.nonce, p6);

    // N7 missing field: dropping accountId must not hash the same.
    const p7 = { ...live };
    delete p7.accountId;
    const a7 = svc.approve(hash, 'test');
    results.negativeTests.missingField = svc.authorize(a7.nonce, p7);

    results.negativeTestsAllRefused = Object.values(results.negativeTests).every((r) => r.ok === false);

    // ------------------------------------------------- ledger reconstruction
    const v = ledger.verify();
    results.ledger = {
      path: LEDGER_PATH,
      events: v.events.length,
      chainValid: v.ok,
      eventTypes: v.events.map((e) => e.type),
      reconstructedStory: v.events
        .filter((e) => ['proposal.created', 'approval.issued', 'approval.consumed', 'execution.completed', 'verification.completed'].includes(e.type))
        .map((e) => `${e.seq} ${e.type} ${e.payload.proposalHash ? e.payload.proposalHash.slice(0, 12) : ''}`)
    };

    // tamper detection: flip one byte in an early event and re-verify
    const raw = readFileSync(LEDGER_PATH, 'utf8').split('\n');
    const tamperedPath = LEDGER_PATH.replace('.jsonl', '.tampered.jsonl');
    raw[0] = raw[0].replace('"observation.captured"', '"observation.tampered"');
    writeFileSync(tamperedPath, raw.join('\n'));
    const tv = new Ledger(tamperedPath).verify();
    results.ledger.tamperDetected = tv.ok === false;
    results.ledger.tamperBrokenAt = tv.brokenAt;
  } catch (e) {
    results.error = String(e && e.stack ? e.stack : e);
  } finally {
    await context.close().catch(() => {});
    await browser.close().catch(() => {});
    await svc.close().catch(() => {});
    fixture.kill('SIGKILL');
  }

  mkdirSync(dirname(OUT), { recursive: true });
  writeFileSync(OUT, JSON.stringify(results, null, 2));
  console.log('wrote', OUT);
  if (results.happyPath) {
    console.log('happy path verification:', JSON.stringify(results.happyPath.verification, null, 1));
  }
  console.log('negative tests all refused:', results.negativeTestsAllRefused);
  console.log('negative reasons:', Object.entries(results.negativeTests).map(([k, v]) => `${k}=${v.reason || 'ALLOWED!'}`).join(' '));
  if (results.error) { console.error(results.error); process.exitCode = 1; }
}

main();
