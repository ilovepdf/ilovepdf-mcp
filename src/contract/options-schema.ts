/**
 * contract/options-schema.ts
 *
 * Per-operation Zod schemas for tool-specific options (AD-6, OPS-4, TOOL-3).
 *
 * Each schema is defined ONCE here and referenced by the operations registry
 * (`OPTIONS_SCHEMAS[name]`) and the tool input-shape builder. The MCP SDK
 * derives the JSON Schema advertised to clients directly from these Zod
 * schemas, so the hand-written `optionsJsonSchema` from the widget server is
 * DROPPED in this headless port.
 *
 * NOTE: All fields are optional at the schema level. Required-for-processing
 *       fields are enforced downstream (Zod/upstream), not here. Schemas use
 *       `.passthrough()` so unknown keys survive for forward-compat with the
 *       iLovePDF API; only KNOWN fields with the wrong type/enum are rejected.
 *
 * Ported from ../openai-app/mcp-server/src/contract/options-schema.ts.
 */

import { z } from 'zod';
import type { OperationName } from '../domain/operation-types.js';
import { ToolError } from '../domain/errors.js';

// ---------------------------------------------------------------------------
// Shared font list — single source of truth for watermark & pagenumber
// ---------------------------------------------------------------------------

/**
 * Exact font_family values accepted by the iLovePDF API.
 * Consumed by option normalization (fuzzy-match) and tool descriptions.
 */
export const VALID_FONT_FAMILIES = [
  'Arial',
  'Arial Unicode MS',
  'Verdana',
  'Courier',
  'Times New Roman',
  'Comic Sans MS',
  'WenQuanYi Zen Hei',
  'Lohit Marathi',
] as const;

export type ValidFontFamily = (typeof VALID_FONT_FAMILIES)[number];

// ---------------------------------------------------------------------------
// compress-pdf
// ---------------------------------------------------------------------------

export const compressOptionsSchema = z
  .object({
    compression_level: z
      .string()
      .optional()
      .describe(
        'Compression aggressiveness. Accepted: "recommended", "extreme", "low". ' +
          'Similar values are auto-normalized (e.g. "high" → "extreme", "none" → "low"). Default: "recommended".'
      ),
  })
  .passthrough();

export type CompressOptions = z.infer<typeof compressOptionsSchema>;

// ---------------------------------------------------------------------------
// pdf-to-jpg
// ---------------------------------------------------------------------------

export const pdfToJpgOptionsSchema = z
  .object({
    pdfjpg_mode: z
      .string()
      .optional()
      .describe(
        '"pages" converts each page to an image; "extract" extracts embedded images. ' +
          'Similar values are auto-normalized (e.g. "page" → "pages"). Default: "pages".'
      ),
    quality: z
      .string()
      .optional()
      .describe(
        'Output image quality. "Normal" = 150 dpi, "High" = 300 dpi. ' +
          'Case-insensitive (e.g. "normal" → "Normal"). Omit for the iLovePDF default.'
      ),
  })
  .passthrough();

export type PdfToJpgOptions = z.infer<typeof pdfToJpgOptionsSchema>;

/**
 * Quality → dpi mapping for pdf-to-jpg. Single source of truth for the
 * iLovePDF-specific magic numbers.
 *
 * iLovePDF `pdfjpg` honors `dpi` (verified: 150 ≈ normal, 300 ≈ high); an
 * empty/absent value means "use the iLovePDF default". iLovePDF silently drops
 * unknown params, so the exact `dpi` key/value produced here is load-bearing.
 */
export const QUALITY_TO_DPI = {
  Normal: 150,
  High: 300,
} as const;

export type PdfToJpgQuality = keyof typeof QUALITY_TO_DPI;

/** Returns the dpi for a quality label, or undefined when absent/empty/invalid. */
export function qualityToDpi(quality: unknown): number | undefined {
  if (!quality) return undefined;
  return QUALITY_TO_DPI[quality as PdfToJpgQuality];
}

/**
 * Normalizes pdf-to-jpg quality into iLovePDF's dpi param IN PLACE:
 * sets options.dpi (150/300) when a valid quality is present, and ALWAYS
 * removes options.quality (iLovePDF silently drops unknown params, so it
 * must never reach the process body). Returns the applied quality for echo.
 */
export function applyPdfjpgQuality(
  options: Record<string, unknown>
): 'Normal' | 'High' | undefined {
  const dpi = qualityToDpi(options.quality);
  if (dpi !== undefined) {
    options.dpi = dpi;
  }
  const applied =
    options.quality === 'Normal' || options.quality === 'High'
      ? options.quality
      : undefined;
  delete options.quality;
  return applied;
}

// ---------------------------------------------------------------------------
// image-to-pdf
// ---------------------------------------------------------------------------

export const imageToPdfOptionsSchema = z
  .object({
    merge_after: z
      .union([z.boolean(), z.string(), z.number()])
      .optional()
      .describe(
        'true = merge all images into one PDF (default); false = one PDF per image. Accepts boolean or "true"/"false" strings.'
      ),
    orientation: z
      .string()
      .optional()
      .describe('Page orientation. Default: "portrait". Accepts: portrait, landscape. Similar values are auto-normalized.'),
    margin: z
      .number()
      .optional()
      .describe('Page margin in pixels. Default: 0. Values below 0 are clamped to 0; values above 100 are clamped to 100.'),
    pagesize: z
      .string()
      .optional()
      .describe('Output page size. Default: "fit". Accepts: fit, A4, letter. Unknown values are normalized to "fit".'),
  })
  .passthrough();

export type ImageToPdfOptions = z.infer<typeof imageToPdfOptionsSchema>;

// ---------------------------------------------------------------------------
// office-to-pdf
// ---------------------------------------------------------------------------

export const officeToPdfOptionsSchema = z.object({}).passthrough();

export type OfficeToPdfOptions = z.infer<typeof officeToPdfOptionsSchema>;

// ---------------------------------------------------------------------------
// merge-pdf
// ---------------------------------------------------------------------------

export const mergePdfOptionsSchema = z.object({}).passthrough();

export type MergePdfOptions = z.infer<typeof mergePdfOptionsSchema>;

// ---------------------------------------------------------------------------
// split-pdf
//
// split_mode is the primary discriminant. "first" and "last" keywords are valid
// in ranges (e.g., "1-last", "first-5").
// ---------------------------------------------------------------------------

export const splitOptionsSchema = z
  .object({
    split_mode: z
      .string()
      .optional()
      .describe('Splitting mode. REQUIRED for processing. Accepts: fixed_range, ranges, remove_pages, filesize. Unknown values are normalized to "ranges".'),
    fixed_range: z
      .number()
      .optional()
      .describe(
        'Pages per chunk when split_mode="fixed_range". Use 1 for individual pages. Values below 1 are clamped to 1. "last page" is not valid in this mode.'
      ),
    ranges: z
      .string()
      .optional()
      .describe(
        'Page ranges when split_mode="ranges". E.g., "1-3,4-6,7-end". ' +
          '"first" and "last" keywords are valid (e.g., "first-5", "6-last").'
      ),
    remove_pages: z
      .string()
      .optional()
      .describe(
        'Pages to remove when split_mode="remove_pages". E.g., "2,5,8-12". "last page" is not supported and should be omitted.'
      ),
    merge_after: z
      .boolean()
      .optional()
      .describe(
        'Merge all ranges into one PDF after splitting. Only takes effect when split_mode is "ranges". Default: false.'
      ),
  })
  .passthrough();

export type SplitOptions = z.infer<typeof splitOptionsSchema>;

// ---------------------------------------------------------------------------
// unlock
// ---------------------------------------------------------------------------

export const unlockOptionsSchema = z
  .object({
    password: z
      .string()
      .optional()
      .describe('The PDF password to remove. REQUIRED for processing.'),
  })
  .passthrough();

export type UnlockOptions = z.infer<typeof unlockOptionsSchema>;

// ---------------------------------------------------------------------------
// watermark
// ---------------------------------------------------------------------------

export const watermarkOptionsSchema = z
  .object({
    text: z
      .string()
      .optional()
      .describe('Watermark text content. REQUIRED when mode is "text".'),
    mode: z
      .string()
      .optional()
      .describe('"text" (default) or "image" watermark mode. Similar values auto-normalized (e.g. "texto" → "text", "img" → "image").'),
    font_family: z
      .string()
      .optional()
      .describe(
        'Font family. Accepted: Arial, Arial Unicode MS, Verdana, Courier, Times New Roman, Comic Sans MS, WenQuanYi Zen Hei, Lohit Marathi. Similar fonts are auto-matched.'
      ),
    font_size: z.number().min(0).optional(),
    font_color: z
      .string()
      .optional()
      .describe('CSS hex color, e.g. "#FF0000".'),
    font_style: z
      .string()
      .nullable()
      .optional()
      .describe('Font style. Accepted: null (Regular), Bold, Italic. Unknown values are normalized to null.'),
    transparency: z
      .number()
      .min(1)
      .max(100)
      .optional()
      .describe('Transparency 1–100. 1 = almost transparent, 100 = fully opaque.'),
    rotation: z.number().optional().describe('Rotation in degrees.'),
    layer: z
      .string()
      .optional()
      .describe('Place watermark above or below content. Accepted: "above", "below". Similar values auto-normalized (e.g. "encima" → "above", "abajo" → "below").'),
    mosaic: z
      .boolean()
      .optional()
      .describe('Tile the watermark across the full page.'),
    image_source: z
      .string()
      .optional()
      .describe(
        'Path or URL of the JPG or PNG image to use as watermark. Required when mode is "image".'
      ),
    vertical_position: z.string().optional().describe('Vertical position: top, middle, or bottom. Similar values auto-matched (e.g. "arriba" → "top").'),
    horizontal_position: z.string().optional().describe('Horizontal position: left, center, or right. Similar values auto-matched (e.g. "izquierda" → "left").'),
    pages: z
      .string()
      .optional()
      .describe(
        'Pages to watermark. Default: "all". Excluding only the last page is not supported by iLovePDF.'
      ),
  })
  .passthrough();

export type WatermarkOptions = z.infer<typeof watermarkOptionsSchema>;

// ---------------------------------------------------------------------------
// pagenumber
// ---------------------------------------------------------------------------

export const pagenumberOptionsSchema = z
  .object({
    pages: z
      .string()
      .optional()
      .describe(
        'Which pages to number. E.g., "all", "3-end", "1-5". Default: "all". Excluding only the last page is not supported by iLovePDF.'
      ),
    starting_number: z
      .number()
      .int()
      .optional()
      .describe('Displayed number on the first numbered page. Default: 1. Values below 1 are clamped to 1.'),
    text: z
      .string()
      .optional()
      .describe(
        'Custom format string. Valid placeholders: {n} (current page), {p} (total pages).'
      ),
    first_cover: z
      .boolean()
      .optional()
      .describe('true to skip numbering on page 1 (cover page).'),
    vertical_position: z
      .string()
      .optional()
      .describe(
        'Vertical position: top or bottom only (middle/center not supported by API, will use bottom). Similar values auto-matched.'
      ),
    horizontal_position: z
      .string()
      .optional()
      .describe(
        'Horizontal position: left, center, or right. Similar values auto-matched.'
      ),
    font_family: z
      .string()
      .optional()
      .describe(
        'Font family. Supported: Arial, Arial Unicode MS, Verdana, Courier, Times New Roman, Comic Sans MS, WenQuanYi Zen Hei, Lohit Marathi. Similar fonts are auto-matched (e.g. "times" → "Times New Roman").'
      ),
    font_size: z.number().min(0).optional(),
    font_color: z.string().optional(),
    facing_pages: z
      .boolean()
      .optional()
      .describe(
        'true to use facing-page numbering (book-style): odd pages show the number on the right, even pages on the left. Default: false.'
      ),
  })
  .passthrough();

export type PagenumberOptions = z.infer<typeof pagenumberOptionsSchema>;

// ---------------------------------------------------------------------------
// pdf-ocr
// ---------------------------------------------------------------------------

export const pdfOcrOptionsSchema = z
  .object({
    ocr_languages: z
      .array(z.string())
      .optional()
      .describe(
        'OCR language codes. E.g., ["eng"], ["spa", "eng"]. Default: ["eng"]. ' +
          'Full list: eng, afr, amh, ara, asm, aze, bel, ben, bod, bos, bul, ' +
          'cat, ces, chi_sim, chi_tra, dan, deu, ell, epo, est, eus, fas, fil, ' +
          'fin, fra, gla, gle, glg, guj, heb, hin, hrv, hun, hye, ind, isl, ita, ' +
          'jpn, kan, kat, kaz, khm, kor, lao, lat, lav, lit, mal, mar, mkd, mlt, ' +
          'mon, msa, mya, nep, nld, nor, pan, pol, por, ron, rus, sin, slk, slv, ' +
          'spa, sqi, srp, swa, swe, tam, tel, tgl, tha, tur, ukr, urd, vie, yid'
      ),
  })
  .passthrough();

export type PdfOcrOptions = z.infer<typeof pdfOcrOptionsSchema>;

// ---------------------------------------------------------------------------
// OPTIONS_SCHEMAS map — keyed by OperationName
// ---------------------------------------------------------------------------

/**
 * Map from OperationName to its Zod options schema.
 *
 * Usage:
 *   import { OPTIONS_SCHEMAS } from '../contract/options-schema.js';
 *   const schema = OPTIONS_SCHEMAS['compress-pdf'];
 *   const result = schema.safeParse(rawOptions);
 */
export const OPTIONS_SCHEMAS: Record<OperationName, z.ZodTypeAny> = {
  'compress-pdf': compressOptionsSchema,
  'pdf-to-jpg': pdfToJpgOptionsSchema,
  'image-to-pdf': imageToPdfOptionsSchema,
  'office-to-pdf': officeToPdfOptionsSchema,
  'merge-pdf': mergePdfOptionsSchema,
  'split-pdf': splitOptionsSchema,
  'unlock': unlockOptionsSchema,
  'watermark': watermarkOptionsSchema,
  'pagenumber': pagenumberOptionsSchema,
  'pdf-ocr': pdfOcrOptionsSchema,
};

// ---------------------------------------------------------------------------
// Runtime options validation — throws ToolError('VALIDATION_ERROR') on failure
// ---------------------------------------------------------------------------

/**
 * Validate raw `options` against the operation-specific Zod schema.
 *
 * No-op when there is nothing to validate (no tool, no options, or an unknown
 * tool — the input schema already rejects unknown tools). Otherwise, on a Zod
 * failure it throws `ToolError('VALIDATION_ERROR', …)` so the tool handler can
 * surface a typed, non-retryable validation failure.
 *
 * The schemas are `.passthrough()`, so only KNOWN fields with the wrong type
 * are rejected; unknown fields pass through for forward-compat.
 */
export function validateOptions(
  toolName: string | undefined,
  options: unknown
): void {
  if (!toolName || options == null || !(toolName in OPTIONS_SCHEMAS)) {
    return;
  }
  const result = OPTIONS_SCHEMAS[toolName as OperationName].safeParse(options);
  if (result.success) return;

  const detail = result.error.issues.map(i => i.message).join('; ');
  throw new ToolError(
    'VALIDATION_ERROR',
    `Invalid options for "${toolName}": ${detail}`,
    'Some of the provided options are invalid. Please check them and try again.',
    false
  );
}
