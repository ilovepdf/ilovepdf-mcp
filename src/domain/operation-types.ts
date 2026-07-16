/**
 * domain/operation-types.ts
 *
 * Core type definitions for the operations registry (AD-5).
 * These are the single-source types that replace the scattered SUPPORTED_TOOLS,
 * TOOL_TO_API_MAP, toolsMustBeDirect, and TOOLS_REQUIRING_SHARED_UPLOAD_TASK constants.
 *
 * Ported from ../openai-app/mcp-server/src/domain/operation-types.ts. This
 * headless port DROPS all widget-specific concepts: the `WidgetParam`,
 * `ParamSource`, and `UploadSource` types, the `needsParameters` /
 * `chatRequiredParams` / `chatCollectableParams` helpers, and the
 * `widgetParams` field on `OperationSpec`. The `requiresSharedTask` and
 * `mustBeDirect` flags are retained as they describe API orchestration
 * behavior, not widget UX.
 *
 * NOTE: `optionsSchema` carries a `z.ZodType` reference. The concrete per-tool schemas
 * will be defined in `contract/options-schema.ts`. Operations in this module reference
 * it as the abstract `z.ZodType` so the types compile without importing the concrete
 * schemas here.
 */

import type { z } from 'zod';

// ---------------------------------------------------------------------------
// Operation / API tool name unions
// ---------------------------------------------------------------------------

export type OperationName =
  | 'compress-pdf'
  | 'pdf-to-jpg'
  | 'image-to-pdf'
  | 'office-to-pdf'
  | 'merge-pdf'
  | 'split-pdf'
  | 'unlock'
  | 'watermark'
  | 'pagenumber'
  | 'pdf-ocr';

export type ApiTool =
  | 'compress'
  | 'pdfjpg'
  | 'imagepdf'
  | 'officepdf'
  | 'merge'
  | 'split'
  | 'unlock'
  | 'watermark'
  | 'pagenumber'
  | 'pdfocr';

// ---------------------------------------------------------------------------
// Operation specification
// ---------------------------------------------------------------------------

/**
 * Complete specification for a single PDF operation.
 * All 10 operations are described in `domain/operations.ts` as
 * `OPERATIONS: Record<OperationName, OperationSpec>`.
 */
export interface OperationSpec {
  readonly name: OperationName;
  readonly apiTool: ApiTool;
  /** Human-readable label for the operation */
  readonly label: string;
  /** One-line capability summary used in the tool description */
  readonly description: string;
  /** Accepted file extensions for this operation (used for input validation) */
  readonly acceptedExtensions: readonly string[];
  /** Default options merged with user-supplied options before /api/process */
  readonly defaultOptions: Readonly<Record<string, unknown>>;
  /**
   * True when this operation needs all files uploaded into a SINGLE shared task
   * (merge-pdf, image-to-pdf) rather than a task per file.
   */
  readonly requiresSharedTask: boolean;
  /**
   * True when this operation MUST be the first (and only) operation on the file
   * and cannot be chained via a connected task. Currently: unlock.
   */
  readonly mustBeDirect: boolean;
  /**
   * Zod schema for per-tool options validation. Defined concretely in
   * `contract/options-schema.ts`; typed as the abstract ZodType here
   * to keep this module free of runtime Zod imports.
   */
  readonly optionsSchema: z.ZodType;
  /**
   * When `true`, iLovePDF returns the output as a single ZIP archive (e.g.
   * `split-pdf` and `pdf-to-jpg`). `deriveOutputFilename` in `lib/file-io.ts`
   * reads this flag as the SINGLE SOURCE OF TRUTH for the `.zip` extension
   * decision — no slug literals are hardcoded elsewhere.
   */
  readonly producesArchive?: boolean;
  /**
   * DEC-1 override hook: explicit MCP tool name. When omitted, the tool name is
   * derived mechanically as `ilovepdf_` + `name` with `-` replaced by `_`.
   * Unused in v1; reserved for future name overrides.
   */
  readonly toolName?: string;
}
