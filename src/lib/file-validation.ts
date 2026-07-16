/**
 * lib/file-validation.ts
 *
 * Pure input-validation helpers for the headless MCP server (FIO-7, OPS-3).
 *
 * Rewritten from ../openai-app/mcp-server/src/lib/file-validation.ts. The old
 * module coupled validation to the widget upload flow via `downloadAndUploadFile`
 * (URL fetch + iLovePDF binary upload). That concern is handled elsewhere in the
 * headless design (core/upload-service.ts), so it is DROPPED here.
 *
 * What remains are two side-effect-free guards, both throwing typed ToolError
 * instances (AD-8 / ERR-2) so callers get a stable ErrorCode:
 *   - validateExtension(filename, acceptedExtensions) → UNSUPPORTED_EXTENSION
 *   - validateSize(bytes, maxMB)                       → VALIDATION_ERROR
 *
 * `acceptedExtensions` is registry-driven: callers pass the per-operation list
 * from OPERATIONS[...].acceptedExtensions (domain/operations.ts).
 */

import { ToolError } from '../domain/errors.js';

/**
 * Extracts the lowercase extension (including the leading dot) from a filename.
 * Returns an empty string when the name has no extension.
 */
function extensionOf(filename: string): string {
  const dot = filename.lastIndexOf('.');
  if (dot <= 0) return '';
  return filename.slice(dot).toLowerCase();
}

/**
 * Asserts that `filename` carries an extension present in `acceptedExtensions`.
 *
 * The match is case-insensitive on both sides, so `Report.PDF` satisfies
 * `['.pdf']` and `photo.png` satisfies `['.PNG']`.
 *
 * @throws ToolError('UNSUPPORTED_EXTENSION') when the extension is missing or
 *         not in the accepted list.
 */
export function validateExtension(
  filename: string,
  acceptedExtensions: readonly string[]
): void {
  const ext = extensionOf(filename);
  const accepted = acceptedExtensions.map(e => e.toLowerCase());

  if (!ext || !accepted.includes(ext)) {
    throw new ToolError(
      'UNSUPPORTED_EXTENSION',
      `File "${filename}" has extension "${ext || '(none)'}", which is not accepted. Accepted: ${acceptedExtensions.join(', ')}.`,
      `Unsupported file type. This operation accepts: ${acceptedExtensions.join(', ')}.`,
      false
    );
  }
}

/**
 * Asserts that a file of `bytes` bytes does not exceed `maxMB` megabytes.
 *
 * @throws ToolError('VALIDATION_ERROR') when the size is over the limit.
 */
export function validateSize(bytes: number, maxMB: number): void {
  const maxBytes = maxMB * 1024 * 1024;

  if (bytes > maxBytes) {
    const actualMB = (bytes / (1024 * 1024)).toFixed(2);
    throw new ToolError(
      'VALIDATION_ERROR',
      `File size ${actualMB}MB exceeds the maximum allowed size of ${maxMB}MB.`,
      `File is too large (${actualMB}MB). The maximum allowed size is ${maxMB}MB.`,
      false
    );
  }
}
