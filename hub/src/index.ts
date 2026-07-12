#!/usr/bin/env node
import { Hub } from './hub.js';
import { serveStdio } from './mcp.js';
import { buildHttp } from './api.js';

function hasFlag(name: string): boolean {
  return process.argv.includes(name);
}
function flagValue(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

async function main(): Promise<void> {
  const hub = new Hub();
  await hub.start();

  const stdio = hasFlag('--stdio');
  const noHttp = hasFlag('--no-http');
  const explicitHttp = hasFlag('--http') || flagValue('--port') !== undefined;

  if (stdio) {
    // In stdio mode, stdout is the MCP channel — keep it clean; logs go to stderr.
    await serveStdio(hub);
  }

  // Serve HTTP for a normal run; in stdio mode only when explicitly asked. This keeps a
  // client-spawned stdio hub from trying to bind :7777 while the dashboard hub already owns it.
  if (!noHttp && (!stdio || explicitHttp)) {
    const cfg = hub.config.get();
    const port = Number(flagValue('--port') ?? cfg.port);
    const { server } = buildHttp(hub, port);
    server.on('error', (e: NodeJS.ErrnoException) => {
      process.stderr.write(
        `[chinvat] http server error: ${e.code ?? ''} ${e.message ?? e}` +
          (e.code === 'EADDRINUSE' ? ` (port ${port} is already in use — another hub may be running)` : '') +
          '\n'
      );
    });
    server.listen(port, cfg.bind, () => {
      process.stderr.write(
        `[chinvat] hub on http://${cfg.bind}:${port}  ·  dashboard + /api + /ws + /mcp\n`
      );
    });
  }

  const shutdown = () => {
    process.stderr.write('[chinvat] shutting down\n');
    hub.shutdown();
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main().catch((e) => {
  process.stderr.write(`[chinvat] fatal: ${e?.stack ?? e}\n`);
  process.exit(1);
});
