/**
 * domain/operations.ts
 *
 * SINGLE SOURCE OF TRUTH for all 10 PDF operations (AD-5, OPS-1..OPS-7).
 *
 * Every other module derives its operation data from this registry via the
 * helper functions at the bottom of the file (`specFor`, `apiToolFor`,
 * `OPERATION_NAMES`). No apiTool slug is hardcoded anywhere else in the tree.
 *
 * Ported from ../openai-app/mcp-server/src/domain/operations.ts. This headless
 * port DROPS all widget-specific concepts:
 *   - the `widgetParams` block on every operation,
 *   - the `TOOL_TO_API_MAP` compatibility map,
 *   - the `ilovepdf` wildcard entry (compress) that the Worker dispatcher needed.
 * The `requiresSharedTask` and `mustBeDirect` flags are RETAINED — they describe
 * iLovePDF API orchestration behavior, not widget UX.
 */

import type {
  OperationName,
  ApiTool,
  OperationSpec,
} from './operation-types.js';
export type { OperationName, ApiTool, OperationSpec } from './operation-types.js';

import { OPTIONS_SCHEMAS } from '../contract/options-schema.js';

// ---------------------------------------------------------------------------
// OPERATIONS registry
// ---------------------------------------------------------------------------

export const OPERATIONS = {
  'compress-pdf': {
    name: 'compress-pdf',
    apiTool: 'compress',
    label: 'Compress PDF',
    description: 'Reduce PDF file size while preserving quality.',
    acceptedExtensions: ['.pdf'],
    defaultOptions: { compression_level: 'recommended' },
    requiresSharedTask: false,
    mustBeDirect: false,
    optionsSchema: OPTIONS_SCHEMAS['compress-pdf'],
  },

  'pdf-to-jpg': {
    name: 'pdf-to-jpg',
    apiTool: 'pdfjpg',
    label: 'PDF to JPG',
    description: 'Convert PDF pages to JPEG images.',
    acceptedExtensions: ['.pdf'],
    defaultOptions: { pdfjpg_mode: 'pages' },
    requiresSharedTask: false,
    mustBeDirect: false,
    producesArchive: true,
    optionsSchema: OPTIONS_SCHEMAS['pdf-to-jpg'],
  },

  'image-to-pdf': {
    name: 'image-to-pdf',
    apiTool: 'imagepdf',
    label: 'Image to PDF',
    description: 'Convert one or more images (JPG, PNG, TIFF) into a single PDF.',
    acceptedExtensions: ['.jpg', '.jpeg', '.png', '.tif', '.tiff'],
    defaultOptions: {
      orientation: 'portrait',
      margin: 0,
      pagesize: 'fit',
      merge_after: true,
    },
    // minSources=1, maxSources omitted → accepts one or more images (unbounded).
    minSources: 1,
    requiresSharedTask: true,
    mustBeDirect: false,
    optionsSchema: OPTIONS_SCHEMAS['image-to-pdf'],
  },

  'office-to-pdf': {
    name: 'office-to-pdf',
    apiTool: 'officepdf',
    label: 'Office to PDF',
    description: 'Convert Word, Excel, and PowerPoint files to PDF.',
    acceptedExtensions: ['.doc', '.docx', '.xls', '.xlsx', '.ppt', '.pptx'],
    defaultOptions: {},
    requiresSharedTask: false,
    mustBeDirect: false,
    optionsSchema: OPTIONS_SCHEMAS['office-to-pdf'],
  },

  'merge-pdf': {
    name: 'merge-pdf',
    apiTool: 'merge',
    label: 'Merge PDF',
    description: 'Combine multiple PDF files into one.',
    acceptedExtensions: ['.pdf'],
    defaultOptions: {},
    // minSources=2, maxSources omitted → requires at least two PDFs (unbounded max).
    minSources: 2,
    requiresSharedTask: true,
    mustBeDirect: false,
    optionsSchema: OPTIONS_SCHEMAS['merge-pdf'],
  },

  'split-pdf': {
    name: 'split-pdf',
    apiTool: 'split',
    label: 'Split PDF',
    description:
      'Split a PDF into multiple files by page range or fixed chunks.',
    acceptedExtensions: ['.pdf'],
    defaultOptions: {},
    requiresSharedTask: false,
    mustBeDirect: false,
    producesArchive: true,
    optionsSchema: OPTIONS_SCHEMAS['split-pdf'],
  },

  /*
   * TEMPORARILY DISABLED — the `unlock` tool is commented out and no longer
   * registered/exposed. All logic is preserved; uncomment this block (and the
   * matching entries in operation-types.ts, options-schema.ts,
   * option-normalizer.ts, result-builder.ts, descriptions.ts, and
   * ilovepdf-api.ts) to re-enable and publish it.
   *
   * 'unlock': {
   *   name: 'unlock',
   *   apiTool: 'unlock',
   *   label: 'Unlock PDF',
   *   description: 'Remove a known password from a PDF.',
   *   acceptedExtensions: ['.pdf'],
   *   defaultOptions: {},
   *   requiresSharedTask: false,
   *   mustBeDirect: true,
   *   optionsSchema: OPTIONS_SCHEMAS['unlock'],
   * },
   */

  'watermark': {
    name: 'watermark',
    apiTool: 'watermark',
    label: 'Add Watermark',
    description: 'Add a text or image watermark to a PDF.',
    acceptedExtensions: ['.pdf'],
    defaultOptions: { mode: 'text' },
    requiresSharedTask: false,
    mustBeDirect: false,
    optionsSchema: OPTIONS_SCHEMAS['watermark'],
  },

  'pagenumber': {
    name: 'pagenumber',
    apiTool: 'pagenumber',
    label: 'Add Page Numbers',
    description: 'Add page numbers to a PDF.',
    acceptedExtensions: ['.pdf'],
    defaultOptions: {},
    requiresSharedTask: false,
    mustBeDirect: false,
    optionsSchema: OPTIONS_SCHEMAS['pagenumber'],
  },

  'pdf-ocr': {
    name: 'pdf-ocr',
    apiTool: 'pdfocr',
    label: 'OCR PDF',
    description: 'Extract text from scanned PDFs using OCR.',
    acceptedExtensions: ['.pdf'],
    defaultOptions: { ocr_languages: ['eng'] },
    requiresSharedTask: false,
    mustBeDirect: false,
    optionsSchema: OPTIONS_SCHEMAS['pdf-ocr'],
  },
} as const satisfies Record<OperationName, OperationSpec>;

// ---------------------------------------------------------------------------
// Helper functions
// ---------------------------------------------------------------------------

/** Returns the full OperationSpec for a given operation name. */
export const specFor = (n: OperationName): OperationSpec => OPERATIONS[n];

/** Returns the iLovePDF API tool slug for a given operation name. */
export const apiToolFor = (n: OperationName): ApiTool => OPERATIONS[n].apiTool;

/** Ordered list of all supported operation names. */
export const OPERATION_NAMES = Object.keys(OPERATIONS) as OperationName[];
