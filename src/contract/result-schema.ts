/**
 * contract/result-schema.ts
 *
 * Authoritative output contract for every generated iLovePDF tool
 * (TOOL-5, TOOL-6, TOOL-9, ERR-8).
 *
 * REPLACES the widget `output-schema.ts` of ../openai-app/mcp-server. That
 * schema described the INITIAL widget state the server should open. This server
 * is headless: each tool RETURNS the produced file, so the contract describes a
 * result object, not a widget state.
 *
 * ONE shape validates BOTH result surfaces:
 *   - SUCCESS: status="completed" with `output` + `metrics`.
 *   - FAILURE: status="failed" with a FLAT error surface (ERR-8) — `output` and
 *     `metrics` absent.
 *
 * `RESULT_OUTPUT_SHAPE` is exported as a ZodRawShape (a plain object of Zod
 * validators) because that is exactly what the MCP SDK `registerTool`
 * `outputSchema` field expects. Wrap it in `z.object(...)` to validate a value.
 */

import { z, type ZodRawShape } from 'zod';
import { ERROR_CODES } from '../domain/errors.js';

/**
 * Description of the input the tool acted on. Always present on both surfaces so
 * a caller can correlate the result with what it asked for (TOOL-9).
 */
const inputSchema = z
  .object({
    /** Local source paths the tool was asked to process. */
    sources: z.array(z.string()),
    /** Number of source files. */
    count: z.number(),
    /** Combined byte size of all sources. */
    totalBytes: z.number(),
  })
  .describe('Summary of the input the tool acted on.');

/**
 * Details of the produced file. Present only on the SUCCESS surface.
 */
const outputSchema = z
  .object({
    /** Local path the produced file was written to. */
    path: z.string(),
    /** iLovePDF download URL for the produced file. */
    download_url: z.string(),
    /** Size of the produced file in bytes. */
    bytes: z.number(),
    /** Number of files produced. */
    fileCount: z.number(),
  })
  .describe('Details of the produced file (success only).');

/**
 * Processing metrics. Present only on the SUCCESS surface.
 *
 * `durationMs` is REQUIRED whenever `metrics` is present: a success result that
 * carries metrics but omits the duration is malformed and must be rejected
 * (TOOL-6 guard).
 */
const metricsSchema = z
  .object({
    /** Total input bytes fed to the operation. */
    inputBytes: z.number(),
    /** Total output bytes produced. */
    outputBytes: z.number(),
    /** outputBytes / inputBytes. */
    ratio: z.number(),
    /** Wall-clock duration of the operation in milliseconds (required). */
    durationMs: z.number(),
  })
  .describe('Processing metrics (success only).');

/**
 * The single output contract for every generated tool.
 *
 * Always-present fields describe the operation, its terminal status and the
 * input. Success-only fields (`output`, `metrics`) and the failure-only flat
 * error surface (ERR-8) are all optional, so one shape validates both results.
 */
export const RESULT_OUTPUT_SHAPE = {
  // --- Always present ---------------------------------------------------------
  /** Operation name, e.g. "compress-pdf". */
  operation: z.string(),
  /** Terminal status of the tool call. */
  status: z.enum(['completed', 'failed']),
  input: inputSchema,

  // --- Success only -----------------------------------------------------------
  output: outputSchema.optional(),
  metrics: metricsSchema.optional(),

  // --- Failure only (ERR-8 flat error surface) --------------------------------
  /** Machine-readable error code (stable; from ToolError.code). */
  error_code: z.enum(ERROR_CODES).optional(),
  /** Whether the caller can safely retry without changes. */
  retryable: z.boolean().optional(),
  /** Always false on the failure surface (from ToolError.toStructured). */
  success: z.literal(false).optional(),
  /** User-facing error description (from ToolError.userMessage). */
  error: z.string().optional(),
  /** Internal diagnostic detail (from ToolError.message). */
  detail: z.string().optional(),
} satisfies ZodRawShape;
