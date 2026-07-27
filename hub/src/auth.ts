/**
 * Hub authentication and bind policy.
 *
 * Until Remote Node Management the hub was loopback-only and `auth` was a no-op.
 * Exposing `/mcp` beyond loopback publishes `system.run_command` to anything that
 * can reach the port, so the rule here is fail-closed: a non-loopback bind
 * without a token is a startup error, not a warning.
 *
 * The intended deployment is a private mesh (Tailscale/Headscale/NetBird), where
 * the overlay already encrypts and authenticates the link. The token is the
 * second factor that survives a compromised or misconfigured mesh peer.
 */
import { timingSafeEqual } from 'node:crypto';
import type { Request, Response, NextFunction, RequestHandler } from 'express';

/** Minimum token length we will accept. 32 chars of base64url ≈ 192 bits. */
export const MIN_TOKEN_LENGTH = 24;

const LOOPBACK_V4 = /^127\./;

/** Is this bind address reachable only from the machine itself? */
export function isLoopbackBind(bind: string): boolean {
  const b = (bind || '').trim().toLowerCase().replace(/^\[|\]$/g, '');
  if (!b) return false;
  return b === 'localhost' || b === '::1' || LOOPBACK_V4.test(b);
}

/**
 * Startup gate. Throws when the hub would be reachable off-box without a token,
 * or when a configured token is too weak to be worth having.
 */
export function assertBindPolicy(bind: string, token: string): void {
  const t = (token || '').trim();
  if (t && t.length < MIN_TOKEN_LENGTH)
    throw new Error(
      `authToken is ${t.length} characters; at least ${MIN_TOKEN_LENGTH} are required. ` +
        `Generate one with: node -e "console.log(require('crypto').randomBytes(32).toString('base64url'))"`
    );
  if (isLoopbackBind(bind)) return;
  if (!t)
    throw new Error(
      `refusing to start: bind is '${bind}' (not loopback) with no authToken set. ` +
        `Set 'authToken' in data/chinvat.config.json (or CHINVAT_AUTH_TOKEN), or set bind back to 127.0.0.1. ` +
        `An untokened non-loopback hub exposes system.run_command to the network.`
    );
}

/** Extract a bearer token from an Authorization header, or undefined. */
export function bearerFrom(header: string | undefined): string | undefined {
  if (!header) return undefined;
  const m = /^Bearer[ ]+(.+)$/i.exec(header.trim());
  return m ? m[1].trim() : undefined;
}

/** Constant-time comparison that does not leak length through early return. */
export function tokenMatches(expected: string, presented: string | undefined): boolean {
  if (!expected) return false;
  if (presented === undefined) return false;
  const a = Buffer.from(expected, 'utf8');
  const b = Buffer.from(presented, 'utf8');
  // timingSafeEqual requires equal lengths; compare a fixed-size digest-like pad
  // instead of returning early on a length mismatch.
  const len = Math.max(a.length, b.length);
  const pa = Buffer.alloc(len);
  const pb = Buffer.alloc(len);
  a.copy(pa);
  b.copy(pb);
  return timingSafeEqual(pa, pb) && a.length === b.length;
}

export interface AuthDeps {
  /** Current token (read per request so a dashboard config change takes effect). */
  token(): string;
  /** Current bind address. */
  bind(): string;
}

export type AuthVerdict =
  | { ok: true }
  | { ok: false; status: 401 | 500; error: string };

/**
 * One decision procedure for every transport. HTTP presents the token in an
 * Authorization header; browser WebSockets cannot set headers, so `/ws` passes
 * it as a query parameter instead. Both land here so the rules cannot drift.
 */
export function authorize(deps: AuthDeps, presented: string | undefined): AuthVerdict {
  const expected = (deps.token() || '').trim();
  if (!expected) {
    if (isLoopbackBind(deps.bind())) return { ok: true };
    return { ok: false, status: 500, error: 'hub misconfigured: non-loopback bind without authToken' };
  }
  if (tokenMatches(expected, presented)) return { ok: true };
  return { ok: false, status: 401, error: 'unauthorized' };
}

/** True when clients must present a token — drives the dashboard's login prompt. */
export function authRequired(deps: AuthDeps): boolean {
  return (deps.token() || '').trim() !== '';
}

/**
 * Express middleware. When a token is configured every request must present it.
 * When none is configured the hub must be loopback-bound, and requests pass —
 * this preserves the existing zero-config local experience.
 */
export function makeAuth(deps: AuthDeps): RequestHandler {
  return function auth(req: Request, res: Response, next: NextFunction): void {
    const verdict = authorize(deps, bearerFrom(req.headers.authorization));
    if (verdict.ok) return next();
    if (verdict.status === 401) res.setHeader('WWW-Authenticate', 'Bearer realm="chinvat"');
    res.status(verdict.status).json({ error: verdict.error });
  };
}

/**
 * Token for a WebSocket upgrade. Browsers cannot set an Authorization header on
 * `new WebSocket(...)`, so `/ws?token=…` is the only workable channel; a header
 * is still accepted for non-browser clients and takes precedence.
 */
export function wsTokenFrom(url: string | undefined, authorization: string | undefined): string | undefined {
  const header = bearerFrom(authorization);
  if (header) return header;
  if (!url) return undefined;
  try {
    const q = new URL(url, 'http://placeholder.invalid').searchParams.get('token');
    return q ?? undefined;
  } catch {
    return undefined;
  }
}
