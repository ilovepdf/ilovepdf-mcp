/**
 * src/server.ts
 *
 * Transport-agnostic McpServer builder (LOG-1, LOG-2, design §2.2).
 *
 * `buildServer()` constructs a fully configured `McpServer` — with all 10
 * tools registered via `registerAllTools` — WITHOUT binding any transport.
 * The transport (StdioServerTransport) lives exclusively in `src/index.ts`.
 * This separation means a future Streamable HTTP entry point (`src/http.ts`)
 * can reuse `buildServer()` unchanged (design §2.2 / LOG-2).
 *
 * Strictly forbidden in this file (enforced by test/server-isolation.test.ts):
 *   - Any import from `@modelcontextprotocol/sdk/server/stdio.js`
 *   - Any reference to `process.stdout` or `process.stdin`
 *   - `console.log` (LOG-3: stdout reserved for MCP protocol frames)
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { registerAllTools } from './tools/register.js';
import { createRequire } from 'node:module';

// Read the package version at startup via createRequire so we stay compatible
// with `rootDir: "src"` in tsconfig (JSON is outside rootDir) while still
// keeping version in sync with package.json automatically.
const _require = createRequire(import.meta.url);
const { version } = _require('../package.json') as { version: string };

/**
 * Build a fully configured McpServer with all registered tools.
 *
 * The returned server has NO transport attached — callers (`src/index.ts`)
 * are responsible for constructing a transport and calling
 * `server.connect(transport)`.
 *
 * @returns A `McpServer` instance ready to accept tool calls once a transport
 *          is connected by the bin entry point.
 */
export function buildServer(): McpServer {
  const server = new McpServer(
    { name: '@ilovepdf/mcp', version },
    { capabilities: { tools: {} } }
  );
  registerAllTools(server);
  return server;
}
