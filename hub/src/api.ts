import express from 'express';
import type { Express, Request, Response, NextFunction } from 'express';
import { createServer, type Server } from 'node:http';
import { WebSocketServer } from 'ws';
import fs from 'node:fs';
import path from 'node:path';
import type { Hub } from './hub.js';
import { handleStreamableHttp } from './mcp.js';

const DASHBOARD_DIR = path.resolve(import.meta.dirname, '..', '..', 'dashboard', 'dist');

/**
 * Auth hook: no-op on localhost today; the v1.0 remote release swaps a token/OIDC
 * check in here without touching route handlers. See docs/ROADMAP.md.
 */
function auth(_req: Request, _res: Response, next: NextFunction): void {
  next();
}

export function buildHttp(hub: Hub): { app: Express; server: Server } {
  const app = express();
  app.use(express.json({ limit: '25mb' }));

  // MCP Streamable HTTP
  app.post('/mcp', auth, (req, res) => void handleStreamableHttp(hub, req, res));
  app.get('/mcp', auth, (_req, res) =>
    res.status(405).json({ error: 'Use POST for Streamable HTTP MCP' })
  );

  // REST API (dashboard control plane)
  const api = express.Router();
  api.use(auth);

  api.get('/status', async (_req, res) => {
    const modules = hub.registry.list();
    res.json({
      name: 'chinvat',
      version: '0.1.0',
      platform: process.platform,
      uptime_sec: Math.round(process.uptime()),
      jobs: hub.jobs.counts(),
      modules_enabled: modules.filter((m) => m.enabled).length,
      modules_total: modules.length,
      pending_approvals: hub.jobs.listPendingApprovals().length,
    });
  });

  api.get('/modules', async (_req, res) => {
    const list = hub.registry.list();
    const out = await Promise.all(
      list.map(async (m) => {
        const settings = hub.config.module(m.name);
        // never leak secret values; report which secret keys are set
        const adapter = hub.registry.get(m.name)!;
        const configPublic: Record<string, unknown> = {};
        for (const field of adapter.configSchema) {
          const val = settings.config[field.key];
          configPublic[field.key] =
            field.type === 'secret' ? (val ? '••••••' : '') : (val ?? field.default ?? '');
        }
        return {
          name: m.name,
          version: m.version,
          description: m.description,
          external: m.external,
          enabled: m.enabled,
          tier: m.tier,
          health: await hub.registry.health(m.name),
          configSchema: adapter.configSchema,
          config: configPublic,
          operations: m.operations,
        };
      })
    );
    res.json(out);
  });

  api.put('/modules/:name/config', (req, res) => {
    if (!hub.registry.get(req.params.name)) return res.status(404).json({ error: 'unknown module' });
    // strip masked placeholders so we don't overwrite secrets with dots
    const incoming = { ...(req.body?.config ?? {}) };
    for (const [k, v] of Object.entries(incoming)) if (v === '••••••') delete incoming[k];
    const updated = hub.config.updateModule(req.params.name, { config: incoming });
    hub.bus.emit({ type: 'module.config', module: req.params.name });
    void hub.registry.health(req.params.name, true);
    res.json({ ok: true, tier: updated.tier, enabled: updated.enabled });
  });

  api.put('/modules/:name/tier', (req, res) => {
    const tier = req.body?.tier;
    if (!['observe', 'approve', 'autonomous'].includes(tier))
      return res.status(400).json({ error: 'tier must be observe|approve|autonomous' });
    if (!hub.registry.get(req.params.name)) return res.status(404).json({ error: 'unknown module' });
    hub.config.updateModule(req.params.name, { tier });
    hub.bus.emit({ type: 'module.config', module: req.params.name });
    res.json({ ok: true });
  });

  api.put('/modules/:name/enabled', (req, res) => {
    if (!hub.registry.get(req.params.name)) return res.status(404).json({ error: 'unknown module' });
    hub.config.updateModule(req.params.name, { enabled: req.body?.enabled === true });
    hub.bus.emit({ type: 'module.config', module: req.params.name });
    res.json({ ok: true });
  });

  api.get('/jobs', (req, res) => {
    res.json(
      hub.jobs.list({
        status: req.query.status as string | undefined,
        module: req.query.module as string | undefined,
        limit: req.query.limit ? Number(req.query.limit) : undefined,
      })
    );
  });

  api.get('/jobs/:id', (req, res) => {
    const job = hub.jobs.get(req.params.id);
    if (!job) return res.status(404).json({ error: 'unknown job' });
    res.json({
      ...job,
      children: hub.jobs.children(req.params.id),
      events: hub.jobs.eventsFor(req.params.id),
      artifacts: hub.artifacts.list(req.params.id),
    });
  });

  api.post('/jobs', (req, res) => {
    try {
      const job = hub.jobs.submit({
        module: req.body.module,
        operation: req.body.operation,
        args: req.body.args ?? {},
        parent_id: req.body.parent_id ?? null,
        mode: req.body.mode ?? 'async',
        source: 'dashboard',
      });
      res.status(201).json(job);
    } catch (e) {
      res.status(400).json({ error: e instanceof Error ? e.message : String(e) });
    }
  });

  api.post('/jobs/:id/cancel', (req, res) => {
    try {
      res.json(hub.jobs.cancel(req.params.id, 'dashboard'));
    } catch (e) {
      res.status(400).json({ error: e instanceof Error ? e.message : String(e) });
    }
  });

  api.get('/jobs/:id/artifacts/:name', (req, res) => {
    const file = hub.artifacts.resolve(req.params.id, req.params.name);
    if (!file) return res.status(404).json({ error: 'artifact not found' });
    res.sendFile(file);
  });

  api.get('/approvals', (_req, res) => res.json(hub.jobs.listPendingApprovals()));

  api.post('/approvals/:id/approve', (req, res) => {
    const okd = hub.jobs.resolveApproval(req.params.id, 'approved', 'dashboard');
    res.status(okd ? 200 : 409).json({ ok: okd });
  });

  api.post('/approvals/:id/deny', (req, res) => {
    const okd = hub.jobs.resolveApproval(req.params.id, 'denied', 'dashboard');
    res.status(okd ? 200 : 409).json({ ok: okd });
  });

  app.use('/api', api);

  // Static dashboard (built SPA)
  if (fs.existsSync(DASHBOARD_DIR)) {
    app.use(express.static(DASHBOARD_DIR));
    app.get(/^(?!\/api|\/mcp|\/ws).*/, (_req, res) => res.sendFile(path.join(DASHBOARD_DIR, 'index.html')));
  } else {
    app.get('/', (_req, res) =>
      res
        .type('html')
        .send('<h1>Chinvat hub is running</h1><p>Dashboard not built. Run <code>npm run build -w dashboard</code>. API is at <code>/api/status</code>.</p>')
    );
  }

  // WebSocket: live job/approval/module events
  const server = createServer(app);
  const wss = new WebSocketServer({ server, path: '/ws' });
  wss.on('connection', (ws) => {
    const unsub = hub.bus.on((evt) => {
      if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(evt));
    });
    ws.on('close', unsub);
    ws.send(JSON.stringify({ type: 'hello', name: 'chinvat', version: '0.1.0' }));
  });

  return { app, server };
}
