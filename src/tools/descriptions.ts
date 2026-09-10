/**
 * tools/descriptions.ts
 *
 * Client-agnostic MCP tool descriptions, one per operation (TOOL-7).
 *
 * REPLACES the old ChatGPT-widget descriptions
 * (../openai-app/mcp-server/src/contract/descriptions/*.md.ts), which assumed a
 * rendered widget UX ("one call opens the widget", "collect params in chat",
 * attachment/upload routing). This headless server exposes ONE result-returning
 * tool per operation to generic MCP clients, so each description is:
 *   - SHORT (a single capability sentence + an input hint),
 *   - client-agnostic (no widget/ChatGPT/Skybridge wording), and
 *   - explicit about input semantics: inputs are LOCAL FILE PATHS or URLs.
 *
 * Descriptions are keyed by OperationName and validated against the registry so
 * a new op cannot ship without one.
 */

import type { OperationName } from '../domain/operation-types.js';
import { specFor } from '../domain/operations.js';

// ---------------------------------------------------------------------------
// Per-operation capability lines (client-agnostic, no widget language)
// ---------------------------------------------------------------------------

/**
 * One short capability sentence per op. The input-source clause is appended
 * uniformly by `describeTool`, so these stay focused on WHAT each op does.
 */
const CAPABILITY: Record<OperationName, string> = {
  'compress-pdf': 'Reduce the file size of a PDF while preserving quality.',
  'pdf-to-jpg': 'Convert the pages of a PDF into JPG images.',
  'image-to-pdf': 'Convert one or more images (JPG, PNG, TIFF) into a single PDF.',
  'office-to-pdf': 'Convert a Word, Excel, or PowerPoint document into a PDF.',
  'merge-pdf': 'Combine several PDFs into one merged PDF.',
  'split-pdf': 'Split a PDF into multiple files by page range or fixed chunks.',
  // 'unlock': 'Remove a known password from a protected PDF.', // TEMPORARILY DISABLED — re-enable to publish.
  'watermark': 'Stamp a text or image watermark onto a PDF.',
  'pagenumber': 'Add page numbers to a PDF.',
  'pdf-ocr': 'Run OCR on a scanned PDF to make its text selectable and searchable.',
};

// ---------------------------------------------------------------------------
// Input-source clause — the local-file/URL semantics of this headless server
// ---------------------------------------------------------------------------

/**
 * Ops that accept multiple input files (shared-task orchestration) get a plural
 * hint; the rest read a single input.
 */
function inputClause(op: OperationName): string {
  const plural = specFor(op).requiresSharedTask;
  return plural
    ? 'Inputs are provided as local file paths or URLs; the result is written to a local file path.'
    : 'Input is provided as a local file path or URL; the result is written to a local file path.';
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Returns the short, client-agnostic description for an operation's MCP tool.
 * Combines the op's capability sentence with the uniform local-file/URL input
 * clause. Throws if called with an op that has no capability line (guards
 * against a registry op shipping without a description).
 */
export function describeTool(op: OperationName): string {
  const capability = CAPABILITY[op];
  if (!capability) {
    throw new Error(`No description defined for operation "${op}".`);
  }
  return `${capability} ${inputClause(op)}`;
}
