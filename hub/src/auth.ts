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

/**
 * Express middleware. When a token is configured every request must present it.
 * When none is configured the hub must be loopback-bound, and requests pass —
 * this preserves the existing zero-config local experience.
 */
export function makeAuth(deps: AuthDeps): RequestHandler {
  return function auth(req: Request, res: Response, next: NextFunction): void {
    const expected = (deps.token() || '').trim();
    if (!expected) {
      if (isLoopbackBind(deps.bind())) return next();
      res.status(500).json({ error: 'hub misconfigured: non-loopback bind without authToken' });
      return;
    }
    if (tokenMatches(expected, bearerFrom(req.headers.authorization))) return next();
    res.setHeader('WWW-Authenticate', 'Bearer realm="chinvat"');
    res.status(401).json({ error: 'unauthorized' });
  };
}
