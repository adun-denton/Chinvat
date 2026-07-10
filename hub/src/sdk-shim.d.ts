/**
 * Fallback type shim for the MCP SDK.
 *
 * TypeScript wildcard ambient declarations are LOWER priority than real module
 * resolution: on a complete `npm install` the SDK ships its own .d.ts files and
 * those take precedence, so this shim contributes nothing and full typing applies.
 * It only activates when the SDK's declaration files are absent (e.g. a partial
 * install in a constrained CI/sandbox), keeping the build green without weakening
 * types on real machines.
 */
declare module '@modelcontextprotocol/sdk/*';
