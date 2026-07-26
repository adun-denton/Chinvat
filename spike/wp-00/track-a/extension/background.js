/**
 * background.js — MV3 service worker for the Track A connection-mode probe.
 *
 * Purpose: connect to the measurement harness (run-connection-modes.mjs) over
 * a plain WebSocket on 127.0.0.1, and relay a small, fixed command set using
 * only the permissions declared in manifest.json (tabs, scripting,
 * activeTab, and host permission for the fixture origin). This lets the
 * harness compare what an EXTENSION can observe about the browser versus
 * what a Playwright DRIVER attached to the same browser instance can observe.
 *
 * WINDOWS/CHROME-SPECIFIC NOTES:
 *  - MV3 background scripts are service workers, not persistent background
 *    pages. Chrome may terminate an idle service worker after ~30 seconds.
 *    We deliberately did NOT request the "alarms" permission to keep this
 *    worker artificially alive — the task instructions say to record a
 *    missing capability as a limitation rather than silently expanding
 *    permissions to work around it. So: the WebSocket connection can and
 *    will drop when the worker is suspended, and reconnects (see connect()
 *    below) the next time the worker wakes up (e.g. on its own event
 *    listeners firing). The harness times out and records a limitation if a
 *    command gets no response in time.
 *  - `new WebSocket(...)` is available in the MV3 service worker global
 *    scope in current Chrome/Chromium and is not restricted by the default
 *    extension_pages CSP (which only restricts script-src/object-src, not
 *    connect-src), so no extra manifest changes were needed for this.
 *  - The WebSocket port (EXTENSION_WS_PORT) is a fixed constant that MUST
 *    match the harness's own EXTENSION_WS_PORT constant in
 *    run-connection-modes.mjs. It is not negotiated at runtime.
 */

const EXTENSION_WS_PORT = 8898; // keep in sync with run-connection-modes.mjs
const WS_URL = `ws://127.0.0.1:${EXTENSION_WS_PORT}/`;
const FIXTURE_ORIGIN_PATTERN = 'http://127.0.0.1:8177/*';

let ws = null;
let reconnectTimer = null;

function scheduleReconnect(delayMs = 1000) {
  clearTimeout(reconnectTimer);
  reconnectTimer = setTimeout(connect, delayMs);
}

function connect() {
  try {
    ws = new WebSocket(WS_URL);
  } catch (err) {
    // Harness may not be listening yet (e.g. still starting up); back off and retry.
    scheduleReconnect();
    return;
  }

  ws.addEventListener('open', () => {
    try {
      ws.send(JSON.stringify({ type: 'hello', role: 'extension-background' }));
    } catch {
      /* ignore */
    }
  });

  ws.addEventListener('message', async (ev) => {
    let msg;
    try {
      msg = JSON.parse(ev.data);
    } catch {
      return; // ignore malformed frames
    }
    const { id, cmd, args } = msg || {};
    if (id == null || !cmd) return;
    try {
      const result = await handleCommand(cmd, args || {});
      ws.send(JSON.stringify({ id, ok: true, result }));
    } catch (err) {
      ws.send(JSON.stringify({ id, ok: false, error: String((err && err.message) || err) }));
    }
  });

  ws.addEventListener('close', () => scheduleReconnect());
  ws.addEventListener('error', () => {
    /* 'close' fires after 'error' for WebSocket; reconnect is scheduled there */
  });
}

/**
 * Finds the fixture tab using the "tabs" permission (which allows querying
 * URLs/titles across all tabs, not just the active one — that broader
 * visibility is what "tabs" grants over the more limited "activeTab").
 */
async function findFixtureTab() {
  const tabs = await chrome.tabs.query({ url: FIXTURE_ORIGIN_PATTERN });
  if (tabs.length === 0) throw new Error('no fixture tab found matching ' + FIXTURE_ORIGIN_PATTERN);
  // If more than one matches, prefer the most recently accessed one.
  tabs.sort((a, b) => (b.lastAccessed || 0) - (a.lastAccessed || 0));
  return tabs[0];
}

async function handleCommand(cmd, args) {
  switch (cmd) {
    case 'ping': {
      // Pure round-trip latency probe; no chrome.* API involved.
      return { pong: true, ts: Date.now(), echo: args.ts };
    }

    case 'getTabInfo': {
      const tab = await findFixtureTab();
      return { id: tab.id, title: tab.title, url: tab.url };
    }

    case 'getReadyState': {
      // Requires "scripting" + host_permissions for the target origin.
      const tab = await findFixtureTab();
      const injectionResults = await chrome.scripting.executeScript({
        target: { tabId: tab.id },
        func: () => document.readyState,
      });
      const readyState = injectionResults && injectionResults[0] ? injectionResults[0].result : null;
      return { readyState };
    }

    case 'listTabs': {
      // Requires "tabs" permission to see url/title for tabs other than the active one.
      const tabs = await chrome.tabs.query({});
      return {
        tabs: tabs.map((t) => ({ id: t.id, url: t.url, title: t.title, active: t.active })),
      };
    }

    default:
      throw new Error('unknown command: ' + cmd);
  }
}

connect();
