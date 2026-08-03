/*
 * WP-00 Track C — the disposable approval surface. DISPOSABLE spike code.
 *
 * A plain local page, deliberately NOT the dashboard and deliberately NOT
 * rendered inside the target site (PLAN v1.1 §2.5: no approval UI may ever
 * live inside a page the target platform controls).
 *
 * Properties being spiked:
 *   - the approval binds to the FULL proposal hash, not a state digest
 *   - approvals expire (TTL) and are single-use (nonce consumed on execute)
 *   - any drift in any proposal component voids the approval, because the
 *     hash is recomputed from the proposal at execute time
 */
import { createServer } from 'node:http';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { proposalHash } from '../lib/canonical.mjs';

const esc = (s) =>
  String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

export class ApprovalService {
  constructor({ ttlMs = 120000, ledger } = {}) {
    this.ttlMs = ttlMs;
    this.ledger = ledger;
    this.proposals = new Map();  // hash -> proposal
    this.approvals = new Map();  // nonce -> approval record
    this.server = null;
    this.port = null;
  }

  async listen(port = 0) {
    this.server = createServer((req, res) => this._handle(req, res));
    await new Promise((ok) => this.server.listen(port, '127.0.0.1', ok));
    this.port = this.server.address().port;
    return `http://127.0.0.1:${this.port}`;
  }

  async close() {
    if (this.server) await new Promise((ok) => this.server.close(ok));
  }

  register(proposal) {
    const hash = proposalHash(proposal);
    this.proposals.set(hash, proposal);
    this.ledger?.append('proposal.created', { proposalHash: hash, proposal });
    return hash;
  }

  /** Issue an approval. `by` identifies the human; the spike may simulate it. */
  approve(hash, by) {
    const proposal = this.proposals.get(hash);
    if (!proposal) throw new Error('unknown proposal');
    const nonce = randomBytes(16).toString('hex');
    const rec = {
      nonce,
      proposalHash: hash,
      approvedBy: by,
      issuedAt: Date.now(),
      expiresAt: Date.now() + this.ttlMs,
      consumed: false
    };
    this.approvals.set(nonce, rec);
    this.ledger?.append('approval.issued', {
      proposalHash: hash, approvedBy: by, nonce, expiresAt: new Date(rec.expiresAt).toISOString()
    });
    return rec;
  }

  /**
   * The single gate. Returns {ok:true} or {ok:false, reason}. Every rejection
   * reason here is one of the attacks the spike must prove is mechanically
   * blocked, not merely discouraged by prompt.
   */
  authorize(nonce, liveProposal) {
    const rec = this.approvals.get(nonce);
    if (!rec) return this._deny('no-such-approval', { nonce });
    if (rec.consumed) return this._deny('replay', { nonce, proposalHash: rec.proposalHash });
    if (Date.now() > rec.expiresAt) return this._deny('expired', { nonce, proposalHash: rec.proposalHash });

    let liveHash;
    try { liveHash = proposalHash(liveProposal); }
    catch (e) { return this._deny('unhashable-proposal', { error: String(e.message) }); }

    const a = Buffer.from(rec.proposalHash, 'utf8');
    const b = Buffer.from(liveHash, 'utf8');
    if (a.length !== b.length || !timingSafeEqual(a, b)) {
      return this._deny('proposal-drift', { approvedHash: rec.proposalHash, liveHash });
    }

    rec.consumed = true;
    this.ledger?.append('approval.consumed', { proposalHash: liveHash, nonce });
    return { ok: true, proposalHash: liveHash, approvedBy: rec.approvedBy };
  }

  _deny(reason, detail) {
    this.ledger?.append('approval.denied', { reason, ...detail });
    return { ok: false, reason, ...detail };
  }

  // ------------------------------------------------------------ http surface

  _handle(req, res) {
    const url = new URL(req.url, `http://127.0.0.1:${this.port}`);
    const m = url.pathname.match(/^\/approve\/([0-9a-f]{64})$/);
    if (!m) { res.writeHead(404, { 'content-type': 'text/plain' }); return res.end('not found'); }
    const hash = m[1];
    const proposal = this.proposals.get(hash);
    if (!proposal) { res.writeHead(404, { 'content-type': 'text/plain' }); return res.end('unknown proposal'); }

    if (req.method === 'POST') {
      let body = '';
      req.on('data', (d) => (body += d));
      req.on('end', () => {
        const by = new URLSearchParams(body).get('by') || 'unknown-operator';
        const rec = this.approve(hash, by);
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ nonce: rec.nonce, expiresAt: rec.expiresAt }));
      });
      return;
    }

    // Full proposal is rendered, field by field. Nothing is summarised away:
    // the operator approves exactly what will be hashed.
    const rows = Object.entries(proposal)
      .map(([k, v]) => `<tr><th>${esc(k)}</th><td><code>${esc(typeof v === 'object' ? JSON.stringify(v) : v)}</code></td></tr>`)
      .join('\n');
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(`<!doctype html><meta charset="utf-8"><title>Approve action</title>
<style>body{font:14px/1.5 system-ui;margin:2rem;max-width:900px}
th{text-align:left;padding-right:1rem;vertical-align:top;white-space:nowrap}
td{word-break:break-all}table{border-collapse:collapse}tr{border-bottom:1px solid #eee}
.hash{background:#f6f6f6;padding:.5rem;font-family:monospace;word-break:break-all}</style>
<h1>Approve action</h1>
<p>This page is served by the Chinvat spike on localhost. It is not part of the target site.</p>
<div class="hash">proposal hash: ${esc(hash)}</div>
<table>${rows}</table>
<form method="POST"><input name="by" value="operator" aria-label="operator"><button type="submit">Approve</button></form>`);
  }
}
