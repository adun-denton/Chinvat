/**
 * Relay envelope grammar — the wire format between Chinvat and a chatbot UI.
 *
 * A packet leaves Chinvat carrying an opening marker; the model's reply must
 * come back wrapped in BEGIN_CHINVAT_RESPONSE / END_CHINVAT_RESPONSE. The
 * envelope is deterministic and side-effect free: emit() builds the request
 * header, parse() extracts a structured reply, verify() binds the reply to the
 * exact task+packet it answers. Nothing here touches the network or disk.
 *
 * Design notes carried from docs/DESIGN-mail-relay.md:
 *  - TASK_ID binds a reply to a task; a mismatch is rejected, never guessed.
 *  - PACKET_SHA binds a reply to the *exact* packet bytes; catches a reply to a
 *    stale/edited packet even when the TASK_ID happens to match.
 *  - The mandatory END marker doubles as truncation detection: a reply without
 *    it was cut off (chat UI length limit, copy error, send failure).
 *  - The payload is inert DATA until relay-worktree validates it. Parsing here
 *    must never eval, import, or apply anything.
 */

export type OutputType = 'PLAN' | 'UNIFIED_DIFF' | 'REVIEW' | 'FILE_SET';

export const BEGIN_MARKER = 'BEGIN_CHINVAT_RESPONSE';
export const END_MARKER = 'END_CHINVAT_RESPONSE';

/** Section header inside a FILE_SET payload: one full-file replacement. */
const FILE_HEADER = /^FILE:\s*(.+?)\s*$/;

export interface RelayFile {
  /** Repo-relative POSIX path. */
  path: string;
  /** Full replacement contents. */
  content: string;
}

export interface ParsedResponse {
  taskId: string;
  baseCommit: string;
  packetSha: string;
  modelSurface: string;
  outputType: OutputType;
  assumptions: string[];
  validationNotes: string[];
  /** Raw payload text between the header block and VALIDATION_NOTES. */
  payload: string;
  /** Populated when outputType === 'FILE_SET'. */
  files: RelayFile[];
  /** Populated when outputType === 'UNIFIED_DIFF'. */
  diff?: string;
}

export interface EmitOpts {
  taskId: string;
  baseCommit: string;
  packetSha: string;
  outputType: OutputType;
  /** Where the model should send/draft the reply (address or "a Gmail draft"). */
  returnTo: string;
}

export class EnvelopeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'EnvelopeError';
  }
}

/**
 * Human-facing instruction block prepended to a packet. It tells the operator's
 * chatbot session exactly how to frame its reply so parse() can read it back.
 */
export function emitReturnInstructions(o: EmitOpts): string {
  return [
    '## RETURN PROTOCOL (required)',
    '',
    `Reply MUST be wrapped exactly as below and sent to: ${o.returnTo}`,
    '',
    '```',
    BEGIN_MARKER,
    `TASK_ID: ${o.taskId}`,
    `BASE_COMMIT: ${o.baseCommit}`,
    `PACKET_SHA: ${o.packetSha}`,
    'MODEL_SURFACE: <your model/product name>',
    `OUTPUT_TYPE: ${o.outputType}`,
    'ASSUMPTIONS:',
    '- <one per line, or "none">',
    '',
    o.outputType === 'FILE_SET'
      ? 'FILE: relative/path/one.ext\n<full file contents>\n\nFILE: relative/path/two.ext\n<full file contents>'
      : o.outputType === 'UNIFIED_DIFF'
        ? '<a single unified diff, git apply compatible>'
        : '<your plan or review text>',
    '',
    'VALIDATION_NOTES:',
    '- <how you verified, or caveats>',
    END_MARKER,
    '```',
    '',
    'Do not omit the END marker. Echo TASK_ID and PACKET_SHA verbatim.',
  ].join('\n');
}

function extractField(header: string, key: string): string | undefined {
  const m = header.match(new RegExp(`^${key}:\\s*(.*)$`, 'm'));
  return m ? m[1].trim() : undefined;
}

/** Pull a "- item" bulleted list that begins at `label:` and runs to a blank line or next KEY:. */
function extractList(block: string, label: string): string[] {
  const start = block.search(new RegExp(`^${label}:\\s*$`, 'm'));
  if (start < 0) return [];
  const rest = block.slice(start).split('\n').slice(1);
  const items: string[] = [];
  for (const raw of rest) {
    const line = raw.trimEnd();
    if (/^[A-Z_]+:\s*$/.test(line) || /^[A-Z_]+:\s/.test(line)) break; // next section
    const m = line.match(/^-\s+(.*)$/);
    if (m) {
      const v = m[1].trim();
      if (v && v.toLowerCase() !== 'none') items.push(v);
    } else if (line.trim() === '' && items.length) {
      break;
    }
  }
  return items;
}

/**
 * Parse a raw model reply into a structured response. Rejects malformed or
 * truncated envelopes. Does NOT verify identity — call verify() for that.
 */
export function parse(raw: string): ParsedResponse {
  const begin = raw.indexOf(BEGIN_MARKER);
  if (begin < 0) throw new EnvelopeError(`missing ${BEGIN_MARKER} — not a relay reply`);
  const end = raw.indexOf(END_MARKER, begin);
  if (end < 0)
    throw new EnvelopeError(`missing ${END_MARKER} — reply is truncated or was cut off mid-send`);

  const body = raw.slice(begin + BEGIN_MARKER.length, end);

  const taskId = extractField(body, 'TASK_ID');
  const baseCommit = extractField(body, 'BASE_COMMIT');
  const packetSha = extractField(body, 'PACKET_SHA');
  const modelSurface = extractField(body, 'MODEL_SURFACE') ?? 'unknown';
  const outputTypeRaw = extractField(body, 'OUTPUT_TYPE');

  if (!taskId) throw new EnvelopeError('envelope missing TASK_ID');
  if (!baseCommit) throw new EnvelopeError('envelope missing BASE_COMMIT');
  if (!packetSha) throw new EnvelopeError('envelope missing PACKET_SHA');
  if (!outputTypeRaw) throw new EnvelopeError('envelope missing OUTPUT_TYPE');

  const outputType = outputTypeRaw.toUpperCase() as OutputType;
  if (!['PLAN', 'UNIFIED_DIFF', 'REVIEW', 'FILE_SET'].includes(outputType))
    throw new EnvelopeError(`unknown OUTPUT_TYPE '${outputTypeRaw}'`);

  const assumptions = extractList(body, 'ASSUMPTIONS');
  const validationNotes = extractList(body, 'VALIDATION_NOTES');

  // Payload = everything after the header block and before VALIDATION_NOTES.
  // The header block ends at the first blank line following the last known key.
  const vnIdx = body.search(/^VALIDATION_NOTES:\s*$/m);
  const headerEnd = locatePayloadStart(body);
  const payload = body
    .slice(headerEnd, vnIdx >= 0 ? vnIdx : undefined)
    .replace(/^\s+|\s+$/g, '');

  const parsed: ParsedResponse = {
    taskId,
    baseCommit,
    packetSha,
    modelSurface,
    outputType,
    assumptions,
    validationNotes,
    payload,
    files: [],
  };

  if (outputType === 'FILE_SET') parsed.files = parseFileSet(payload);
  if (outputType === 'UNIFIED_DIFF') parsed.diff = payload;
  return parsed;
}

/** Start of payload: first line after the ASSUMPTIONS list (or after OUTPUT_TYPE). */
function locatePayloadStart(body: string): number {
  const asmIdx = body.search(/^ASSUMPTIONS:\s*$/m);
  const anchor = asmIdx >= 0 ? asmIdx : body.search(/^OUTPUT_TYPE:.*$/m);
  if (anchor < 0) return 0;
  // advance past the bulleted list following the anchor
  const lines = body.slice(anchor).split('\n');
  let consumed = anchor;
  let seenNonList = false;
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i];
    consumed += lines[i - 1].length + 1;
    if (/^-\s+/.test(line) || line.trim() === '') continue;
    seenNonList = true;
    break;
  }
  return seenNonList ? consumed : body.length;
}

/** Split a FILE_SET payload into (path, content) pairs by FILE: headers. */
export function parseFileSet(payload: string): RelayFile[] {
  const lines = payload.split('\n');
  const files: RelayFile[] = [];
  let cur: { path: string; buf: string[] } | null = null;
  for (const line of lines) {
    const m = line.match(FILE_HEADER);
    if (m) {
      if (cur) files.push({ path: cur.path, content: cur.buf.join('\n').replace(/^\n+|\n+$/g, '') });
      cur = { path: normalizePath(m[1]), buf: [] };
    } else if (cur) {
      cur.buf.push(line);
    }
  }
  if (cur) files.push({ path: cur.path, content: cur.buf.join('\n').replace(/^\n+|\n+$/g, '') });
  if (!files.length) throw new EnvelopeError('FILE_SET payload contained no FILE: sections');
  return files;
}

function normalizePath(p: string): string {
  return p.trim().replace(/\\/g, '/').replace(/^\.?\//, '');
}

export interface VerifyExpect {
  taskId: string;
  baseCommit: string;
  packetSha: string;
  /** Repo-relative paths the packet declared in scope; FILE_SET writes must stay inside. */
  allowedPaths?: string[];
}

export interface VerifyResult {
  ok: boolean;
  problems: string[];
}

/**
 * Bind a parsed reply to the task it must answer. Returns problems rather than
 * throwing so the caller can record every mismatch (dashboard/decision.md).
 */
export function verify(parsed: ParsedResponse, expect: VerifyExpect): VerifyResult {
  const problems: string[] = [];
  if (parsed.taskId !== expect.taskId)
    problems.push(`TASK_ID mismatch: reply=${parsed.taskId} expected=${expect.taskId}`);
  if (parsed.packetSha !== expect.packetSha)
    problems.push(
      `PACKET_SHA mismatch: reply answers a different packet (reply=${parsed.packetSha.slice(0, 12)} expected=${expect.packetSha.slice(0, 12)})`
    );
  if (parsed.baseCommit !== expect.baseCommit)
    problems.push(
      `BASE_COMMIT mismatch: reply=${parsed.baseCommit.slice(0, 12)} expected=${expect.baseCommit.slice(0, 12)} — patch would land on a stale base`
    );
  if (expect.allowedPaths && parsed.outputType === 'FILE_SET') {
    const allow = new Set(expect.allowedPaths.map(normalizePath));
    for (const f of parsed.files)
      if (!allow.has(f.path))
        problems.push(`file '${f.path}' is outside the packet's declared scope`);
  }
  for (const f of parsed.files) {
    if (f.path.includes('..') || f.path.startsWith('/'))
      problems.push(`unsafe path in reply: '${f.path}'`);
  }
  return { ok: problems.length === 0, problems };
}
