import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  emitReturnInstructions,
  parse,
  verify,
  parseFileSet,
  EnvelopeError,
} from '../lib/relay-envelope.js';

const GOOD = `
Some model preamble that should be ignored.

BEGIN_CHINVAT_RESPONSE
TASK_ID: CR-2026-0007
BASE_COMMIT: abc123def456
PACKET_SHA: deadbeefcafe
MODEL_SURFACE: ChatGPT
OUTPUT_TYPE: FILE_SET
ASSUMPTIONS:
- assumed node 22
- none

FILE: src/a.ts
export const a = 1;

FILE: src/b.ts
export const b = 2;

VALIDATION_NOTES:
- ran tsc locally
END_CHINVAT_RESPONSE

trailing chatter
`;

test('parse extracts header fields and files', () => {
  const p = parse(GOOD);
  assert.equal(p.taskId, 'CR-2026-0007');
  assert.equal(p.baseCommit, 'abc123def456');
  assert.equal(p.packetSha, 'deadbeefcafe');
  assert.equal(p.outputType, 'FILE_SET');
  assert.equal(p.modelSurface, 'ChatGPT');
  assert.deepEqual(p.assumptions, ['assumed node 22']); // "none" dropped
  assert.equal(p.files.length, 2);
  assert.equal(p.files[0].path, 'src/a.ts');
  assert.match(p.files[0].content, /export const a = 1;/);
  assert.deepEqual(p.validationNotes, ['ran tsc locally']);
});

test('missing END marker is a truncation error', () => {
  const truncated = GOOD.replace('END_CHINVAT_RESPONSE', '');
  assert.throws(() => parse(truncated), EnvelopeError);
});

test('missing BEGIN marker is rejected', () => {
  assert.throws(() => parse('no envelope here'), EnvelopeError);
});

test('verify passes on matching identity', () => {
  const p = parse(GOOD);
  const r = verify(p, {
    taskId: 'CR-2026-0007',
    baseCommit: 'abc123def456',
    packetSha: 'deadbeefcafe',
    allowedPaths: ['src/a.ts', 'src/b.ts'],
  });
  assert.equal(r.ok, true);
  assert.deepEqual(r.problems, []);
});

test('verify catches packet_sha mismatch (stale/edited packet)', () => {
  const p = parse(GOOD);
  const r = verify(p, { taskId: 'CR-2026-0007', baseCommit: 'abc123def456', packetSha: 'different' });
  assert.equal(r.ok, false);
  assert.match(r.problems.join(' '), /PACKET_SHA mismatch/);
});

test('verify rejects out-of-scope file writes', () => {
  const p = parse(GOOD);
  const r = verify(p, {
    taskId: 'CR-2026-0007',
    baseCommit: 'abc123def456',
    packetSha: 'deadbeefcafe',
    allowedPaths: ['src/a.ts'], // b.ts not allowed
  });
  assert.equal(r.ok, false);
  assert.match(r.problems.join(' '), /outside the packet's declared scope/);
});

test('verify rejects path traversal', () => {
  const evil = GOOD.replace('src/b.ts', '../../etc/passwd');
  const p = parse(evil);
  const r = verify(p, { taskId: 'CR-2026-0007', baseCommit: 'abc123def456', packetSha: 'deadbeefcafe' });
  assert.equal(r.ok, false);
  assert.match(r.problems.join(' '), /unsafe path/);
});

test('parseFileSet requires at least one FILE section', () => {
  assert.throws(() => parseFileSet('no file headers'), EnvelopeError);
});

test('emitReturnInstructions embeds the ids the model must echo', () => {
  const s = emitReturnInstructions({
    taskId: 'CR-2026-0009',
    baseCommit: 'aaa',
    packetSha: 'bbb',
    outputType: 'FILE_SET',
    returnTo: 'me@example.com',
  });
  assert.match(s, /TASK_ID: CR-2026-0009/);
  assert.match(s, /PACKET_SHA: bbb/);
  assert.match(s, /me@example.com/);
  assert.match(s, /END_CHINVAT_RESPONSE/);
});
