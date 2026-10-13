/**
 * tools/tool-name.ts
 *
 * SINGLE source of the MCP tool-naming rule (TOOL-2, OPS-6, DEC-1).
 *
 * DEC-1: a tool name is derived mechanically from its operation name as
 *   the operation name with every `-` replaced by `_`
 * (e.g. `compress-pdf` -> `compress_pdf`, `merge-pdf` ->
 * `merge_pdf`). An optional `op.toolName` override wins when present;
 * v1 overrides only `watermark` -> `watermark_pdf`, `pagenumber` ->
 * `pagenumber_pdf`, `pdf-ocr` -> `ocr_pdf` (collision risk / verb-first
 * consistency), and `unlock` -> `unlock_pdf` once re-enabled; the hook keeps
 * the rule in one place so future name changes need touch nothing else.
 *
 * No other module hardcodes a tool name — they all call `toolName`.
 */

import type { OperationSpec } from '../domain/operation-types.js';

/**
 * Returns the MCP tool name for an operation. Uses `op.toolName` when set,
 * otherwise derives it mechanically per DEC-1.
 */
export function toolName(op: OperationSpec): string {
  return op.toolName ?? op.name.replace(/-/g, '_');
}
