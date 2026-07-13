/**
 * local-app-bridge.ts — shared loopback TCP/JSON client for local application
 * bridges (Blender add-on, GIMP plug-in, Rhino plugin).
 *
 * Wire contract (matches ahujasid/blender-mcp add-on, MIT):
 *   request:  one JSON object  { "type": string, "params": object }
 *   response: one JSON object  { "status": "success"|"error", "result"?: any, "message"?: string }
 * No length prefix and no newline framing — the peer writes a single JSON
 * document and the reader accumulates until the buffer parses.
 *
 * Design: connection-per-command, single in-flight command per bridge
 * (app-side servers execute on the app main thread; concurrency interleaves
 * badly). Cancellation = abort the wait and destroy the socket; a command
 * already running inside the app completes anyway — callers must treat
 * cancel as "abandon result", not "stop work".
 */
import net from 'node:net';
import { AdapterError } from '../types.js';

export interface BridgeOptions {
  host: string;
  port: number;
  /** Default per-command timeout; ops may override per call. */
  timeoutMs?: number;
  /** Hard cap on accumulated response bytes (base64 images can be large). */
  maxResponseBytes?: number;
}

export interface BridgeCommand {
  /** Command name for {type, params} dialects (blender-mcp, most gimp-mcp ops). */
  type?: string;
  params?: Record<string, unknown>;
  /** Escape hatch: send this object verbatim instead (e.g. gimp-mcp's {"cmds": [...]}). */
  raw?: Record<string, unknown>;
}

export interface SendOptions {
  timeoutMs?: number;
  signal?: AbortSignal;
}

const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_MAX_RESPONSE = 64 * 1024 * 1024; // 64 MiB
/** Outbound request cap — commands are small; anything bigger is a caller bug
 *  and would monopolize the serialized queue (Grok gimp-review fix #2). */
const MAX_REQUEST_BYTES = 1024 * 1024; // 1 MiB

/** Loopback only — a remote host would turn app scripting into network RCE and
 *  break shared-filesystem assumptions (e.g. screenshot temp paths). */
const LOOPBACK = new Set(['127.0.0.1', 'localhost', '::1']);

/** One shared instance per host:port so the serialization queue actually
 *  serializes across concurrent hub jobs (per Grok review fix #1). */
const instances = new Map<string, LocalAppBridge>();

export class LocalAppBridge {
  /** Serializes commands AND pings: each awaits the previous one. */
  private queue: Promise<unknown> = Promise.resolve();

  constructor(private readonly opts: BridgeOptions) {
    if (!Number.isInteger(opts.port) || opts.port < 1 || opts.port > 65535) {
      throw new AdapterError(`invalid bridge port: ${opts.port}`);
    }
    if (!LOOPBACK.has(opts.host)) {
      throw new AdapterError(`bridge host must be loopback (127.0.0.1/localhost/::1), got '${opts.host}'`);
    }
  }

  /** Shared, queue-preserving instance for an endpoint. */
  static for(host: string, port: number, extra?: Omit<BridgeOptions, 'host' | 'port'>): LocalAppBridge {
    const key = `${host}:${port}`;
    let b = instances.get(key);
    if (!b) {
      b = new LocalAppBridge({ host, port, ...extra });
      instances.set(key, b);
    }
    return b;
  }

  /** TCP connect probe, serialized behind in-flight commands. */
  ping(timeoutMs = 3_000): Promise<boolean> {
    const run = () => this.pingNow(timeoutMs);
    const next = this.queue.then(run, run);
    this.queue = next.catch(() => undefined);
    return next;
  }

  private pingNow(timeoutMs: number): Promise<boolean> {
    return new Promise((resolve) => {
      const sock = net.connect({ host: this.opts.host, port: this.opts.port });
      const done = (ok: boolean) => {
        sock.destroy();
        resolve(ok);
      };
      sock.setTimeout(timeoutMs, () => done(false));
      sock.once('connect', () => done(true));
      sock.once('error', () => done(false));
    });
  }

  /** Send one command; resolves with the parsed `result` payload or throws AdapterError. */
  send(cmd: BridgeCommand, options: SendOptions = {}): Promise<unknown> {
    const run = () => this.sendNow(cmd, options);
    // Chain regardless of predecessor outcome; never let a rejection poison the queue.
    const next = this.queue.then(run, run);
    this.queue = next.catch(() => undefined);
    return next;
  }

  private sendNow(cmd: BridgeCommand, options: SendOptions): Promise<unknown> {
    const timeoutMs = options.timeoutMs ?? this.opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    const maxBytes = this.opts.maxResponseBytes ?? DEFAULT_MAX_RESPONSE;
    const { signal } = options;

    return new Promise((resolve, reject) => {
      if (signal?.aborted) return reject(new AdapterError('cancelled before send'));

      const sock = net.connect({ host: this.opts.host, port: this.opts.port });
      const chunks: Buffer[] = [];
      let total = 0;
      let settled = false;

      const cleanup = () => {
        settled = true;
        clearTimeout(timer);
        signal?.removeEventListener('abort', onAbort);
        sock.destroy();
      };
      const fail = (msg: string, retriable = false) => {
        if (settled) return;
        cleanup();
        reject(new AdapterError(msg, retriable));
      };
      const succeed = (value: unknown) => {
        if (settled) return;
        cleanup();
        resolve(value);
      };

      const timer = setTimeout(
        () => fail(`bridge command '${cmd.type}' timed out after ${timeoutMs}ms`, true),
        timeoutMs
      );
      const onAbort = () => fail(`bridge command '${cmd.type}' cancelled`);
      signal?.addEventListener('abort', onAbort, { once: true });

      sock.once('error', (e: NodeJS.ErrnoException) =>
        fail(
          e.code === 'ECONNREFUSED'
            ? `bridge not reachable on ${this.opts.host}:${this.opts.port} — is the app open with its Chinvat bridge enabled?`
            : `bridge socket error: ${e.message}`,
          true
        )
      );

      sock.once('connect', () => {
        const payload = cmd.raw ?? { type: cmd.type, params: cmd.params ?? {} };
        if (!cmd.raw && !cmd.type) return fail('BridgeCommand needs type or raw');
        const body = JSON.stringify(payload);
        if (Buffer.byteLength(body, 'utf8') > MAX_REQUEST_BYTES)
          return fail(`bridge request exceeds ${MAX_REQUEST_BYTES} bytes`);
        sock.write(body);
      });

      sock.on('data', (chunk: Buffer) => {
        total += chunk.length;
        if (total > maxBytes) return fail(`bridge response exceeded ${maxBytes} bytes`);
        chunks.push(chunk);
        // Cheap completeness heuristic before the expensive concat+decode+parse:
        // a JSON object response ends with '}' (the add-on json.dumps output has no
        // trailing whitespace). Avoids O(n^2) work on many-chunk large responses
        // (per Grok review fix #2); a response that never ends with '}' is caught
        // by the timeout.
        if (chunk[chunk.length - 1] !== 0x7d /* '}' */) return;
        const text = Buffer.concat(chunks).toString('utf8');
        let parsed: unknown;
        try {
          parsed = JSON.parse(text);
        } catch {
          return; // not complete yet
        }
        // Dialect tolerance: blender-mcp uses result/message, gimp-mcp uses results/error.
        const res = parsed as { status?: string; result?: unknown; results?: unknown; message?: unknown; error?: unknown };
        if (res.status === 'success') return succeed(res.result ?? res.results ?? {});
        if (res.status === 'error') {
          const msg = [res.message, res.error].find((m) => typeof m === 'string') as string | undefined;
          return fail(`bridge error: ${msg ?? text.slice(0, 500)}`);
        }
        fail(`bridge returned malformed response: ${text.slice(0, 200)}`);
      });

      sock.once('close', () => {
        if (!settled) fail('bridge closed connection before a complete response', true);
      });
    });
  }
}
