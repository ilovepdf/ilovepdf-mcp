#!/usr/bin/env node
/**
 * src/index.ts — bin entry point (LOG-1, LOG-3, design §2.1)
 *
 * The ONLY module in this project permitted to import a transport
 * (`StdioServerTransport` from the MCP SDK). Every other module under
 * src/core/, src/domain/, src/contract/, src/lib/, src/tools/, and
 * src/server.ts is transport-agnostic — enforced by server-isolation.test.ts
 * and test/index.test.ts. A future Streamable HTTP entry (`src/http.ts`) can
 * call `buildServer()` unchanged without touching this file.
 *
 * Bootstrap sequence (ORDER IS LOAD-BEARING — must not be rearranged):
 *   1. `lockdownStdout()` — reroute console.log/info/debug to stderr BEFORE
 *      any other code runs. A single stray console.log before the transport
 *      connects would corrupt the MCP JSON-RPC frame channel (design §2.3,
 *      LOG-3 layer 2). This call must precede buildServer() and connect().
 *   2. Warn if ILOVEPDF_PUBLIC_KEY is unset — non-fatal; tools/list still
 *      works for client discovery. The key is validated lazily at each tool
 *      call via requireEnv() (design §6).
 *   3. `buildServer()` — construct McpServer + register all 10 tools
 *      (transport-agnostic, design §2.2).
 *   4. `new StdioServerTransport()` + `server.connect(transport)` — bind the
 *      transport and begin the MCP JSON-RPC loop on stdin/stdout.
 *   5. Register SIGINT/SIGTERM handlers for graceful shutdown — after connect
 *      so `server.close()` can flush any in-flight response.
 */

import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { buildServer } from './server.js';
import { lockdownStdout } from './lib/stdout-guard.js';
import { getPublicKey } from './lib/env.js';
import { log } from './core/audit-logger.js';

async function main(): Promise<void> {
  // Step 1: MUST be first — lock stdout before buildServer() or any import
  // side-effect can accidentally write to the MCP protocol channel (LOG-3).
  lockdownStdout();

  // Step 2: non-fatal startup warning; hard-exit is withheld so tool discovery
  // (tools/list) works even with a missing key (design §6, §2.1).
  if (!getPublicKey()) {
    log.warn(
      'ILOVEPDF_PUBLIC_KEY is not set; tool calls will fail until it is provided.'
    );
  }

  // Step 3: build the McpServer with all tools registered (no transport yet).
  const server = buildServer();

  // Step 4: bind the stdio transport and start listening for MCP JSON-RPC.
  const transport = new StdioServerTransport();
  await server.connect(transport);

  // Step 5: graceful shutdown — server.close() flushes any in-flight frames
  // before the process exits.
  const shutdown = async (signal: string): Promise<void> => {
    log.info(`received ${signal}, shutting down`);
    await server.close();
    process.exit(0);
  };

  // `void` operator discards the returned Promise so Node does not emit an
  // UnhandledPromiseRejection warning if the SIGINT/SIGTERM handler itself
  // throws — the process exits anyway via process.exit(0) inside `shutdown`.
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
}

main().catch(err => {
  // Catch-all for unexpected failures during bootstrap (e.g. transport bind
  // error, missing node_modules). console.error is the only safe pre-transport
  // stderr channel and is in the ESLint allow list (LOG-3, no-console rule).
  console.error('[ilovepdf-mcp] fatal', err instanceof Error ? err.stack : err);
  process.exit(1);
});
