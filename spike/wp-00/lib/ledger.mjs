/*
 * WP-00 spike — minimal hash-chained JSONL event log. DISPOSABLE.
 *
 * Deliberately NOT the WP-04 ledger: no SQLite, no CAS, no signed
 * checkpoints. It exists to answer one spike question — can the run be
 * reconstructed from the log alone, and does chaining cost anything
 * noticeable per event?
 *
 * Honesty label (carried forward from PLAN v1.1 §2.3): tamper-EVIDENT
 * against post-hoc edits of earlier lines. Not tamper-proof: anything that
 * can rewrite the file can also recompute the chain.
 */
import { appendFileSync, readFileSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { sha256, canonicalize } from './canonical.mjs';

const GENESIS = '0'.repeat(64);

export class Ledger {
  constructor(path) {
    this.path = path;
    mkdirSync(dirname(path), { recursive: true });
    if (!existsSync(path)) writeFileSync(path, '');
    this.seq = 0;
    this.prev = GENESIS;
    for (const line of readFileSync(path, 'utf8').split('\n')) {
      if (!line.trim()) continue;
      const e = JSON.parse(line);
      this.seq = e.seq + 1;
      this.prev = e.hash;
    }
  }

  append(type, payload) {
    const body = { seq: this.seq, ts: new Date().toISOString(), type, prev: this.prev, payload };
    const hash = sha256(canonicalize(body));
    const event = { ...body, hash };
    appendFileSync(this.path, JSON.stringify(event) + '\n');
    this.seq++;
    this.prev = hash;
    return event;
  }

  /** Returns {ok, events, brokenAt} — brokenAt is the first bad seq, if any. */
  verify() {
    let prev = GENESIS;
    const events = [];
    let n = 0;
    for (const line of readFileSync(this.path, 'utf8').split('\n')) {
      if (!line.trim()) continue;
      const e = JSON.parse(line);
      const { hash, ...body } = e;
      if (e.seq !== n || e.prev !== prev || sha256(canonicalize(body)) !== hash) {
        return { ok: false, events, brokenAt: e.seq };
      }
      events.push(e);
      prev = hash;
      n++;
    }
    return { ok: true, events, brokenAt: null };
  }
}
