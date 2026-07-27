import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Request, Response, NextFunction } from 'express';
import {
  MIN_TOKEN_LENGTH,
  assertBindPolicy,
  authRequired,
  authorize,
  bearerFrom,
  isLoopbackBind,
  makeAuth,
  tokenMatches,
  wsTokenFrom,
} from '../auth.js';

const GOOD = 'a'.repeat(MIN_TOKEN_LENGTH);

test('recognises every loopback bind form', () => {
  for (const b of ['127.0.0.1', '127.1.2.3', 'localhost', 'LOCALHOST', '::1', '[::1]', ' 127.0.0.1 '])
    assert.equal(isLoopbackBind(b), true, b);
  for (const b of ['0.0.0.0', '100.101.102.103', '192.168.1.5', '::', ''])
    assert.equal(isLoopbackBind(b), false, b);
});

test('bind policy allows a loopback hub with no token', () => {
  assert.doesNotThrow(() => assertBindPolicy('127.0.0.1', ''));
  assert.doesNotThrow(() => assertBindPolicy('localhost', ''));
});

test('bind policy refuses a non-loopback hub with no token', () => {
  assert.throws(() => assertBindPolicy('0.0.0.0', ''), /refusing to start/);
  assert.throws(() => assertBindPolicy('100.101.102.103', '   '), /no authToken/);
});

test('bind policy refuses a token too short to be worth having', () => {
  assert.throws(() => assertBindPolicy('127.0.0.1', 'short'), /at least 24/);
  assert.throws(() => assertBindPolicy('0.0.0.0', 'short'), /at least 24/);
});

test('bind policy accepts a non-loopback hub with a strong token', () => {
  assert.doesNotThrow(() => assertBindPolicy('100.101.102.103', GOOD));
});

test('parses bearer headers and ignores other schemes', () => {
  assert.equal(bearerFrom('Bearer abc123'), 'abc123');
  assert.equal(bearerFrom('bearer   abc123  '), 'abc123');
  assert.equal(bearerFrom('Basic abc123'), undefined);
  assert.equal(bearerFrom(undefined), undefined);
  assert.equal(bearerFrom(''), undefined);
});

test('token comparison rejects mismatches, prefixes and empties', () => {
  assert.equal(tokenMatches(GOOD, GOOD), true);
  assert.equal(tokenMatches(GOOD, GOOD.slice(0, -1)), false, 'prefix must not pass');
  assert.equal(tokenMatches(GOOD, GOOD + 'x'), false, 'extension must not pass');
  assert.equal(tokenMatches(GOOD, undefined), false);
  assert.equal(tokenMatches('', ''), false, 'an unset token never authenticates');
  assert.equal(tokenMatches('', 'anything'), false);
});

interface Probe {
  status?: number;
  body?: unknown;
  headers: Record<string, string>;
  nexted: boolean;
}

function run(auth: ReturnType<typeof makeAuth>, authorization?: string): Probe {
  const probe: Probe = { headers: {}, nexted: false };
  const req = { headers: authorization ? { authorization } : {} } as unknown as Request;
  const res = {
    setHeader(k: string, v: string) {
      probe.headers[k] = v;
    },
    status(code: number) {
      probe.status = code;
      return this;
    },
    json(body: unknown) {
      probe.body = body;
      return this;
    },
  } as unknown as Response;
  auth(req, res, (() => {
    probe.nexted = true;
  }) as NextFunction);
  return probe;
}

test('loopback hub with no token stays open for local use', () => {
  const auth = makeAuth({ token: () => '', bind: () => '127.0.0.1' });
  assert.equal(run(auth).nexted, true);
});

test('non-loopback hub with no token serves nothing', () => {
  const auth = makeAuth({ token: () => '', bind: () => '0.0.0.0' });
  const probe = run(auth);
  assert.equal(probe.nexted, false);
  assert.equal(probe.status, 500);
});

test('a configured token is required even on loopback', () => {
  const auth = makeAuth({ token: () => GOOD, bind: () => '127.0.0.1' });
  assert.equal(run(auth).status, 401, 'no header');
  assert.equal(run(auth, 'Bearer wrong').status, 401);
  assert.equal(run(auth, `Bearer ${GOOD}`).nexted, true);
});

test('unauthorized responses advertise the bearer scheme', () => {
  const auth = makeAuth({ token: () => GOOD, bind: () => '100.64.0.1' });
  const probe = run(auth, 'Bearer nope');
  assert.equal(probe.status, 401);
  assert.match(probe.headers['WWW-Authenticate'], /Bearer/);
});

test('every transport shares one decision procedure', () => {
  const tokened = { token: () => GOOD, bind: () => '100.64.0.1' };
  const open = { token: () => '', bind: () => '127.0.0.1' };
  const broken = { token: () => '', bind: () => '0.0.0.0' };
  assert.deepEqual(authorize(tokened, GOOD), { ok: true });
  assert.deepEqual(authorize(open, undefined), { ok: true });
  assert.equal(authorize(tokened, undefined).ok, false);
  assert.equal((authorize(tokened, 'nope') as { status: number }).status, 401);
  assert.equal((authorize(broken, GOOD) as { status: number }).status, 500);
});

test('authRequired tells the dashboard whether to prompt', () => {
  assert.equal(authRequired({ token: () => GOOD, bind: () => '100.64.0.1' }), true);
  assert.equal(authRequired({ token: () => '  ', bind: () => '127.0.0.1' }), false);
});

test('websocket upgrades accept a query token, header taking precedence', () => {
  // Browsers cannot set headers on new WebSocket(), so /ws?token= is the only channel.
  assert.equal(wsTokenFrom('/ws?token=abc', undefined), 'abc');
  assert.equal(wsTokenFrom('/ws?token=a%2Fb', undefined), 'a/b', 'query value is decoded');
  assert.equal(wsTokenFrom('/ws', 'Bearer hdr'), 'hdr');
  assert.equal(wsTokenFrom('/ws?token=qry', 'Bearer hdr'), 'hdr', 'header wins');
  assert.equal(wsTokenFrom('/ws', undefined), undefined);
  assert.equal(wsTokenFrom(undefined, undefined), undefined);
});

test('the event stream is gated exactly like the api', () => {
  const deps = { token: () => GOOD, bind: () => '100.64.0.1' };
  assert.equal(authorize(deps, wsTokenFrom(`/ws?token=${GOOD}`, undefined)).ok, true);
  assert.equal(authorize(deps, wsTokenFrom('/ws', undefined)).ok, false, 'no token must not stream jobs');
  assert.equal(authorize(deps, wsTokenFrom('/ws?token=wrong', undefined)).ok, false);
});
