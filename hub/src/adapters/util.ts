import { Agent, fetch as undiciFetch, type Dispatcher } from 'undici';
import { AdapterError } from '../types.js';

export function msg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/**
 * `fetch` rejections are almost always the useless `TypeError: fetch failed`;
 * the diagnosis lives in `cause`. Flatten the chain so adapter errors name the
 * real fault (e.g. `UND_ERR_HEADERS_TIMEOUT`, `ECONNREFUSED`).
 */
export function causeChain(e: unknown, depth = 4): string {
  const parts: string[] = [];
  let cur: unknown = e;
  for (let i = 0; i < depth && cur != null; i++) {
    const text = msg(cur);
    const code = (cur as { code?: unknown }).code;
    parts.push(typeof code === 'string' && !text.includes(code) ? `${text} (${code})` : text);
    const next = (cur as { cause?: unknown }).cause;
    if (next === cur) break;
    cur = next;
  }
  return parts.join(' <- ');
}

/**
 * undici (the HTTP client behind Node's `fetch`) enforces its own
 * `headersTimeout` and `bodyTimeout`, both 300 s by default. Neither is
 * governed by the `AbortSignal` an adapter passes, so a job with
 * `timeoutMs: 3_600_000` still dies at ~305 s — observed twice on node `bld`
 * against `ollama /api/pull`, which sends nothing at all until the download
 * finishes. Long operations must opt out. See TASK-CHINVAT-017.
 */
export const LONG_FETCH_AGENT_OPTS = {
  headersTimeout: 0,
  bodyTimeout: 0,
} as const satisfies Agent.Options;

let longAgent: Agent | undefined;

/** Shared, lazily created dispatcher with undici's own timeouts disabled. */
export function longFetchDispatcher(): Dispatcher {
  longAgent ??= new Agent({ ...LONG_FETCH_AGENT_OPTS });
  return longAgent;
}

/** Explicit dispatcher wins (test seam); otherwise `longRunning` selects the shared agent. */
export function resolveDispatcher(opts: FetchOpts): Dispatcher | undefined {
  if (opts.dispatcher) return opts.dispatcher;
  return opts.longRunning ? longFetchDispatcher() : undefined;
}

/**
 * Measured, not assumed: Node's global `fetch` **silently ignores** a
 * `dispatcher` from the standalone `undici` package — a request with a 60 ms
 * `headersTimeout` agent still completed a 400 ms stall. Only undici's own
 * `fetch` honours it, so the dispatcher path must not go through the global.
 *
 * The global still wins whenever it has been replaced, because most adapter
 * tests assert on a stubbed `globalThis.fetch`; keeping that seam alive is
 * worth more than routing a unit test through undici.
 */
const nativeFetch = globalThis.fetch;

export function pickFetch(dispatcher: Dispatcher | undefined): typeof globalThis.fetch {
  if (globalThis.fetch !== nativeFetch) return globalThis.fetch;
  return dispatcher ? (undiciFetch as unknown as typeof globalThis.fetch) : nativeFetch;
}

export function cfgStr(
  config: Record<string, unknown>,
  key: string,
  fallback?: string
): string {
  const v = config[key];
  if (typeof v === 'string' && v.trim() !== '') return v.trim();
  if (fallback !== undefined) return fallback;
  throw new AdapterError(
    `missing config '${key}' — set it in the dashboard (Modules page) or via PUT /api/modules/<module>/config`
  );
}

export function requireConfig(config: Record<string, unknown>, keys: string[]): void {
  const missing = keys.filter((k) => {
    const v = config[k];
    return v === undefined || v === null || String(v).trim() === '';
  });
  if (missing.length)
    throw new AdapterError(
      `missing config: ${missing.join(', ')} — configure this module in the dashboard first`
    );
}

export interface FetchOpts extends Omit<RequestInit, 'signal'> {
  timeoutMs?: number;
  signal?: AbortSignal;
  /**
   * Disable undici's 300 s headers/body timeouts for this call. `timeoutMs`
   * (an AbortSignal) remains the only bound. Use for model pulls, non-streamed
   * generations, and anything else that can legitimately exceed five minutes.
   */
  longRunning?: boolean;
  /** Test seam: use this dispatcher instead of deriving one from `longRunning`. */
  dispatcher?: Dispatcher;
}

/** fetch that throws AdapterError with status + body excerpt, JSON-parses response. */
export async function jsonFetch<T = any>(url: string, opts: FetchOpts = {}): Promise<T> {
  const { timeoutMs = 60_000, signal, longRunning: _lr, dispatcher: _d, ...rest } = opts;
  const timeout = AbortSignal.timeout(timeoutMs);
  const combined = signal ? AbortSignal.any([signal, timeout]) : timeout;
  const dispatcher = resolveDispatcher(opts);
  let res: Response;
  try {
    res = await pickFetch(dispatcher)(url, {
      ...rest,
      signal: combined,
      ...(dispatcher ? { dispatcher } : {}),
    } as RequestInit);
  } catch (e) {
    throw new AdapterError(`request to ${new URL(url).host} failed: ${causeChain(e)}`, true);
  }
  let text: string;
  try {
    text = await res.text();
  } catch (e) {
    // A stalled or truncated body fails here, not at fetch(); same cause chain applies.
    throw new AdapterError(
      `response body from ${new URL(url).host} failed: ${causeChain(e)}`,
      true
    );
  }
  if (!res.ok) {
    throw new AdapterError(`HTTP ${res.status} from ${new URL(url).host}: ${text.slice(0, 600)}`);
  }
  if (!text) return null as T;
  try {
    return JSON.parse(text) as T;
  } catch {
    return text as unknown as T;
  }
}

export function unknownOp(module: string, op: string): never {
  throw new AdapterError(`module '${module}' has no operation '${op}' (use capabilities_describe)`);
}
