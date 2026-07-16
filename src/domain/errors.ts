/**
 * domain/errors.ts
 *
 * Single error model for the MCP server (AD-8).
 *
 * Replaces the ad-hoc string errors scattered across the source tools and
 * server. All error surfaces become typed ToolError instances with a stable
 * ErrorCode.
 *
 * Ported from ../openai-app/mcp-server/src/domain/errors.ts and adapted for the
 * headless stdio server (ERR-2): widget/OpenAI-only codes dropped, local
 * filesystem + config codes added.
 *
 * Usage:
 *   throw new ToolError('UPLOAD_FAILED', err.message, 'Upload failed. Please try again.', true);
 *
 * The response-builder maps ToolError → a flat failure payload
 * { success:false, error_code, error, detail, retryable }.
 */

// ---------------------------------------------------------------------------
// ErrorCode set (authoritative — ERR-2)
// ---------------------------------------------------------------------------

/**
 * All error codes emitted by the headless MCP server.
 *
 * The union type is derived from this array so the exact set can be asserted
 * at runtime by the test suite.
 *
 * - UPLOAD_FAILED           File upload to iLovePDF servers failed.
 * - PROCESS_FAILED          iLovePDF /process call failed.
 * - AUTH_FAILED             Authentication / re-auth retry failed.
 * - UNSUPPORTED_EXTENSION   File extension rejected for the requested operation.
 * - UPSTREAM_ERROR          iLovePDF API returned an unexpected error.
 * - VALIDATION_ERROR        Input did not pass Zod schema validation.
 * - INTERNAL                Unexpected server-side error with no more-specific code.
 * - TASK_ALREADY_PROCESSED  Idempotency guard fired: task was already processed (AD-3).
 * - FILE_ACCESS_DENIED      Local path fell outside the configured allowlist.
 * - FILE_NOT_FOUND          Requested local input file does not exist.
 * - CONFIG_ERROR            Required configuration/env (e.g. ILOVEPDF_PUBLIC_KEY) is missing or invalid.
 */
export const ERROR_CODES = [
  'UPLOAD_FAILED',
  'PROCESS_FAILED',
  'AUTH_FAILED',
  'UNSUPPORTED_EXTENSION',
  'UPSTREAM_ERROR',
  'VALIDATION_ERROR',
  'INTERNAL',
  'TASK_ALREADY_PROCESSED',
  'FILE_ACCESS_DENIED',
  'FILE_NOT_FOUND',
  'CONFIG_ERROR',
] as const;

export type ErrorCode = (typeof ERROR_CODES)[number];

// ---------------------------------------------------------------------------
// ToolError class
// ---------------------------------------------------------------------------

/**
 * Typed error for all MCP server error paths.
 *
 * Fields:
 *   code         Machine-readable ErrorCode (stable; used by response-builder and tests).
 *   message      Internal diagnostic message (not shown to users; may contain raw API text).
 *   userMessage  Human-readable message safe to surface to the client.
 *   retryable    Whether the caller can safely retry the same operation without changes.
 */
export class ToolError extends Error {
  constructor(
    readonly code: ErrorCode,
    message: string,
    readonly userMessage: string,
    readonly retryable: boolean = false
  ) {
    super(message);
    this.name = 'ToolError';

    // Maintain proper prototype chain for instanceof checks across TypeScript transpilation.
    Object.setPrototypeOf(this, new.target.prototype);
  }

  /**
   * Returns a structured error payload suitable for inclusion in a tool
   * result when the call cannot succeed.
   *
   * Shape matches the output contract (flat):
   *   { success: false, error_code, error, detail, retryable }
   */
  toStructured(): {
    success: false;
    error_code: ErrorCode;
    error: string;
    detail: string;
    retryable: boolean;
  } {
    return {
      success: false,
      error_code: this.code,
      error: this.userMessage,
      detail: this.message,
      retryable: this.retryable,
    };
  }
}

// ---------------------------------------------------------------------------
// Type guard
// ---------------------------------------------------------------------------

/** Returns true if `value` is a ToolError instance. */
export const isToolError = (value: unknown): value is ToolError =>
  value instanceof ToolError;
