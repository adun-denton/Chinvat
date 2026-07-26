import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(__dirname, 'public');
const PORT = Number(process.env.PORT) || 8177;
const HOST = '127.0.0.1';

// ---- deterministic PRNG (mulberry32) ----
function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0;
    a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const SEED = 1337;
const rand = mulberry32(SEED);
const TOTAL_ROWS = 500;
const BASE_TIME = Date.UTC(2026, 0, 1, 0, 0, 0);

const ADJ = ['Blue', 'Rapid', 'Prime', 'North', 'Silver', 'Golden', 'Quantum', 'Bright', 'Steady', 'Bold', 'Clear', 'Fresh', 'Grand', 'Swift', 'Loyal'];
const NOUN = ['Falcon', 'Harbor', 'Summit', 'Meadow', 'Comet', 'Anchor', 'Lantern', 'Voyage', 'Orbit', 'Ember', 'Ridge', 'Delta', 'Beacon', 'Current', 'Atlas'];
const SUFFIX = ['Campaign', 'Push', 'Drive', 'Launch', 'Series', 'Wave', 'Blitz', 'Rollout'];

function round2(n) {
  return Math.round(n * 100) / 100;
}

function genRows() {
  const rows = [];
  for (let i = 1; i <= TOTAL_ROWS; i++) {
    const id = 'cmp_' + String(i).padStart(4, '0');
    const adj = ADJ[Math.floor(rand() * ADJ.length)];
    const noun = NOUN[Math.floor(rand() * NOUN.length)];
    const suf = SUFFIX[Math.floor(rand() * SUFFIX.length)];
    const name = `${adj} ${noun} ${suf}`;
    const status = rand() < 0.65 ? 'ACTIVE' : 'PAUSED';
    const dailyBudget = round2(10 + rand() * 4990);
    const spendFraction = rand() * 0.9 + 0.05;
    const spend = round2(dailyBudget * spendFraction * (1 + Math.floor(rand() * 30)));
    const impressions = Math.floor(rand() * 500000);
    const clicks = Math.floor(impressions * (0.005 + rand() * 0.05));
    const dayOffset = Math.floor(rand() * 30);
    const updatedAt = new Date(BASE_TIME - dayOffset * 86400000).toISOString();
    rows.push({ id, name, status, dailyBudget, spend, impressions, clicks, updatedAt });
  }
  return rows;
}

const rows = genRows();

let driftMode = 'none';
const DRIFT_MODES = new Set(['none', 'rename-labels', 'reorder-columns', 'restructure-dom', 'slow']);

const CONTENT_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.txt': 'text/plain; charset=utf-8',
};

function sendJson(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store',
  });
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (chunk) => {
      data += chunk;
      if (data.length > 1e6) {
        req.destroy();
        reject(new Error('body too large'));
      }
    });
    req.on('end', () => resolve(data));
    req.on('error', reject);
  });
}

function validateBudgetValue(raw) {
  let value = raw;
  if (typeof value === 'string') {
    if (!/^-?\d+(\.\d+)?$/.test(value.trim())) return { ok: false, error: 'value must be numeric' };
    value = Number(value.trim());
  }
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return { ok: false, error: 'value must be a number' };
  }
  if (value <= 0) return { ok: false, error: 'value must be > 0' };
  if (value > 10000) return { ok: false, error: 'value must be <= 10000' };
  const rounded = round2(value);
  if (Math.abs(rounded - value) > 1e-9) return { ok: false, error: 'value must have at most 2 decimal places' };
  return { ok: true, value: rounded };
}

function serveStatic(req, res, urlPath) {
  let rel = urlPath === '/' ? '/index.html' : urlPath;
  rel = rel.split('?')[0];
  const safePath = path.normalize(path.join(PUBLIC_DIR, decodeURIComponent(rel)));
  if (!safePath.startsWith(PUBLIC_DIR)) {
    res.writeHead(403);
    res.end('forbidden');
    return;
  }
  fs.readFile(safePath, (err, data) => {
    if (err) {
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      res.end('not found');
      return;
    }
    const ext = path.extname(safePath).toLowerCase();
    res.writeHead(200, { 'Content-Type': CONTENT_TYPES[ext] || 'application/octet-stream' });
    res.end(data);
  });
}

const server = http.createServer(async (req, res) => {
  try {
    const u = new URL(req.url, `http://${HOST}:${PORT}`);
    const pathname = u.pathname;

    if (req.method === 'GET' && pathname === '/api/campaigns') {
      const offset = Math.max(0, parseInt(u.searchParams.get('offset') || '0', 10) || 0);
      const limit = Math.max(1, Math.min(500, parseInt(u.searchParams.get('limit') || '50', 10) || 50));
      const slice = rows.slice(offset, offset + limit);
      sendJson(res, 200, { rows: slice, total: rows.length, offset, limit });
      return;
    }

    if (req.method === 'GET' && pathname === '/api/campaigns/summary') {
      let totalSpend = 0;
      let totalBudget = 0;
      for (const r of rows) {
        totalSpend += r.spend;
        totalBudget += r.dailyBudget;
      }
      sendJson(res, 200, {
        totalRows: rows.length,
        totalSpend: round2(totalSpend),
        totalBudget: round2(totalBudget),
      });
      return;
    }

    const budgetMatch = pathname.match(/^\/api\/campaigns\/([^/]+)\/budget$/);
    if (req.method === 'POST' && budgetMatch) {
      const id = budgetMatch[1];
      const row = rows.find((r) => r.id === id);
      if (!row) {
        sendJson(res, 404, { error: 'campaign not found' });
        return;
      }
      let parsed;
      try {
        const bodyStr = await readBody(req);
        parsed = JSON.parse(bodyStr || '{}');
      } catch {
        sendJson(res, 400, { error: 'invalid JSON body' });
        return;
      }
      const result = validateBudgetValue(parsed.value);
      await new Promise((resolve) => setTimeout(resolve, 900));
      if (!result.ok) {
        sendJson(res, 400, { error: result.error });
        return;
      }
      row.dailyBudget = result.value;
      row.updatedAt = new Date().toISOString();
      sendJson(res, 200, { row });
      return;
    }

    if (req.method === 'GET' && pathname === '/api/drift') {
      const mode = u.searchParams.get('mode');
      if (mode) {
        if (!DRIFT_MODES.has(mode)) {
          sendJson(res, 400, { error: 'unknown drift mode' });
          return;
        }
        driftMode = mode;
      }
      sendJson(res, 200, { mode: driftMode });
      return;
    }

    if (req.method === 'GET' && pathname === '/api/config') {
      sendJson(res, 200, { driftMode });
      return;
    }

    if (req.method === 'GET') {
      serveStatic(req, res, pathname);
      return;
    }

    sendJson(res, 404, { error: 'not found' });
  } catch (err) {
    sendJson(res, 500, { error: 'internal error' });
  }
});

server.listen(PORT, HOST, () => {
  console.log(`fixture listening http://${HOST}:${PORT}`);
});
