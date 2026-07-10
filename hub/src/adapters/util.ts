import { AdapterError } from '../types.js';

export function msg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
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
}

/** fetch that throws AdapterError with status + body excerpt, JSON-parses response. */
export async function jsonFetch<T = any>(url: string, opts: FetchOpts = {}): Promise<T> {
  const { timeoutMs = 60_000, signal, ...rest } = opts;
  const timeout = AbortSignal.timeout(timeoutMs);
  const combined = signal ? AbortSignal.any([signal, timeout]) : timeout;
  let res: Response;
  try {
    res = await fetch(url, { ...rest, signal: combined });
  } catch (e) {
    throw new AdapterError(`request to ${new URL(url).host} failed: ${msg(e)}`, true);
  }
  const text = await res.text();
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
