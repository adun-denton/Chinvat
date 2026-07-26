/*
 * WP-00 spike — canonicalisation + proposal hashing. DISPOSABLE.
 *
 * PLAN v1.1 §2.2 requires the approval to bind to a canonical hash over the
 * ENTIRE proposal, not just a state digest. This is the hand-computed
 * canonicalisation the spike uses to find out whether that is actually
 * workable (it is the thing WP-02 must standardise).
 *
 * Canonicalisation rules, deliberately boring:
 *   - objects: keys sorted lexicographically (by UTF-16 code unit)
 *   - arrays: order preserved (order is semantic)
 *   - numbers: rejected unless finite; serialised via JSON number rules
 *   - undefined: rejected (absence must be explicit null, so a dropped field
 *     can never hash the same as a null field)
 *   - strings: NFC-normalised, so visually identical operator input cannot
 *     produce two different hashes
 */
import { createHash } from 'node:crypto';

export function canonicalize(value, path = '$') {
  if (value === undefined) throw new Error(`undefined is not canonicalisable at ${path}`);
  if (value === null) return 'null';
  const t = typeof value;
  if (t === 'string') return JSON.stringify(value.normalize('NFC'));
  if (t === 'boolean') return value ? 'true' : 'false';
  if (t === 'number') {
    if (!Number.isFinite(value)) throw new Error(`non-finite number at ${path}`);
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return '[' + value.map((v, i) => canonicalize(v, `${path}[${i}]`)).join(',') + ']';
  }
  if (t === 'object') {
    const keys = Object.keys(value).sort();
    return '{' + keys.map((k) => JSON.stringify(k.normalize('NFC')) + ':' + canonicalize(value[k], `${path}.${k}`)).join(',') + '}';
  }
  throw new Error(`unsupported type ${t} at ${path}`);
}

export const sha256 = (s) => createHash('sha256').update(s, 'utf8').digest('hex');

/**
 * The full-proposal hash. Every field named in PLAN v1.1 §2.2 is REQUIRED —
 * a missing field is an error, not a silently-omitted key, because "the
 * approval didn't cover the account id" must be impossible by construction.
 */
export const PROPOSAL_FIELDS = [
  'workspace', 'session', 'originScope', 'accountId', 'entityType', 'entityId',
  'actionClass', 'operation', 'parameters', 'oldValue', 'newValue', 'unit',
  'expectedMaxConsequence', 'stateDigests', 'adapterVersion', 'laneVersion',
  'policyVersion', 'requestingPrincipal', 'expiresAt'
];

export function proposalHash(proposal) {
  const missing = PROPOSAL_FIELDS.filter((f) => !(f in proposal));
  if (missing.length) throw new Error('proposal missing required fields: ' + missing.join(', '));
  const extra = Object.keys(proposal).filter((k) => !PROPOSAL_FIELDS.includes(k));
  if (extra.length) throw new Error('proposal has undeclared fields: ' + extra.join(', '));
  const ordered = {};
  for (const f of PROPOSAL_FIELDS) ordered[f] = proposal[f];
  return sha256(canonicalize(ordered));
}
