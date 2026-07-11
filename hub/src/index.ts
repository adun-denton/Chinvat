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

  if (stdio) {
    // In stdio mode, stdout is the MCP channel — keep it clean; logs go to stderr.
    await serveStdio(hub);
  }

  if (!noHttp) {
    const cfg = hub.config.get();
    const port = Number(flagValue('--port') ?? cfg.port);
    const { server } = buildHttp(hub, port);
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
