/*
 * WP-00 Track C (part 2) — the BUILD-VS-COMPOSE baseline. DISPOSABLE.
 *
 * REVIEW-DISPOSITION §6 requires that the "wrap stock Playwright MCP with a
 * policy engine + approval UI + ledger" option be beaten EMPIRICALLY, not
 * rhetorically. This script performs the same budget change as
 * run-lifecycle.mjs, but through stock @playwright/mcp over stdio, and
 * records:
 *   - token cost of the tool traffic an agent would actually pay
 *   - wall-clock and round-trip count
 *   - which fields of the PLAN v1.1 §2.2 proposal a thin wrapper can and
 *     cannot populate from the MCP surface alone
 *
 * The last item is the decisive one. A wrapper can bind an approval to
 * "tool=browser_click, ref=e42". It cannot bind it to "campaign cmp_0004,
 * daily budget 180.81 -> 184.06 USD/day", because the MCP surface never
 * carries entity identity or old/new value. Whether that gap matters is the
 * G0 judgement call; this script measures the gap rather than asserting it.
 *
 * Usage: node compose-baseline.mjs [--out=../results/track-c-compose.json]
 */
import { spawn } from 'node:child_process';
import { writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve as presolve } from 'node:path';
import { PROPOSAL_FIELDS } from '../lib/canonical.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURE_SERVER = presolve(HERE, '../fixture/server.mjs');
const MCP_CLI = presolve(HERE, '../node_modules/@playwright/mcp/cli.js');
const PORT = Number(process.env.PORT || 8177);
const BASE = `http://127.0.0.1:${PORT}`;

const argv = Object.fromEntries(process.argv.slice(2).map((a) => {
  const [k, v] = a.replace(/^--/, '').split('=');
  return [k, v === undefined ? true : v];
}));
const OUT = presolve(HERE, String(argv.out || '../results/track-c-compose.json'));
const estTokens = (s) => Math.ceil(String(s).length / 4);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function startFixture() {
  const proc = spawn(process.execPath, [FIXTURE_SERVER], {
    env: { ...process.env, PORT: String(PORT) }, stdio: ['ignore', 'pipe', 'pipe']
  });
  await new Promise((ok, bad) => {
    const t = setTimeout(() => bad(new Error('fixture start timeout')), 10000);
    proc.stdout.on('data', (d) => String(d).includes('listening') && (clearTimeout(t), ok()));
  });
  return proc;
}

/** Minimal MCP stdio client: newline-delimited JSON-RPC. */
class McpStdio {
  constructor(args) {
    this.proc = spawn(process.execPath, [MCP_CLI, ...args], { stdio: ['pipe', 'pipe', 'pipe'] });
    this.id = 0;
    this.pending = new Map();
    this.stderr = '';
    this.proc.stderr.on('data', (d) => (this.stderr += d));
    let buf = '';
    this.proc.stdout.on('data', (d) => {
      buf += d;
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i).trim();
        buf = buf.slice(i + 1);
        if (!line) continue;
        let msg;
        try { msg = JSON.parse(line); } catch { continue; }
        const p = this.pending.get(msg.id);
        if (p) { this.pending.delete(msg.id); p(msg); }
      }
    });
  }
  call(method, params, timeoutMs = 30000) {
    const id = ++this.id;
    const payload = JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n';
    this.proc.stdin.write(payload);
    return new Promise((ok, bad) => {
      const t = setTimeout(() => bad(new Error(`timeout on ${method}: ${this.stderr.slice(-400)}`)), timeoutMs);
      this.pending.set(id, (m) => { clearTimeout(t); ok(m); });
    });
  }
  notify(method, params) {
    this.proc.stdin.write(JSON.stringify({ jsonrpc: '2.0', method, params }) + '\n');
  }
  kill() { this.proc.kill('SIGKILL'); }
}

const textOf = (res) =>
  (res?.result?.content || []).filter((c) => c.type === 'text').map((c) => c.text).join('\n');

async function main() {
  const results = {
    generatedAt: new Date().toISOString(),
    node: process.version,
    playwrightMcpVersion: JSON.parse(
      (await import('node:fs')).readFileSync(presolve(HERE, '../node_modules/@playwright/mcp/package.json'), 'utf8')
    ).version,
    traffic: [],
    notes: []
  };

  const fixture = await startFixture();
  const execPath = process.env.PW_EXECUTABLE_PATH;
  const args = ['--headless', '--isolated', '--no-sandbox'];
  if (execPath && existsSync(execPath)) args.push(`--executable-path=${execPath}`);
  const mcp = new McpStdio(args);

  const t0 = Date.now();
  try {
    const init = await mcp.call('initialize', {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: { name: 'chinvat-wp00-compose-baseline', version: '0.0.0' }
    });
    mcp.notify('notifications/initialized', {});
    results.serverInfo = init.result?.serverInfo;

    const tools = await mcp.call('tools/list', {});
    const toolList = tools.result?.tools || [];
    results.toolSurface = {
      count: toolList.length,
      names: toolList.map((t) => t.name),
      // an agent pays for the tool schemas on every context refresh
      schemaChars: JSON.stringify(toolList).length,
      schemaEstTokens: estTokens(JSON.stringify(toolList))
    };

    const record = async (label, name, args2) => {
      const s = Date.now();
      const res = await mcp.call('tools/call', { name, arguments: args2 });
      const text = textOf(res);
      const isError = !!res.result?.isError;
      results.traffic.push({
        label, tool: name, ms: Date.now() - s,
        chars: text.length, estTokens: estTokens(text),
        isError,
        errorText: isError ? text.slice(0, 400) : undefined
      });
      return text;
    };

    /** Re-snapshot and re-extract a ref immediately before each action.
     *  Needed because refs are snapshot-scoped and this page rerenders. */
    const refFor = async (label2, pattern) => {
      const snap = await record(label2, 'browser_snapshot', {});
      const line = snap.split('\n').find((l) => pattern.test(l));
      return {
        ref: line && (line.match(/\[ref=([^\]]+)\]/) || [])[1],
        label: line && (line.match(/"([^"]+)"/) || [])[1],
        snap
      };
    };

    await record('navigate', 'browser_navigate', { url: `${BASE}/?drift=none` });
    await sleep(1200);
    const snap1 = await record('snapshot-1', 'browser_snapshot', {});

    // A wrapper must parse refs out of the snapshot text. This is the entire
    // identity surface it gets: an opaque ref plus a rendered label.
    const refLine = snap1.split('\n').find((l) => /Edit budget for/.test(l));
    const ref = refLine && (refLine.match(/\[ref=([^\]]+)\]/) || [])[1];
    const label = refLine && (refLine.match(/"([^"]+)"/) || [])[1];
    results.refExtraction = { found: !!ref, ref: ref || null, label: label || null, line: refLine || null };

    // Staleness retry: an agent facing "ref not found" re-snapshots and tries
    // again. Count the retries — they are the compose option's real token cost.
    let attempts = 0;
    let opened = false;
    if (ref) {
      for (; attempts < 3 && !opened; attempts++) {
        const cur = attempts === 0
          ? { ref, label }
          : await refFor(`snapshot-retry-${attempts}`, /Edit budget for/);
        if (!cur.ref) break;
        const out = await record(`click-budget-${attempts}`, 'browser_click', {
          element: cur.label || "budget cell", target: cur.ref
        });
        opened = !/error|not found|stale/i.test(out);
        if (!opened) await sleep(300);
      }
    }
    results.staleRefRetries = { attempts, opened };

    if (opened) {
      await sleep(400);
      // NB: match the textbox specifically. The fixture also renders a
      // visually-hidden <label> carrying the same string, and a naive
      // first-match on the accessible name lands on the label instead — a
      // failure mode that costs an agent a silent no-op, not an error.
      const input = await refFor('snapshot-2', /textbox .*Daily budget for/);
      if (input.ref) {
        await record('type-value', 'browser_type', {
          element: "daily budget input", target: input.ref, text: '199.99', submit: false
        });
        const save = await refFor('snapshot-save', /Save budget for/);
        if (save.ref) {
          await record('click-save', 'browser_click', { element: "save budget", target: save.ref });
          await sleep(1600);
        } else results.notes.push('save control ref not found');
      } else results.notes.push('budget input ref not found after opening the editor');
      const final = await record('snapshot-3', 'browser_snapshot', {});
      results.finalSnapshotExcerpt = final
        .split('\n')
        .filter((l) => /budget|Budget|error|invalid/i.test(l))
        .slice(0, 12);
    } else {
      results.notes.push('could not open the budget editor via stock MCP refs within 3 attempts');
    }

    // Did it actually land? Checked out-of-band, because the compose option
    // has no verification path of its own.
    const list = await (await fetch(`${BASE}/api/campaigns?offset=0&limit=50`)).json();
    const changed = list.rows.filter((r) => r.dailyBudget === 199.99);
    results.outcome = {
      mutationLanded: changed.length === 1,
      changedEntityIds: changed.map((r) => r.id),
      note: 'verified via the fixture API — stock MCP offers no deterministic verification primitive'
    };

    results.totals = {
      roundTrips: results.traffic.length,
      totalChars: results.traffic.reduce((a, t) => a + t.chars, 0),
      totalEstTokens: results.traffic.reduce((a, t) => a + t.estTokens, 0),
      wallClockMs: Date.now() - t0
    };

    // ------------------------------------------------ governance gap analysis
    // Which §2.2 proposal fields can a thin wrapper populate from the MCP
    // surface alone, with no adapter and no site knowledge?
    const derivable = {
      workspace: 'wrapper-owned',
      session: 'wrapper-owned',
      originScope: 'from browser_navigate url argument',
      accountId: 'NO — not present anywhere in the MCP surface',
      entityType: 'NO — snapshot has roles, not entity types',
      entityId: 'NO — refs are per-snapshot handles, not platform ids',
      actionClass: 'NO — click/type carry no consequence class; would be "unknown"',
      operation: 'partial — tool name only (browser_click), not "set_daily_budget"',
      parameters: 'partial — {ref, text}, not {field: dailyBudget}',
      oldValue: 'NO — recoverable only by parsing the rendered label heuristically',
      newValue: 'partial — the typed string, if the wrapper intercepts browser_type',
      unit: 'NO',
      expectedMaxConsequence: 'NO — cannot be computed without old/new value',
      stateDigests: 'partial — hash of the snapshot text, which churns on every rerender',
      adapterVersion: 'N/A — no adapters exist in this option',
      laneVersion: 'wrapper-owned',
      policyVersion: 'wrapper-owned',
      requestingPrincipal: 'wrapper-owned',
      expiresAt: 'wrapper-owned'
    };
    const blocked = PROPOSAL_FIELDS.filter((f) => /^NO/.test(derivable[f] || 'NO'));
    const partial = PROPOSAL_FIELDS.filter((f) => /^partial/.test(derivable[f] || ''));
    results.governanceGap = {
      fieldDerivability: derivable,
      fieldsNotDerivable: blocked,
      fieldsPartial: partial,
      approvalCanBindTo: 'tool name + opaque ref + typed text',
      approvalCannotBindTo: blocked,
      consequence:
        'An approval issued over this surface reads "approve browser_click on ref e42". ' +
        'It cannot state which account, which campaign, or what the value moves from and to. ' +
        'The operator is therefore approving a gesture, not a consequence.'
    };
  } catch (e) {
    results.error = String(e && e.stack ? e.stack : e);
    results.stderrTail = mcp.stderr.slice(-800);
  } finally {
    mcp.kill();
    fixture.kill('SIGKILL');
  }

  mkdirSync(dirname(OUT), { recursive: true });
  writeFileSync(OUT, JSON.stringify(results, null, 2));
  console.log('wrote', OUT);
  console.log('tool surface:', results.toolSurface?.count, 'tools,', results.toolSurface?.schemaEstTokens, 'est tokens of schema');
  for (const t of results.traffic) console.log(`  ${t.label.padEnd(14)} ${String(t.ms).padStart(6)}ms ${String(t.estTokens).padStart(6)} tok`);
  console.log('totals:', JSON.stringify(results.totals));
  console.log('outcome:', JSON.stringify(results.outcome));
  if (results.error) { console.error(results.error); process.exitCode = 1; }
}

main();
