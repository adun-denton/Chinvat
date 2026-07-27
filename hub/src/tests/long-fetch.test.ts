import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import { Agent } from 'undici';
import {
  LONG_FETCH_AGENT_OPTS,
  jsonFetch,
  longFetchDispatcher,
  resolveDispatcher,
} from '../adapters/util.js';

/**
 * TASK-CHINVAT-017. Two model pulls through the hub died at 305 s despite
 * `timeoutMs: 3_600_000`, because undici enforces `headersTimeout` and
 * `bodyTimeout` (300 s each) independently of the AbortSignal.
 *
 * These tests reproduce that failure mode against a local server with the
 * timeouts scaled down to milliseconds, so they assert the *mechanism* rather
 * than the 300 s constant and depend on no network condition.
 */

/**
 * undici drives these timeouts off a coarse shared timer whose tick is ~1 s, so
 * a 1 s setting actually fires at ~1.5 s and anything under a second never
 * fires at all (measured: a 60 ms agent sailed through a 400 ms stall). The
 * stall therefore has to clear ~2 s to be a real negative control — and that
 * same slop is why the production failures landed at 305 s, not 300 s.
 */
const SHORT_TIMEOUT_MS = 1_000;
const LONG_STALL_MS = 2_600;
/** The disabled-timeout path only has to outlast a stall, not a timer. */
const SHORT_STALL_MS = 150;
/** Long enough that the AbortSignal is never the cause of a failure below. */
const ABORT_MS = 30_000;

/** Withholds the response head, like `ollama /api/pull` does for a whole download. */
function headerStallServer(stallMs: number): Promise<{ url: string; close: () => Promise<void> }> {
  return listen((_req, res) => {
    setTimeout(() => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ status: 'success' }));
    }, stallMs);
  });
}

/** Sends the head immediately, then stalls mid-body — the streaming-progress case. */
function bodyStallServer(stallMs: number): Promise<{ url: string; close: () => Promise<void> }> {
  return listen((_req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.write('{"status":');
    setTimeout(() => res.end('"success"}'), stallMs);
  });
}

function listen(
  handler: Parameters<typeof createServer>[1]
): Promise<{ url: string; close: () => Promise<void> }> {
  return new Promise((resolve) => {
    const server: Server = createServer(handler);
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address();
      const port = typeof addr === 'object' && addr ? addr.port : 0;
      resolve({
        url: `http://127.0.0.1:${port}/`,
        close: () => new Promise<void>((done) => server.close(() => done())),
      });
    });
  });
}

test('undici headersTimeout kills a slow request even when timeoutMs is generous', async () => {
  const { url, close } = await headerStallServer(LONG_STALL_MS);
  const agent = new Agent({ headersTimeout: SHORT_TIMEOUT_MS });
  try {
    await assert.rejects(
      jsonFetch(url, { timeoutMs: ABORT_MS, dispatcher: agent }),
      (e: Error) => {
        // The cause chain must name the real fault; bare 'fetch failed' is what
        // made this defect take two sessions to diagnose.
        assert.match(e.message, /UND_ERR_HEADERS_TIMEOUT|Headers Timeout/i);
        assert.doesNotMatch(e.message, /abort/i);
        return true;
      }
    );
  } finally {
    await agent.close();
    await close();
  }
});

test('undici bodyTimeout truncates a stalled body even when timeoutMs is generous', async () => {
  const { url, close } = await bodyStallServer(LONG_STALL_MS);
  const agent = new Agent({ bodyTimeout: SHORT_TIMEOUT_MS });
  try {
    await assert.rejects(jsonFetch(url, { timeoutMs: ABORT_MS, dispatcher: agent }), (e: Error) => {
      assert.match(e.message, /UND_ERR_BODY_TIMEOUT|Body Timeout/i);
      return true;
    });
  } finally {
    await agent.close();
    await close();
  }
});

test('the long-running dispatcher disables both timeouts', async () => {
  assert.equal(LONG_FETCH_AGENT_OPTS.headersTimeout, 0);
  assert.equal(LONG_FETCH_AGENT_OPTS.bodyTimeout, 0);

  for (const make of [headerStallServer, bodyStallServer]) {
    const { url, close } = await make(SHORT_STALL_MS);
    const agent = new Agent({ ...LONG_FETCH_AGENT_OPTS });
    try {
      const r = await jsonFetch<{ status: string }>(url, {
        timeoutMs: ABORT_MS,
        dispatcher: agent,
      });
      assert.equal(r.status, 'success');
    } finally {
      await agent.close();
      await close();
    }
  }
});

test('longRunning selects the shared long dispatcher; the default path stays undispatched', () => {
  assert.equal(resolveDispatcher({ longRunning: true }), longFetchDispatcher());
  assert.equal(resolveDispatcher({}), undefined);
  // An explicit dispatcher always wins over the flag.
  const explicit = new Agent();
  assert.equal(resolveDispatcher({ longRunning: true, dispatcher: explicit }), explicit);
  void explicit.close();
});

test('ollama long operations opt in', async () => {
  const { default: ollama } = await import('../adapters/ollama.js');
  const seen: Array<{ url: string; hasDispatcher: boolean }> = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input: any, init: any) => {
    seen.push({ url: String(input), hasDispatcher: Boolean(init?.dispatcher) });
    return new Response(JSON.stringify({ status: 'success', model: 'm', response: '', message: {} }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  };
  const ctx = {
    config: { baseUrl: 'http://127.0.0.1:11434' },
    dataDir: '/tmp',
    saveArtifact: async () => 'artifact',
    log: () => undefined,
  } as any;
  try {
    await ollama.invoke('pull_model', { model: 'm' }, ctx);
    await ollama.invoke('chat', { prompt: 'x' }, ctx);
    await ollama.invoke('generate', { prompt: 'x' }, ctx);
    await ollama.invoke('list_models', {}, ctx);
  } finally {
    globalThis.fetch = originalFetch;
  }
  assert.deepEqual(
    seen.map((s) => s.hasDispatcher),
    [true, true, true, false],
    'pull_model, chat and generate must opt out of undici timeouts; list_models need not'
  );
});
