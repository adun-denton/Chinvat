#!/usr/bin/env node
/**
 * run-connection-modes.mjs
 * ---------------------------------------------------------------------------
 * Chinvat WP-00 / Track A — disposable measurement harness.
 *
 * Compares three ways of attaching automation to a Chrome/Chromium browser
 * window on Windows 11:
 *
 *   1. persistent-profile — chromium.launchPersistentContext() against a
 *      DEDICATED profile directory (never the operator's real Chrome profile).
 *   2. extension           — same launchPersistentContext(), but with a
 *      minimal MV3 extension loaded via --load-extension. The extension's
 *      background service worker relays a small command set to this harness
 *      over a hand-rolled WebSocket server, so we can compare what an
 *      extension-attached mode can observe versus a driver-attached one.
 *   3. cdp                 — Chrome is spawned directly with
 *      --remote-debugging-port and Playwright attaches via
 *      chromium.connectOverCDP(). Diagnostic only.
 *
 * This file is intentionally "plain": no abstraction layers beyond what's
 * needed to avoid copy-paste bugs across the three modes. Correctness of the
 * measurement matters far more than elegance here.
 *
 * DEPENDENCIES: only `playwright` (an npm package). Everything else is a
 * Node.js core module. See RUN-ON-WINDOWS.md for setup instructions.
 *
 * THIS IS SPIKE CODE. It is disposable. Do not build on top of it without
 * re-reading it first — see RUN-ON-WINDOWS.md.
 * ---------------------------------------------------------------------------
 */

import { chromium } from 'playwright';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import http from 'node:http';
import { EventEmitter } from 'node:events';
import { spawn, execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const require = createRequire(import.meta.url);

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

// Must match EXTENSION_WS_PORT expectations baked into extension/background.js.
// If this port is already taken on the operator's machine, the extension mode
// still runs its Playwright-driven measurements; only the extensionRelay
// section is recorded as unavailable (see runExtensionMode()).
const EXTENSION_WS_PORT = 8898;

// Chrome DevTools Protocol port used by mode 3 ("cdp"). Arbitrary but fixed
// so repeated runs behave the same way.
const CDP_PORT = 9223;

const PERSIST_COOKIE_NAME = 'chinvat_spike_probe';
const PERSIST_LS_KEY = 'chinvatSpikeProbe';

const KNOWN_MODES = ['persistent-profile', 'extension', 'cdp'];

// ---------------------------------------------------------------------------
// Small utilities
// ---------------------------------------------------------------------------

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function nowMs() {
  return Date.now();
}

/**
 * Safety guard: NEVER point launchPersistentContext / --user-data-dir at the
 * operator's real Chrome profile. Every profile directory this harness uses
 * MUST live under a "chinvat-spike" path segment. This is checked immediately
 * before every launch (not just once at startup) so a coding mistake later in
 * the file can't silently widen the blast radius.
 */
function assertSafeProfileDir(dir) {
  const normalized = path.resolve(dir).toLowerCase();
  if (!normalized.includes('chinvat-spike')) {
    throw new Error(
      'Refusing to use profile directory that does not contain "chinvat-spike": ' +
        dir +
        ' — this is a hard safety guard against ever touching a real Chrome profile.'
    );
  }
}

async function checkFixtureReachable(url) {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(3000) });
    // Any response at all (even a 404) means something is listening and
    // speaking HTTP; that's all we need to know here.
    return res.status >= 200 && res.status < 500;
  } catch {
    return false;
  }
}

async function waitForCdpEndpoint(url, timeoutMs) {
  const start = nowMs();
  let lastErr = null;
  while (nowMs() - start < timeoutMs) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(1000) });
      if (res.ok) return true;
    } catch (err) {
      lastErr = err;
    }
    await sleep(250);
  }
  throw new Error(
    'CDP endpoint did not become ready at ' + url + (lastErr ? ': ' + lastErr.message : '')
  );
}

/**
 * Windows-only best-effort process lookup by matching the running chrome.exe
 * command line against a substring (we use the profile directory path, which
 * is unique per mode/run). Playwright does not expose the underlying OS
 * process for launchPersistentContext() (BrowserContext#browser() returns
 * null for persistent contexts), so this is the only way to get a PID to
 * kill for the crashBehavior measurement on modes 1 and 2.
 *
 * Uses PowerShell + CIM (Get-CimInstance Win32_Process) rather than `wmic`,
 * because wmic is deprecated/absent on newer Windows 11 builds.
 */
async function findWindowsPidsByCommandLineSubstring(substring) {
  if (process.platform !== 'win32') {
    throw new Error('Windows-only PID lookup was attempted on platform: ' + process.platform);
  }
  const escaped = substring.replace(/'/g, "''");
  const psScript =
    `Get-CimInstance Win32_Process -Filter "Name='chrome.exe'" | ` +
    `Where-Object { $_.CommandLine -and $_.CommandLine.Contains('${escaped}') } | ` +
    `Select-Object -ExpandProperty ProcessId`;
  const out = execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', psScript], {
    encoding: 'utf8',
    windowsHide: true,
  });
  return out
    .split(/\r?\n/)
    .map((s) => s.trim())
    .filter(Boolean)
    .map(Number)
    .filter((n) => Number.isInteger(n));
}

async function killWindowsPid(pid) {
  execFileSync('taskkill', ['/F', '/PID', String(pid)], { windowsHide: true });
}

// ---------------------------------------------------------------------------
// Minimal hand-rolled WebSocket server (RFC 6455), used ONLY by the
// "extension" mode so the MV3 background service worker has something local
// to talk to without pulling in the `ws` npm package. We keep this tiny on
// purpose: single connection at a time, unfragmented text frames only, which
// is all our small JSON command/response messages ever need.
//
// WEBSOCKET-SPECIFIC NOTE: per RFC 6455, frames FROM a client (the browser
// extension) are always masked; frames we send back to the client must be
// UNMASKED. Getting either of those backwards silently breaks the browser's
// WebSocket implementation, which is a very confusing failure mode to debug —
// hence the extra comments below.
// ---------------------------------------------------------------------------

const WS_MAGIC = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';

function encodeServerFrame(payloadBuf, opcode = 0x1) {
  const len = payloadBuf.length;
  let header;
  if (len < 126) {
    header = Buffer.alloc(2);
    header[0] = 0x80 | opcode; // FIN=1, opcode
    header[1] = len; // MASK bit = 0: server->client frames must NOT be masked
  } else if (len < 65536) {
    header = Buffer.alloc(4);
    header[0] = 0x80 | opcode;
    header[1] = 126;
    header.writeUInt16BE(len, 2);
  } else {
    header = Buffer.alloc(10);
    header[0] = 0x80 | opcode;
    header[1] = 127;
    header.writeBigUInt64BE(BigInt(len), 2);
  }
  return Buffer.concat([header, payloadBuf]);
}

function makeFrameParser(onFrame) {
  let buffer = Buffer.alloc(0);
  return function feed(chunk) {
    buffer = Buffer.concat([buffer, chunk]);
    // Loop: a single TCP chunk may contain multiple, or partial, frames.
    for (;;) {
      if (buffer.length < 2) return;
      const byte0 = buffer[0];
      const byte1 = buffer[1];
      const fin = (byte0 & 0x80) !== 0;
      const opcode = byte0 & 0x0f;
      const masked = (byte1 & 0x80) !== 0; // always true for client->server frames
      let len = byte1 & 0x7f;
      let offset = 2;
      if (len === 126) {
        if (buffer.length < offset + 2) return;
        len = buffer.readUInt16BE(offset);
        offset += 2;
      } else if (len === 127) {
        if (buffer.length < offset + 8) return;
        len = Number(buffer.readBigUInt64BE(offset));
        offset += 8;
      }
      let maskKey = null;
      if (masked) {
        if (buffer.length < offset + 4) return;
        maskKey = buffer.subarray(offset, offset + 4);
        offset += 4;
      }
      if (buffer.length < offset + len) return; // wait for the rest to arrive
      let payload = buffer.subarray(offset, offset + len);
      if (masked) {
        const unmasked = Buffer.alloc(len);
        for (let i = 0; i < len; i++) unmasked[i] = payload[i] ^ maskKey[i % 4];
        payload = unmasked;
      } else {
        payload = Buffer.from(payload);
      }
      buffer = buffer.subarray(offset + len);
      onFrame({ fin, opcode, payload });
      // continue loop in case more frames are already buffered
    }
  };
}

class MiniWsServer extends EventEmitter {
  constructor(port) {
    super();
    this.port = port;
    this.socket = null;
    this.httpServer = http.createServer((_req, res) => {
      res.writeHead(404);
      res.end('mini-ws-server: upgrade-only endpoint');
    });
    this.httpServer.on('upgrade', (req, socket, head) => this._handleUpgrade(req, socket, head));
  }

  listen() {
    return new Promise((resolve, reject) => {
      const onError = (err) => reject(err);
      this.httpServer.once('error', onError);
      this.httpServer.listen(this.port, '127.0.0.1', () => {
        this.httpServer.removeListener('error', onError);
        resolve();
      });
    });
  }

  _handleUpgrade(req, socket, head) {
    const key = req.headers['sec-websocket-key'];
    if (!key) {
      socket.destroy();
      return;
    }
    const accept = crypto.createHash('sha1').update(key + WS_MAGIC).digest('base64');
    const responseHeaders = [
      'HTTP/1.1 101 Switching Protocols',
      'Upgrade: websocket',
      'Connection: Upgrade',
      `Sec-WebSocket-Accept: ${accept}`,
      '',
      '',
    ].join('\r\n');
    socket.write(responseHeaders);

    // Only one logical client at a time is expected (the extension's
    // background service worker). If a second connection shows up (e.g. the
    // service worker restarted and reconnected), it simply replaces the old
    // socket reference — good enough for measurement purposes.
    this.socket = socket;
    const feed = makeFrameParser((frame) => this._onFrame(frame));
    if (head && head.length) feed(head);
    socket.on('data', feed);
    socket.on('close', () => {
      if (this.socket === socket) this.socket = null;
      this.emit('disconnect');
    });
    socket.on('error', () => {
      /* swallow — a dropped relay connection is a recorded limitation, not a harness crash */
    });
    this.emit('connection');
  }

  _onFrame(frame) {
    if (frame.opcode === 0x1) {
      // text frame
      try {
        const msg = JSON.parse(frame.payload.toString('utf8'));
        this.emit('message', msg);
      } catch (err) {
        this.emit('parseerror', err);
      }
    } else if (frame.opcode === 0x8) {
      // close frame
      if (this.socket) {
        try {
          this.socket.end();
        } catch {
          /* ignore */
        }
      }
    } else if (frame.opcode === 0x9) {
      // ping -> pong
      if (this.socket) this.socket.write(encodeServerFrame(frame.payload, 0xa));
    }
    // 0x2 binary and 0xa pong (unsolicited) frames are not used by this protocol.
  }

  send(obj) {
    if (!this.socket) throw new Error('MiniWsServer: no client connected');
    const buf = Buffer.from(JSON.stringify(obj), 'utf8');
    this.socket.write(encodeServerFrame(buf, 0x1));
  }

  close() {
    return new Promise((resolve) => {
      if (this.socket) {
        try {
          this.socket.end();
        } catch {
          /* ignore */
        }
      }
      this.httpServer.close(() => resolve());
    });
  }
}

/**
 * Wraps a MiniWsServer with request/response correlation (JSON-RPC-ish: each
 * outgoing command carries an `id`; the extension echoes that `id` back in
 * its response so we can match replies to calls even if they arrive out of
 * order).
 */
function createRpcClient(wss) {
  let counter = 0;
  const pending = new Map();
  wss.on('message', (msg) => {
    if (msg && msg.id != null && pending.has(msg.id)) {
      const { resolve, reject } = pending.get(msg.id);
      pending.delete(msg.id);
      if (msg.ok) resolve(msg.result);
      else reject(new Error(msg.error || 'unknown extension-side error'));
    }
  });
  return function call(cmd, args = {}, timeoutMs = 5000) {
    return new Promise((resolve, reject) => {
      const id = ++counter;
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error('extension RPC timeout waiting for response to "' + cmd + '"'));
      }, timeoutMs);
      pending.set(id, {
        resolve: (v) => {
          clearTimeout(timer);
          resolve(v);
        },
        reject: (e) => {
          clearTimeout(timer);
          reject(e);
        },
      });
      try {
        wss.send({ id, cmd, args });
      } catch (err) {
        clearTimeout(timer);
        pending.delete(id);
        reject(err);
      }
    });
  };
}

function waitForWsConnection(wss, timeoutMs) {
  return new Promise((resolve, reject) => {
    if (wss.socket) {
      resolve();
      return;
    }
    const timer = setTimeout(() => {
      wss.removeListener('connection', onConn);
      reject(new Error('no extension connected to relay WebSocket within ' + timeoutMs + 'ms'));
    }, timeoutMs);
    function onConn() {
      clearTimeout(timer);
      resolve();
    }
    wss.once('connection', onConn);
  });
}

// ---------------------------------------------------------------------------
// Shared measurement helpers (used by all three modes)
// ---------------------------------------------------------------------------

async function setPersistenceMarkers(page, context, fixtureUrl) {
  const value = 'v-' + Date.now() + '-' + Math.floor(Math.random() * 1e6);
  await context.addCookies([{ name: PERSIST_COOKIE_NAME, value, url: fixtureUrl }]);
  await page.evaluate(
    ({ key, val }) => {
      window.localStorage.setItem(key, val);
    },
    { key: PERSIST_LS_KEY, val: value }
  );
  return value;
}

async function checkPersistenceMarkers(page, context, fixtureUrl, expectedValue) {
  const cookies = await context.cookies(fixtureUrl);
  const cookie = cookies.find((c) => c.name === PERSIST_COOKIE_NAME);
  const lsValue = await page
    .evaluate((key) => window.localStorage.getItem(key), PERSIST_LS_KEY)
    .catch(() => null);
  return {
    cookie: !!cookie && cookie.value === expectedValue,
    localStorage: lsValue === expectedValue,
    expectedValue,
    cookieValueFound: cookie ? cookie.value : null,
    localStorageValueFound: lsValue,
  };
}

/**
 * observation: checks five things the fixture is specifically designed to
 * probe. See fixture/public/app.js and fixture/public/index.html:
 *  - main document text is plain DOM.
 *  - the campaign grid (#grid-rows) is VIRTUALIZED: only currently-scrolled
 *    rows exist in the DOM at any time, so "row count" here means
 *    currently-rendered rows, not the full 500-row dataset.
 *  - <account-switcher> uses an OPEN shadow root (attachShadow({mode:'open'})).
 *  - <budget-editor> uses a CLOSED shadow root (attachShadow({mode:'closed'})).
 *    A closed root's `.shadowRoot` property is `null` from any outside script
 *    context (that's the whole point of "closed") — this is expected to read
 *    as NOT observable in every mode here. If it ever reads as observable,
 *    that's a bug in this harness (or a browser behavior change), not a
 *    genuine capability difference between modes — so we flag it loudly.
 *  - #notif-frame is a same-origin iframe (/frame.html) with its own
 *    document; Playwright's page.frames() can reach into it directly because
 *    it's same-origin (no cross-origin isolation to defeat here).
 */
async function measureObservation(page, limitations) {
  const obs = {};

  try {
    const text = await page.evaluate(() => (document.body ? document.body.innerText : ''));
    obs.mainDocumentText = {
      observable: !!text && text.trim().length > 0,
      mechanism: 'page.evaluate(() => document.body.innerText)',
      sample: (text || '').slice(0, 80),
    };
  } catch (err) {
    obs.mainDocumentText = { observable: false, mechanism: 'page.evaluate', error: String(err) };
  }

  try {
    const count = await page.evaluate(
      () => document.querySelectorAll('#grid-rows [data-entity-id]').length
    );
    obs.virtualizedGridRowCount = {
      observable: count > 0,
      mechanism: "page.evaluate(() => document.querySelectorAll('#grid-rows [data-entity-id]').length)",
      count,
      note: 'grid is virtualized: this is the currently-rendered row count, not the full 500-row dataset',
    };
  } catch (err) {
    obs.virtualizedGridRowCount = { observable: false, error: String(err) };
  }

  try {
    const openShadowText = await page.evaluate(() => {
      const el = document.querySelector('account-switcher');
      if (!el || !el.shadowRoot) return null;
      return el.shadowRoot.textContent || '';
    });
    obs.openShadowRoot = {
      observable: !!openShadowText && openShadowText.trim().length > 0,
      mechanism: "page.evaluate(() => document.querySelector('account-switcher').shadowRoot.textContent)",
      sample: (openShadowText || '').slice(0, 80),
    };
  } catch (err) {
    obs.openShadowRoot = { observable: false, error: String(err) };
  }

  try {
    const closedInfo = await page.evaluate(() => {
      const el = document.querySelector('budget-editor');
      return { present: !!el, hasShadowRoot: !!(el && el.shadowRoot) };
    });
    obs.closedShadowRoot = {
      observable: !!closedInfo.hasShadowRoot,
      elementPresent: !!closedInfo.present,
      mechanism:
        "page.evaluate(() => !!document.querySelector('budget-editor').shadowRoot) — expected false for a CLOSED shadow root",
    };
    if (closedInfo.hasShadowRoot) {
      const msg =
        'ASSERTION FAILURE: closed shadow root on <budget-editor> was observable via ' +
        'element.shadowRoot. This should be impossible for a closed root and indicates a ' +
        'bug in this measurement or an unexpected browser/environment change — it is NOT a ' +
        'real capability difference between connection modes.';
      obs.closedShadowRoot.unexpectedBug = true;
      console.error('\n*** ' + msg + ' ***\n');
      limitations.push(msg);
    }
  } catch (err) {
    obs.closedShadowRoot = { observable: false, error: String(err) };
  }

  try {
    const frame = page.frames().find((f) => f.url().includes('/frame.html'));
    if (frame) {
      const listText = await frame.evaluate(() => {
        const list = document.getElementById('notif-list');
        return list ? list.textContent || '' : '';
      });
      obs.iframeContent = {
        observable: !!listText && listText.trim().length > 0,
        mechanism: 'Playwright page.frames() lookup + frame.evaluate() (same-origin iframe, no isolation to defeat)',
        sample: listText.slice(0, 80),
      };
    } else {
      obs.iframeContent = {
        observable: false,
        mechanism: 'page.frames() lookup',
        error: 'iframe frame object not found (notif-frame did not attach in time?)',
      };
      limitations.push('iframe frame object was not found via page.frames() during observation check');
    }
  } catch (err) {
    obs.iframeContent = { observable: false, error: String(err) };
  }

  return obs;
}

/**
 * A short, deterministic interaction sequence designed to generate at least
 * one instance of each event type (console, request, response, framenavigated,
 * dialog) within the fixed measurement window used by measureEventCoverage().
 */
async function scriptedInteraction(page) {
  try {
    // 1) Network activity: scroll the virtualized grid far enough to force
    //    the fixture's client-side pager to fetch a new /api/campaigns page.
    await page.evaluate(() => {
      const vp = document.getElementById('grid-viewport');
      if (vp) vp.scrollTop = 40 * 120; // ~120 rows down
    });
    await sleep(500);
    await page.evaluate(() => {
      const vp = document.getElementById('grid-viewport');
      if (vp) vp.scrollTop = 0;
    });
    await sleep(500);

    // 2) Console event.
    await page.evaluate(() => console.log('[track-a] event-coverage probe'));

    // 3) framenavigated: force the same-origin iframe to reload.
    await page.evaluate(() => {
      const f = document.getElementById('notif-frame');
      if (f) {
        const src = f.getAttribute('src');
        f.src = 'about:blank';
        setTimeout(() => {
          f.src = src;
        }, 100);
      }
    });
    await sleep(800);

    // 4) Dialog event. Scheduled via setTimeout so this evaluate() call
    //    returns immediately instead of blocking on the alert() itself; the
    //    page.on('dialog', ...) handler registered by the caller accepts it.
    await page.evaluate(() => {
      setTimeout(() => {
        try {
          alert('[track-a] coverage probe');
        } catch {
          /* ignore */
        }
      }, 100);
    });
    await sleep(800);

    // 5) Extra DOM churn / requests via the fixture's own test hook.
    await page.evaluate(() => {
      if (window.__fixture) window.__fixture.forceRerender();
    });
  } catch {
    // Non-fatal: whatever counts were captured before a failure here still stand.
  }
}

async function measureEventCoverage(page, _context, durationMs) {
  const counts = { console: 0, request: 0, response: 0, framenavigated: 0, dialog: 0 };
  const onConsole = () => counts.console++;
  const onRequest = () => counts.request++;
  const onResponse = () => counts.response++;
  const onFrameNavigated = () => counts.framenavigated++;
  const onDialog = async (dialog) => {
    counts.dialog++;
    try {
      await dialog.accept();
    } catch {
      /* ignore */
    }
  };

  page.on('console', onConsole);
  page.on('request', onRequest);
  page.on('response', onResponse);
  page.on('framenavigated', onFrameNavigated);
  page.on('dialog', onDialog);

  const interactionPromise = scriptedInteraction(page);
  await sleep(durationMs);

  page.off('console', onConsole);
  page.off('request', onRequest);
  page.off('response', onResponse);
  page.off('framenavigated', onFrameNavigated);
  page.off('dialog', onDialog);

  await interactionPromise.catch(() => {});

  return counts;
}

/**
 * Semi-automated: prompts the human operator to interact with the visible
 * browser window for 15 seconds, then checks whether window.__fixture.renderCount
 * advanced and whether automation can resume issuing commands afterward.
 *
 * CAVEAT (documented in the results too): the fixture's renderCount also
 * increments on its own via periodic timers (renderLiveMetrics() every
 * 800ms, scheduleRenderGrid() every 5s) regardless of human interaction. So
 * `renderCountAdvanced: true` is a WEAK signal — it will almost always be
 * true even if the operator does nothing. It's included because the task
 * spec asks for it; humanNotes is the actual ground truth for this check.
 */
async function measureTakeoverErgonomics(page) {
  const before = await page
    .evaluate(() => (window.__fixture ? window.__fixture.renderCount : null))
    .catch(() => null);

  console.log(
    '\n>>> TAKEOVER WINDOW (15s): please click around the visible fixture browser window now — ' +
      'scroll the campaign grid, open the account switcher, or edit a budget value. ' +
      'Do not close the browser window. <<<\n'
  );
  await sleep(15000);

  let after = null;
  let resumeError = null;
  try {
    after = await page.evaluate(() => (window.__fixture ? window.__fixture.renderCount : null));
  } catch (err) {
    resumeError = String((err && err.message) || err);
  }

  let automationResumedWithoutError = false;
  if (resumeError === null) {
    try {
      await page.evaluate(() => document.title);
      automationResumedWithoutError = true;
    } catch (err) {
      automationResumedWithoutError = false;
      resumeError = String((err && err.message) || err);
    }
  }

  return {
    renderCountBefore: before,
    renderCountAfter: after,
    renderCountAdvanced:
      typeof before === 'number' && typeof after === 'number' ? after > before : null,
    renderCountCaveat:
      'renderCount also increments via periodic fixture timers independent of human ' +
      'interaction; treat renderCountAdvanced as a weak signal only. See humanNotes for ground truth.',
    automationResumedWithoutError,
    resumeError,
    humanNotes: '', // operator: fill this in by hand in the written results JSON
  };
}

/**
 * Kills the browser process mid-operation via killFn(session), then records
 * the exact error surfaced to Playwright, then attempts to recover by
 * relaunching via relaunch(). The recovered session (if any) is stashed on
 * the returned object as `_recovered` so the caller can continue using it
 * (and is responsible for eventually closing it); the caller must delete
 * that key before persisting results to JSON.
 */
async function measureCrashBehavior(session, relaunch, killFn) {
  const result = { killed: false, killError: null, errorSurfaced: null, recovered: false, recoverError: null };

  try {
    await killFn(session);
    result.killed = true;
  } catch (err) {
    result.killError = String((err && err.message) || err);
    return result;
  }

  // Give the OS a brief moment for the kill/disconnect to propagate.
  await sleep(500);

  try {
    // Expected to throw/reject, since the underlying browser process is gone.
    await session.page.evaluate(() => document.title);
    result.unexpectedNoError = true; // no error means the kill likely didn't take effect
  } catch (err) {
    result.errorSurfaced = String((err && err.message) || err);
  }

  try {
    const recovered = await relaunch();
    result.recovered = true;
    result._recovered = recovered;
  } catch (err) {
    result.recovered = false;
    result.recoverError = String((err && err.message) || err);
  }

  return result;
}

// ---------------------------------------------------------------------------
// Mode 1: persistent-profile
// ---------------------------------------------------------------------------

async function runPersistentProfileMode({ fixtureUrl, profileDir }) {
  assertSafeProfileDir(profileDir);
  const result = { status: 'ok', limitations: [] };
  let session = null;

  const launch = async () => {
    assertSafeProfileDir(profileDir);
    const t0 = nowMs();
    // headless:false + channel:'chromium' per spec: a real, visible window
    // using Playwright's bundled Chromium build (not the operator's system
    // Chrome), against a dedicated profile directory.
    const context = await chromium.launchPersistentContext(profileDir, {
      headless: false,
      channel: 'chromium',
      viewport: null, // let the window use its natural OS size (useful for the human takeover step)
    });
    let page = context.pages()[0];
    if (!page) page = await context.newPage();
    await page.goto(fixtureUrl, { waitUntil: 'load' });
    await page.waitForFunction(() => !!window.__fixture, null, { timeout: 15000 }).catch(() => {});
    const launchMs = nowMs() - t0;
    return { context, page, launchMs };
  };

  const closeSession = async (s) => {
    if (s && s.context) await s.context.close().catch(() => {});
  };

  try {
    session = await launch();
    result.launchMs = session.launchMs;

    result.observation = await measureObservation(session.page, result.limitations);
    result.eventCoverage = await measureEventCoverage(session.page, session.context, 10000);

    const expected = await setPersistenceMarkers(session.page, session.context, fixtureUrl);
    await closeSession(session);
    session = await launch();
    result.sessionPersistence = await checkPersistenceMarkers(session.page, session.context, fixtureUrl, expected);

    result.takeoverErgonomics = await measureTakeoverErgonomics(session.page);

    const killFn = async () => {
      const pids = await findWindowsPidsByCommandLineSubstring(profileDir);
      if (pids.length === 0) {
        throw new Error('no chrome.exe process found matching profile dir (Windows PID lookup): ' + profileDir);
      }
      for (const pid of pids) await killWindowsPid(pid);
    };
    result.crashBehavior = await measureCrashBehavior(session, launch, killFn);
    if (result.crashBehavior.killError) result.limitations.push('crashBehavior: ' + result.crashBehavior.killError);
    if (result.crashBehavior._recovered) {
      session = result.crashBehavior._recovered;
      delete result.crashBehavior._recovered;
    } else {
      session = null;
      delete result.crashBehavior._recovered;
    }
  } catch (err) {
    result.status = 'failed';
    result.error = String((err && err.stack) || err);
  } finally {
    await closeSession(session);
  }
  return result;
}

// ---------------------------------------------------------------------------
// Mode 2: extension
// ---------------------------------------------------------------------------

async function measureExtensionRelay(wss, limitations) {
  const rpc = createRpcClient(wss);
  const out = { connected: false, capabilities: {}, limitations: [] };

  try {
    await waitForWsConnection(wss, 10000);
    out.connected = true;
  } catch (err) {
    out.connected = false;
    out.error = String((err && err.message) || err);
    limitations.push('extension relay never connected: ' + out.error);
    return out;
  }

  try {
    const t0 = Date.now();
    await rpc('ping', { ts: t0 });
    out.capabilities.pingPongLatencyMs = Date.now() - t0;
  } catch (err) {
    out.capabilities.pingPongLatencyMs = null;
    out.limitations.push('ping failed: ' + String((err && err.message) || err));
  }

  try {
    out.capabilities.tabInfo = await rpc('getTabInfo', {});
  } catch (err) {
    out.capabilities.tabInfo = null;
    out.limitations.push('getTabInfo failed: ' + String((err && err.message) || err));
  }

  try {
    const rs = await rpc('getReadyState', {});
    out.capabilities.readyState = rs.readyState;
  } catch (err) {
    out.capabilities.readyState = null;
    out.limitations.push('getReadyState failed: ' + String((err && err.message) || err));
  }

  try {
    const list = await rpc('listTabs', {});
    out.capabilities.tabCount = list.tabs.length;
  } catch (err) {
    out.capabilities.tabCount = null;
    out.limitations.push('listTabs failed: ' + String((err && err.message) || err));
  }

  // Known-by-design limitations: the manifest intentionally only requests
  // tabs / scripting / activeTab / host permission for the fixture origin.
  // No debugger, webRequest, webNavigation, or alarms permission was added
  // to make these possible, per the task's explicit instruction not to
  // silently expand permissions to "solve" a capability gap.
  out.limitations.push(
    'extension cannot observe console/request/response/dialog events (no debugger or webRequest permission granted, by design)'
  );
  out.limitations.push(
    'extension cannot read closed shadow DOM content — same restriction as any other script context, not extension-specific'
  );
  out.limitations.push(
    'MV3 background service worker can be terminated by Chrome after ~30s idle; no "alarms" permission was requested to keep it alive, so the relay connection may need to reconnect between calls (reconnect logic is in background.js)'
  );
  out.limitations.push(
    '"activeTab" permission is granted but effectively inert here: it only grants temporary access after a user gesture on a browser action, and this extension has no action/popup UI'
  );

  return out;
}

async function runExtensionMode({ fixtureUrl, profileDir, extensionDir }) {
  assertSafeProfileDir(profileDir);
  const result = { status: 'ok', limitations: [] };
  let session = null;
  let wss = null;

  const launch = async () => {
    assertSafeProfileDir(profileDir);
    const t0 = nowMs();
    const context = await chromium.launchPersistentContext(profileDir, {
      headless: false,
      channel: 'chromium',
      viewport: null,
      args: [
        // Windows/Chrome-specific: these two flags together restrict the
        // browser to loading ONLY our unpacked extension (no other
        // extensions from this profile get loaded), which keeps the
        // measurement environment predictable across relaunches.
        `--disable-extensions-except=${extensionDir}`,
        `--load-extension=${extensionDir}`,
      ],
    });
    let page = context.pages()[0];
    if (!page) page = await context.newPage();
    await page.goto(fixtureUrl, { waitUntil: 'load' });
    await page.waitForFunction(() => !!window.__fixture, null, { timeout: 15000 }).catch(() => {});
    const launchMs = nowMs() - t0;
    return { context, page, launchMs };
  };

  const closeSession = async (s) => {
    if (s && s.context) await s.context.close().catch(() => {});
  };

  try {
    wss = new MiniWsServer(EXTENSION_WS_PORT);
    try {
      await wss.listen();
    } catch (err) {
      result.limitations.push(
        'extension relay WebSocket server failed to bind on 127.0.0.1:' +
          EXTENSION_WS_PORT +
          ': ' +
          String((err && err.message) || err) +
          ' — extensionRelay metrics will be unavailable for this run'
      );
      wss = null;
    }

    session = await launch();
    result.launchMs = session.launchMs;

    result.observation = await measureObservation(session.page, result.limitations);
    result.eventCoverage = await measureEventCoverage(session.page, session.context, 10000);

    const expected = await setPersistenceMarkers(session.page, session.context, fixtureUrl);
    await closeSession(session);
    session = await launch();
    result.sessionPersistence = await checkPersistenceMarkers(session.page, session.context, fixtureUrl, expected);

    // Extension-only relay measurement — compared against the Playwright
    // (driver-attached) measurements above to see what an extension can and
    // cannot observe about the same browser instance.
    if (wss) {
      result.extensionRelay = await measureExtensionRelay(wss, result.limitations);
    } else {
      result.extensionRelay = { connected: false, error: 'relay server not started (port bind failure)' };
    }

    result.takeoverErgonomics = await measureTakeoverErgonomics(session.page);

    const killFn = async () => {
      const pids = await findWindowsPidsByCommandLineSubstring(profileDir);
      if (pids.length === 0) {
        throw new Error('no chrome.exe process found matching profile dir (Windows PID lookup): ' + profileDir);
      }
      for (const pid of pids) await killWindowsPid(pid);
    };
    result.crashBehavior = await measureCrashBehavior(session, launch, killFn);
    if (result.crashBehavior.killError) result.limitations.push('crashBehavior: ' + result.crashBehavior.killError);
    if (result.crashBehavior._recovered) {
      session = result.crashBehavior._recovered;
      delete result.crashBehavior._recovered;
    } else {
      session = null;
      delete result.crashBehavior._recovered;
    }
  } catch (err) {
    result.status = 'failed';
    result.error = String((err && err.stack) || err);
  } finally {
    await closeSession(session);
    if (wss) await wss.close().catch(() => {});
  }
  return result;
}

// ---------------------------------------------------------------------------
// Mode 3: cdp (diagnostic only)
// ---------------------------------------------------------------------------

async function runCdpMode({ fixtureUrl, profileDir }) {
  assertSafeProfileDir(profileDir);
  const result = { status: 'ok', limitations: [], diagnosticOnly: true };
  let session = null; // { browser, context, page, launchMs, child }

  const launch = async () => {
    assertSafeProfileDir(profileDir);
    fs.mkdirSync(profileDir, { recursive: true });
    const t0 = nowMs();
    // We spawn Chrome ourselves (rather than via Playwright's launch APIs) so
    // we hold a direct child-process handle — this is what makes the
    // crashBehavior kill step reliable for this mode (unlike modes 1/2,
    // where Playwright hides the OS process from us for persistent contexts).
    const executablePath = chromium.executablePath();
    const child = spawn(
      executablePath,
      [
        `--remote-debugging-port=${CDP_PORT}`,
        '--remote-debugging-address=127.0.0.1',
        `--user-data-dir=${profileDir}`,
        '--no-first-run',
        '--no-default-browser-check',
        'about:blank',
      ],
      { stdio: 'ignore' }
    );

    await waitForCdpEndpoint(`http://127.0.0.1:${CDP_PORT}/json/version`, 15000);

    const browser = await chromium.connectOverCDP(`http://127.0.0.1:${CDP_PORT}`);
    let context = browser.contexts()[0];
    if (!context) context = await browser.newContext();
    let page = context.pages()[0];
    if (!page) page = await context.newPage();
    await page.goto(fixtureUrl, { waitUntil: 'load' });
    await page.waitForFunction(() => !!window.__fixture, null, { timeout: 15000 }).catch(() => {});
    const launchMs = nowMs() - t0;
    return { browser, context, page, launchMs, child };
  };

  const closeSession = async (s) => {
    if (!s) return;
    // NOTE (Playwright/CDP-specific): Browser#close() on a browser obtained
    // via connectOverCDP() only DISCONNECTS the Playwright client; it does
    // NOT terminate the remote Chrome process, because Playwright didn't
    // launch it. We own the child process directly, so we must kill it
    // ourselves to actually release the profile directory and the port.
    if (s.browser) await s.browser.close().catch(() => {});
    if (s.child && !s.child.killed) {
      try {
        if (process.platform === 'win32') {
          execFileSync('taskkill', ['/F', '/T', '/PID', String(s.child.pid)], { windowsHide: true });
        } else {
          s.child.kill('SIGKILL');
        }
      } catch {
        /* best-effort */
      }
    }
  };

  try {
    session = await launch();
    result.launchMs = session.launchMs;

    result.observation = await measureObservation(session.page, result.limitations);
    result.eventCoverage = await measureEventCoverage(session.page, session.context, 10000);

    const expected = await setPersistenceMarkers(session.page, session.context, fixtureUrl);
    await closeSession(session);
    session = await launch();
    result.sessionPersistence = await checkPersistenceMarkers(session.page, session.context, fixtureUrl, expected);

    result.takeoverErgonomics = await measureTakeoverErgonomics(session.page);

    const killFn = async (s) => {
      if (!s.child || s.child.killed) throw new Error('no live child process handle to kill');
      s.child.kill('SIGKILL');
    };
    result.crashBehavior = await measureCrashBehavior(session, launch, killFn);
    if (result.crashBehavior.killError) result.limitations.push('crashBehavior: ' + result.crashBehavior.killError);
    if (result.crashBehavior._recovered) {
      session = result.crashBehavior._recovered;
      delete result.crashBehavior._recovered;
    } else {
      session = null;
      delete result.crashBehavior._recovered;
    }

    result.limitations.push(
      'cdp mode is diagnostic only per spec: Chrome is spawned directly by this harness and Playwright attaches via chromium.connectOverCDP()'
    );
  } catch (err) {
    result.status = 'failed';
    result.error = String((err && err.stack) || err);
  } finally {
    await closeSession(session);
  }
  return result;
}

// ---------------------------------------------------------------------------
// CLI parsing
// ---------------------------------------------------------------------------

function parseArgs(argv) {
  const opts = {
    modes: [...KNOWN_MODES],
    fixture: 'http://127.0.0.1:8177',
    out: '../results/track-a.json',
  };
  for (const arg of argv) {
    const m = arg.match(/^--([^=]+)=(.*)$/);
    if (!m) continue;
    const [, key, val] = m;
    if (key === 'modes') opts.modes = val.split(',').map((s) => s.trim()).filter(Boolean);
    else if (key === 'fixture') opts.fixture = val;
    else if (key === 'out') opts.out = val;
  }
  return opts;
}

// ---------------------------------------------------------------------------
// Summary table
// ---------------------------------------------------------------------------

function printSummaryTable(results) {
  console.log('\n=== Summary ===');
  const header = ['mode', 'status', 'launchMs', 'session(cookie/ls)', 'obs(doc/grid/open/closed/iframe)', 'eventCoverage', 'crash(recovered)'];
  const rows = [header];

  for (const [mode, r] of Object.entries(results.modes)) {
    if (!r || r.status === 'failed') {
      rows.push([mode, 'FAILED', '-', '-', '-', '-', '-']);
      continue;
    }
    const obs = r.observation || {};
    const obsKeys = ['mainDocumentText', 'virtualizedGridRowCount', 'openShadowRoot', 'closedShadowRoot', 'iframeContent'];
    const obsStr = obsKeys.map((k) => (obs[k] ? (obs[k].observable ? 'Y' : 'N') : '?')).join('/');
    rows.push([
      mode,
      r.status || 'ok',
      r.launchMs != null ? Math.round(r.launchMs) + 'ms' : '-',
      r.sessionPersistence ? `cookie:${r.sessionPersistence.cookie} ls:${r.sessionPersistence.localStorage}` : '-',
      obsStr,
      r.eventCoverage ? JSON.stringify(r.eventCoverage) : '-',
      r.crashBehavior ? String(r.crashBehavior.recovered) : '-',
    ]);
  }

  const widths = header.map((_, i) => Math.max(...rows.map((row) => String(row[i]).length)));
  for (const row of rows) {
    console.log(row.map((cell, i) => String(cell).padEnd(widths[i])).join('  '));
  }
  console.log('');
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  const notes = [];

  console.log('Chinvat WP-00 Track A — connection-mode measurement harness');
  console.log('Fixture URL:', opts.fixture);
  console.log('Modes to run:', opts.modes.join(', '));

  const unknown = opts.modes.filter((m) => !KNOWN_MODES.includes(m));
  for (const m of unknown) {
    notes.push('Unknown mode requested and skipped: ' + m);
    console.warn('WARNING: unknown mode "' + m + '" — skipping.');
  }
  const modesToRun = opts.modes.filter((m) => KNOWN_MODES.includes(m));

  const reachable = await checkFixtureReachable(opts.fixture);
  if (!reachable) {
    console.error('\nERROR: fixture is not reachable at ' + opts.fixture);
    console.error('Start it first, in another terminal, from the fixture directory:');
    console.error('  node ' + path.resolve(__dirname, '..', 'fixture', 'server.mjs'));
    console.error('Then re-run this harness.\n');
    process.exit(1);
    return;
  }

  let playwrightVersion = 'unknown';
  try {
    playwrightVersion = require('playwright/package.json').version;
  } catch {
    /* leave as 'unknown' */
  }

  const results = {
    generatedAt: new Date().toISOString(),
    node: process.version,
    playwrightVersion,
    os: { platform: os.platform(), release: os.release(), arch: os.arch() },
    modes: {},
    notes,
  };

  const localAppData = process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local');
  const profilesBase = path.join(localAppData, 'chinvat-spike', 'profiles', 'wp00');
  const extensionDir = path.join(__dirname, 'extension');

  for (const mode of modesToRun) {
    console.log('\n=== Running mode: ' + mode + ' ===');
    try {
      if (mode === 'persistent-profile') {
        results.modes[mode] = await runPersistentProfileMode({
          fixtureUrl: opts.fixture,
          profileDir: profilesBase + '-persistent',
        });
      } else if (mode === 'extension') {
        results.modes[mode] = await runExtensionMode({
          fixtureUrl: opts.fixture,
          profileDir: profilesBase + '-extension',
          extensionDir,
        });
      } else if (mode === 'cdp') {
        results.modes[mode] = await runCdpMode({
          fixtureUrl: opts.fixture,
          profileDir: profilesBase + '-cdp',
        });
      }
    } catch (err) {
      // Defense in depth: each run*Mode() function already has its own
      // try/catch/finally, but this guarantees one mode's unexpected throw
      // never aborts the others or skips writing the results file.
      results.modes[mode] = { status: 'failed', error: String((err && err.stack) || err) };
      console.error('Mode "' + mode + '" failed:', err);
    }
  }

  const outPath = path.resolve(process.cwd(), opts.out);
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, JSON.stringify(results, null, 2), 'utf8');
  console.log('\nResults written to:', outPath);

  printSummaryTable(results);
}

main().catch((err) => {
  console.error('Fatal error in harness:', err);
  process.exit(1);
});
