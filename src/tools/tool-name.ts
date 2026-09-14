/**
 * tools/tool-name.ts
 *
 * SINGLE source of the MCP tool-naming rule (TOOL-2, OPS-6, DEC-1).
 *
 * DEC-1: a tool name is derived mechanically from its operation name as
 *   `iLovePDF_` + operationName with every `-` replaced by `_`
 * (e.g. `compress-pdf` -> `iLovePDF_compress_pdf`, `merge-pdf` ->
 * `iLovePDF_merge_pdf`). An optional `op.toolName` override wins when present;
 * v1 ships no overrides, but the hook keeps the rule in one place so future
 * name changes need touch nothing else.
 *
 * No other module hardcodes a tool name — they all call `toolName`.
 */

import type { OperationSpec } from '../domain/operation-types.js';

/**
 * Returns the MCP tool name for an operation. Uses `op.toolName` when set,
 * otherwise derives it mechanically per DEC-1.
 */
export function toolName(op: OperationSpec): string {
  return op.toolName ?? `iLovePDF_${op.name.replace(/-/g, '_')}`;
}
