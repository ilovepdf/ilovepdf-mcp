/**
 * tools/register.ts
 *
 * Registry-driven MCP tool registration (TOOL-1, TOOL-2, TOOL-6, design §3).
 *
 * `registerAllTools(server)` iterates the OPERATIONS registry — the single
 * source of truth in `domain/operations.ts` — and calls `server.registerTool`
 * ONCE per operation. Every aspect of each tool (name, title, description,
 * input shape, output shape, handler) is derived from the registry. Adding or
 * removing an entry in `OPERATION_NAMES` automatically adds or removes a tool
 * with NO changes to this file (TOOL-1 / DEC-1).
 *
 * Tool naming   — `tools/tool-name.ts` (DEC-1 single source: `iLovePDF_<snake>`)
 * Input shape   — `tools/input-shape.ts` (§3.2: sources, output_path, options)
 * Output shape  — `contract/result-schema.ts` (LOCKED shared RESULT_OUTPUT_SHAPE)
 * Description   — `tools/descriptions.ts` (SHORT, client-agnostic)
 * Handler       — `tools/handler.ts` (§3.3: validate→upload→execute→build)
 *
 * This module does NOT import a transport. It is fully transport-agnostic.
 * `src/server.ts` calls `registerAllTools(server)` after constructing the
 * McpServer; `src/index.ts` later binds the transport.
 */

import { McpServer, type ToolCallback } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { ZodRawShape } from 'zod';
import { OPERATION_NAMES, specFor } from '../domain/operations.js';
import { toolName } from './tool-name.js';
import { buildInputShape } from './input-shape.js';
import { describeTool } from './descriptions.js';
import { RESULT_OUTPUT_SHAPE } from '../contract/result-schema.js';
import { makeHandler } from './handler.js';

/**
 * Register every operation from the OPERATIONS registry as an MCP tool.
 *
 * Iterates `OPERATION_NAMES` (domain/operations.ts — single source of truth)
 * and registers one tool per entry via `server.registerTool`. Pure iteration:
 * adding an 11th entry to OPERATION_NAMES yields an 11th tool automatically.
 *
 * @param server — A `McpServer` instance (no transport connected yet).
 */
export function registerAllTools(server: McpServer): void {
  for (const name of OPERATION_NAMES) {
    const op = specFor(name);
    server.registerTool(
      toolName(op),
      {
        title: op.label,
        description: describeTool(name),
        inputSchema: buildInputShape(op),
        outputSchema: RESULT_OUTPUT_SHAPE,
        // Operations mutate files — readOnlyHint:false, idempotentHint:false.
        annotations: { readOnlyHint: false, idempotentHint: false },
      },
      // makeHandler(op) returns (args: HandlerArgs) => Promise<HandlerResult>.
      // registerTool infers ToolCallback<ZodRawShape> from buildInputShape's return type.
      // HandlerArgs is structurally equivalent to ShapeOutput<ZodRawShape> at runtime
      // (SDK parses the raw shape before passing it), but contravariant param checking
      // prevents direct assignment — intermediate unknown cast is the narrowest viable path.
      makeHandler(op) as unknown as ToolCallback<ZodRawShape>
    );
  }
}
