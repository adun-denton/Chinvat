# Configuring Chinvat

The dashboard at `http://localhost:7777` is the primary configuration surface. Top-level network/auth values may still require JSON or environment configuration.

## Modules

For each worker:

1. Enter the fields shown on its card.
2. Keep credentials in secret fields, never in prompts.
3. Enable the module.
4. Select `observe`, `approve`, or `autonomous`.
5. Save and run **Test connection**.
6. Test one low-impact real operation.

A healthy response proves the configured identity/endpoint answered. It does not guarantee every provider scope, product entitlement, access tier, credit balance, or dangerous operation.

The complete 20-worker inventory and operation boundaries are in [Modules](MODULES.md).

## Policy tiers

Every operation declares `read`, `act`, or `dangerous`.

- `observe`: reads run; side-effecting work is rejected.
- `approve`: reads run; `act` and `dangerous` wait at `waiting_approval`.
- `autonomous`: all declared operations run without a pause and remain logged.

Start system, publishing, commerce, messaging, relay, and remote-control modules at `approve`. Raise autonomy only after testing the exact operations and provider identity.

## Connect

Use **Connect** to attach a coordinator. The flow previews the exact merge, creates a timestamped backup, writes only the `chinvat` MCP entry, and re-tests the endpoint.

Local HTTP endpoint:

```text
http://127.0.0.1:7777/mcp
```

HTTP is the default for Codex, Claude Code, Cursor, Hermes, and generic clients. Claude Desktop normally uses stdio because it has no native HTTP MCP transport; `mcp-remote` is the HTTP bridge option.

For tokened hubs, prefer Connect-generated snippets. Client header syntax differs and the Connect flow includes the configured bearer token.

## Jobs and approvals

**Jobs** shows queued, running, waiting, succeeded, failed, and cancelled work. Approval authorizes an attempt; it does not guarantee the upstream service accepted or completed it. Always inspect final status and result.

**Approvals** releases or denies gated work. Telegram approval buttons are optional and use the same approval records.

Use async for long work. For current `remote-node` non-read operations, use async whenever the remote tier may pause for approval; otherwise the local sync wait can expire before returning the useful remote job id.

## Configuration file

Default file:

```text
data/chinvat.config.json
```

It is git-ignored and may contain long-lived credentials. Back it up securely if needed; never commit or share it.

Shape:

```json
{
  "port": 7777,
  "bind": "127.0.0.1",
  "authToken": "",
  "concurrencyPerModule": 2,
  "syncWaitMsDefault": 120000,
  "syncWaitMsMax": 600000,
  "ephemeralModules": ["ollama"],
  "modules": {
    "system": {
      "enabled": true,
      "tier": "approve",
      "config": {
        "allowedRoots": "C:\\Users\\me\\Documents"
      }
    }
  }
}
```

## Environment overlays

```text
CHINVAT_PORT
CHINVAT_DATA_DIR
CHINVAT_BIND
CHINVAT_AUTH_TOKEN
```

Environment values override JSON during process construction.

Important persistence behavior: the overridden values become part of the process’s in-memory config. If that process later saves config—for example when a module is first materialized or changed—the top-level environment values can be written into `chinvat.config.json`. Do not assume a one-off environment launch remains temporary.

## Authentication and bind policy

Defaults: loopback bind, empty token, zero-configuration local use.

The hub enforces before listening:

- any non-loopback `bind` requires `authToken`;
- `authToken` must contain at least 24 characters;
- a configured token gates `/mcp`, `/api`, and `/ws`, including on loopback.

HTTP uses:

```text
Authorization: Bearer <token>
```

Browser WebSockets may send `?token=` because the browser WebSocket API cannot set arbitrary headers; a header takes precedence for non-browser clients.

`GET /auth/required` is deliberately unauthenticated so the dashboard knows whether to prompt. The dashboard stores the entered token in browser local storage; use **forget token** to remove it.

Generate a token:

```powershell
node -e "console.log(require('crypto').randomBytes(32).toString('base64url'))"
```

Remote deployment is covered in [Remote Nodes](REMOTE-NODES.md).

## Reload and multi-process behavior

`ConfigStore` reads the JSON once when a process starts and keeps an in-memory copy. There is no file watcher or live reload.

This matters because two common processes can share one file:

1. `npm start` runs the dashboard/HTTP hub.
2. Claude Desktop or another client may spawn a separate `--stdio` hub.

A dashboard module toggle updates the HTTP process and the file, but an already-running stdio process does not see it. Restart the coordinator process fully—tray included where applicable—after changing modules used through stdio.

Likewise, rebuilding `hub/dist` does not replace code already loaded by a stdio process. Restart it.

## Top-level settings surface

Module settings are editable in the dashboard. `bind`, `port`, and `authToken` are currently JSON/environment settings rather than a complete dashboard Settings panel. Changing a token from the page serving that token is non-trivial because the next request would immediately require the new credential; this UI remains backlog work.

## Ephemeral invocation

`adapter_invoke {ephemeral:true}` is for read-only operations that must not enter the job database. It is:

- synchronous;
- restricted to operations declared `read`;
- restricted to `ephemeralModules` (default `['ollama']`);
- non-persistent: no job, event, result, log, or artifact rows/files.

Requests outside those constraints fail closed.

## System filesystem fence

Prefer `allowedRoots` for multiple project/work directories. It accepts an array in JSON or a semicolon/comma-delimited string from the dashboard. Legacy `allowedRoot` remains supported. Relative paths resolve under the first root.

Keep `allowFullAccess` false unless the workflow genuinely requires the whole filesystem, and never combine full access with an untrusted caller.

## Safe defaults

- Keep `bind` at `127.0.0.1` unless deliberately deploying a remote node.
- For a remote node, bind the private mesh address, not `0.0.0.0`.
- Use one strong token per node and rotate any token exposed in logs or chat.
- Keep Windows/system, publishing, commerce, Gmail, relay, and remote-node at `approve` initially.
- Restrict `system.allowedRoots`.
- Use least-privilege provider tokens and provider-side budgets.
- Disable unused modules and expired credentials.
- Do not run elevated and unelevated hubs against the same data/repository tree.
