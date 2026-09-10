/**
 * core/option-normalizer.ts
 *
 * Pure option normalizer relocated from the Worker `/api/process` handler
 * (DEC-2). Source: ../openai-app/mcp-server/src/services/option-normalizer.ts.
 *
 * In the Worker, this logic ran server-side before `/api/process` dispatched to
 * iLovePDF so the corrections and warnings surfaced in the structuredContent the
 * LLM read. In the headless MCP server it is applied in the tool handler AFTER
 * defaults are merged and BEFORE `execute`, so every caller (not just the widget)
 * gets the same corrections and the behaviour never regresses.
 *
 * The corrections it applies:
 *   (1) split ranges — the `end` keyword becomes `9999` and single pages expand
 *       to self-ranges (e.g. "2" → "2-2");
 *   (2) font fuzzy-match against VALID_FONT_FAMILIES (the shared font list in
 *       contract/options-schema.ts), falling back to "Arial Unicode MS";
 *   (3) watermark/pagenumber position mapping (vertical/horizontal synonyms →
 *       the exact values the iLovePDF API accepts).
 *
 * PURE: never mutates the input; always returns a fresh options object plus the
 * warnings collected while normalizing. Idempotent — running already-valid
 * options through it is a no-op, so it is safe to call as a backstop.
 */

import type { OperationName } from '../domain/operation-types.js';
import { VALID_FONT_FAMILIES } from '../contract/options-schema.js';

export interface NormalizationResult {
  options: Record<string, unknown>;
  warnings: string[];
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

// Shared with the contract layer so the font list has a single source of truth.
const VALID_FONTS: readonly string[] = VALID_FONT_FAMILIES;

const VALID_SPLIT_MODES = ['ranges', 'fixed_range', 'remove_pages', 'filesize'];

// Operations that need no normalization — short-circuit immediately.
const NO_OP_TOOLS = new Set<OperationName>([
  'compress-pdf',
  'pdf-to-jpg',
  'office-to-pdf',
  'merge-pdf',
  // 'unlock', // TEMPORARILY DISABLED — unlock tool commented out; re-enable to publish.
  'pdf-ocr',
]);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function normalizeFontFamily(supplied: string): {
  value: string;
  warning?: string;
} {
  const suppliedLower = supplied.toLowerCase().trim();

  const exactMatch = VALID_FONTS.find(f => f.toLowerCase() === suppliedLower);
  if (exactMatch) return { value: exactMatch };

  const partialMatch = VALID_FONTS.find(font => {
    const fl = font.toLowerCase();
    return fl.includes(suppliedLower) || suppliedLower.includes(fl);
  });
  if (partialMatch) return { value: partialMatch };

  return {
    value: 'Arial Unicode MS',
    warning: `Font '${supplied}' is not supported. Using Arial Unicode MS.`,
  };
}

function normalizeVerticalPosition(
  supplied: string,
  toolName: OperationName
): { value: string; warning?: string } {
  const s = supplied.toLowerCase().trim();

  if (['top', 'arriba', 'superior', 'up'].some(v => s.includes(v))) {
    return { value: 'top' };
  }

  if (
    ['middle', 'center', 'centro', 'centrado', 'medio'].some(v => s.includes(v))
  ) {
    if (toolName === 'watermark') return { value: 'middle' };
    return {
      value: 'bottom',
      warning:
        'Vertical centering is not supported for pagenumber. Using bottom position instead.',
    };
  }

  if (['bottom', 'abajo', 'inferior', 'down'].some(v => s.includes(v))) {
    return { value: 'bottom' };
  }

  // Unrecognized
  if (toolName === 'watermark') return { value: 'middle' };
  return {
    value: 'bottom',
    warning: `Vertical position '${supplied}' was not recognized. Using bottom.`,
  };
}

function normalizeHorizontalPosition(supplied: string): string {
  const s = supplied.toLowerCase().trim();
  if (['left', 'izquierda', 'izq'].some(v => s.includes(v))) return 'left';
  if (['center', 'centro', 'centrado', 'middle'].some(v => s.includes(v)))
    return 'center';
  if (['right', 'derecha', 'der'].some(v => s.includes(v))) return 'right';
  return 'center';
}

function normalizeBoolean(
  value: unknown,
  paramName: string
): { value: boolean; warning?: string } {
  if (typeof value === 'boolean') return { value };

  if (typeof value === 'string') {
    const s = value.toLowerCase().trim();
    if (['true', 'yes', 'sí', 'si', '1', 'on'].includes(s))
      return { value: true };
    if (['false', 'no', '0', 'off'].includes(s)) return { value: false };
  }

  if (typeof value === 'number') {
    if (value === 1) return { value: true };
    if (value === 0) return { value: false };
  }

  return {
    value: false,
    warning: `${paramName} value '${String(value)}' was not recognized as boolean. Using false.`,
  };
}

function normalizeColor(value: unknown): { value: string; warning?: string } {
  if (typeof value !== 'string') {
    return {
      value: '#000000',
      warning: `font_color must be a hex color string. Using #000000.`,
    };
  }
  const s = value.trim();

  if (/^#[0-9a-fA-F]{6}$/.test(s)) return { value: s.toUpperCase() };

  // #RGB → #RRGGBB
  if (/^#[0-9a-fA-F]{3}$/.test(s)) {
    return {
      value: `#${s[1]}${s[1]}${s[2]}${s[2]}${s[3]}${s[3]}`.toUpperCase(),
    };
  }

  // RRGGBB (no #)
  if (/^[0-9a-fA-F]{6}$/.test(s)) {
    return { value: `#${s}`.toUpperCase() };
  }

  // rgb(r,g,b)
  const rgbMatch = s.match(/^rgb\s*\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*\)$/i);
  if (rgbMatch) {
    const r = parseInt(rgbMatch[1], 10);
    const g = parseInt(rgbMatch[2], 10);
    const b = parseInt(rgbMatch[3], 10);
    if (r <= 255 && g <= 255 && b <= 255) {
      return {
        value:
          `#${r.toString(16).padStart(2, '0')}${g.toString(16).padStart(2, '0')}${b.toString(16).padStart(2, '0')}`.toUpperCase(),
      };
    }
  }

  return {
    value: '#000000',
    warning: `font_color '${s}' is not a valid hex color. Using #000000.`,
  };
}

function normalizeSplitRanges(input: string): string {
  return input
    .split(',')
    .map(segment => {
      const trimmed = segment.trim();
      if (/^\d+-\d+$/.test(trimmed)) return trimmed;
      if (/^\d+$/.test(trimmed)) return `${trimmed}-${trimmed}`;
      return trimmed;
    })
    .join(',');
}

function normalizeFontSize(
  value: unknown,
  fallback: number
): { value: number; warning?: string } {
  const num = Number(value);
  if (isNaN(num))
    return {
      value: fallback,
      warning: `font_size must be a number. Using ${fallback}.`,
    };
  if (num < 1)
    return {
      value: fallback,
      warning: `Font size must be ≥ 1. Using ${fallback}.`,
    };
  if (num > 100)
    return { value: 100, warning: 'Font size exceeds 100. Using 100.' };
  return { value: Math.trunc(num) };
}

function mentionsLastPage(rawValue: string): boolean {
  return /\b(last|final|ultima)(\s+page|\s+pagina)?\b/i.test(rawValue);
}

function stripUnsupportedLastPageFromSplitList(input: string): {
  value: string;
  removedLastPage: boolean;
} {
  const segments = input.split(',');
  const cleaned: string[] = [];
  let removedLastPage = false;

  for (const segment of segments) {
    const trimmed = segment.trim();
    if (!trimmed) continue;

    if (!mentionsLastPage(trimmed)) {
      cleaned.push(trimmed);
      continue;
    }

    removedLastPage = true;

    // Keep explicit numeric portions from mixed freeform text (e.g. "2 and last page").
    const numericTokens = trimmed.match(/\d+\s*-\s*\d+|\d+/g) ?? [];
    for (const token of numericTokens) {
      cleaned.push(token.replace(/\s+/g, ''));
    }
  }

  return {
    value: cleaned.join(','),
    removedLastPage,
  };
}

function requestsExcludeLastPage(rawPages: string): boolean {
  const s = rawPages.toLowerCase().trim();
  if (/\b1\s*-\s*-2\b/.test(s)) return true;
  if (!mentionsLastPage(s)) return false;

  return (
    /\b(all|todas?)\s+(except|excepto|without|sin|menos)\b/.test(s) ||
    /\b(exclude|excluding|skip|omit|without|except|excepto|sin|menos)\b/.test(s)
  );
}

// ---------------------------------------------------------------------------
// Main export
// ---------------------------------------------------------------------------

/**
 * Normalize per-operation options against iLovePDF API constraints.
 *
 * PURE: `rawOptions` is never mutated; a fresh object is always returned. The
 * `warnings` array reports every correction applied so the handler can surface
 * them to the caller.
 */
export function normalizeOptions(
  toolName: OperationName,
  rawOptions: Record<string, unknown>
): NormalizationResult {
  if (NO_OP_TOOLS.has(toolName)) {
    return { options: { ...rawOptions }, warnings: [] };
  }

  const options: Record<string, unknown> = { ...rawOptions };
  const warnings: string[] = [];

  // -------------------------------------------------------------------------
  // split-pdf
  // -------------------------------------------------------------------------
  if (toolName === 'split-pdf') {
    // Alias: 'mode' → 'split_mode'
    if (!options.split_mode) {
      if (
        typeof options.mode === 'string' &&
        VALID_SPLIT_MODES.includes(options.mode)
      ) {
        options.split_mode = options.mode;
        delete options.mode;
      } else if (options.fixed_range !== undefined) {
        options.split_mode = 'fixed_range';
      } else if (options.remove_pages !== undefined) {
        options.split_mode = 'remove_pages';
      } else if (options.ranges !== undefined) {
        options.split_mode = 'ranges';
      }
    }

    // Validate split_mode value
    if (options.split_mode !== undefined) {
      const suppliedSplitMode =
        typeof options.split_mode === 'string' ? options.split_mode : '';
      if (!VALID_SPLIT_MODES.includes(suppliedSplitMode)) {
        options.split_mode = 'ranges';
      }
    }

    const splitMode =
      typeof options.split_mode === 'string'
        ? options.split_mode.toLowerCase()
        : '';

    // fixed_range: ignore unsupported "last page" mentions and keep numeric value when present.
    if (
      splitMode === 'fixed_range' &&
      typeof options.fixed_range === 'string' &&
      mentionsLastPage(options.fixed_range)
    ) {
      const fixedRangeMatch = /\d+/.exec(options.fixed_range);
      const extracted = fixedRangeMatch?.[0];
      if (extracted !== undefined) {
        options.fixed_range = Number(extracted);
        warnings.push(
          'split-pdf fixed_range does not support "last page". Ignoring that value and using the provided chunk size.'
        );
      } else {
        delete options.fixed_range;
        warnings.push(
          'split-pdf fixed_range does not support "last page". Please provide fixed_range as a number (for example: 1, 2, or 5).'
        );
      }
    }

    // remove_pages: ignore unsupported "last page" mentions and preserve explicit ranges/pages.
    if (typeof options.remove_pages === 'string') {
      const replacedEnd = options.remove_pages.replace(/\bend\b/gi, '9999');
      if (splitMode === 'remove_pages') {
        const cleaned = stripUnsupportedLastPageFromSplitList(replacedEnd);
        if (cleaned.removedLastPage) {
          warnings.push(
            'split-pdf remove_pages does not support "last page". Ignoring that value and applying the remaining pages.'
          );
        }

        if (cleaned.value.trim() === '') {
          delete options.remove_pages;
          warnings.push(
            'split-pdf remove_pages has no valid pages after removing unsupported "last page". Please provide explicit page numbers or ranges (for example: "2,5,8-12").'
          );
        } else {
          options.remove_pages = normalizeSplitRanges(cleaned.value);
        }
      } else {
        options.remove_pages = normalizeSplitRanges(replacedEnd);
      }
    }

    // Normalize page range strings
    if (typeof options.ranges === 'string') {
      options.ranges = normalizeSplitRanges(
        options.ranges.replace(/\bend\b/gi, '9999')
      );
    }

    // fixed_range must be ≥ 1
    if (options.fixed_range !== undefined) {
      const num = Number(options.fixed_range);
      if (isNaN(num) || num < 1) {
        options.fixed_range = 1;
        if (!isNaN(num)) warnings.push('Fixed range must be ≥ 1. Using 1.');
      } else {
        options.fixed_range = Math.trunc(num);
      }
    }

    // merge_after: coerce to boolean, only valid with split_mode 'ranges'
    if (options.merge_after !== undefined) {
      const r = normalizeBoolean(options.merge_after, 'merge_after');
      options.merge_after = r.value;
      if (r.warning) warnings.push(r.warning);

      if (options.merge_after === true && options.split_mode !== 'ranges') {
        options.merge_after = false;
        warnings.push(
          'merge_after only takes effect when split_mode is "ranges". Ignoring merge_after.'
        );
      }
    }

    // Clean irrelevant params based on split_mode to avoid confusing the API
    const mode = String(options.split_mode ?? 'ranges');
    if (mode !== 'fixed_range') {
      delete options.fixed_range;
    }
    if (mode !== 'ranges') {
      delete options.ranges;
      delete options.merge_after;
    }
    if (mode !== 'remove_pages') {
      delete options.remove_pages;
    }
  }

  // -------------------------------------------------------------------------
  // image-to-pdf
  // -------------------------------------------------------------------------
  if (toolName === 'image-to-pdf') {
    // Validate orientation
    if (options.orientation !== undefined) {
      const s = String(options.orientation).toLowerCase().trim();
      if (!['portrait', 'landscape'].includes(s))
        options.orientation = 'portrait';
    }

    // Validate pagesize
    if (options.pagesize !== undefined) {
      if (!['fit', 'A4', 'letter'].includes(String(options.pagesize))) {
        options.pagesize = 'fit';
      }
    }

    // landscape + fit → A4
    if (
      options.orientation === 'landscape' &&
      (options.pagesize === 'fit' || options.pagesize === undefined)
    ) {
      options.pagesize = 'A4';
      warnings.push(
        "pagesize 'fit' is incompatible with landscape orientation. Using A4."
      );
    }

    // margin ≥ 0 (pixels, no upper bound)
    if (options.margin !== undefined) {
      const num = Number(options.margin);
      if (isNaN(num) || num < 0) {
        options.margin = 0;
        if (!isNaN(num)) warnings.push('Margin must be ≥ 0. Using 0.');
      } else {
        options.margin = Math.trunc(num);
      }
    }
  }

  // -------------------------------------------------------------------------
  // watermark
  // -------------------------------------------------------------------------
  if (toolName === 'watermark') {
    if (options.mode == null) options.mode = 'text';

    // iLovePDF does not support "all pages except the last page":
    // only supports specific pages like "1-556 if file has 557 pages".
    // Keep behavior deterministic by falling back to all pages.
    if (options.last_cover === true) {
      options.pages = 'all';
      warnings.push(
        'iLovePDF does not allow excluding only the last page for watermark. Using pages "all" instead.'
      );
    }

    if (
      typeof options.pages === 'string' &&
      requestsExcludeLastPage(options.pages)
    ) {
      options.pages = 'all';
      warnings.push(
        'iLovePDF does not allow excluding only the last page for watermark. Using pages "all" instead.'
      );
    }

    // Normalize pages "end" → 9999
    if (typeof options.pages === 'string') {
      options.pages = options.pages.replace(/\bend\b/gi, '9999');
    }

    if (options.font_family !== undefined) {
      const r = normalizeFontFamily(String(options.font_family));
      options.font_family = r.value;
      if (r.warning) warnings.push(r.warning);
    }

    if (options.font_size !== undefined) {
      const r = normalizeFontSize(options.font_size, 14);
      options.font_size = r.value;
      if (r.warning) warnings.push(r.warning);
    }

    if (options.font_color !== undefined) {
      const r = normalizeColor(options.font_color);
      options.font_color = r.value;
      if (r.warning) warnings.push(r.warning);
    }

    // vertical_position: watermark supports top|middle|bottom
    if (options.vertical_position !== undefined) {
      const r = normalizeVerticalPosition(
        String(options.vertical_position),
        'watermark'
      );
      options.vertical_position = r.value;
      if (r.warning) warnings.push(r.warning);
    }

    if (options.horizontal_position !== undefined) {
      options.horizontal_position = normalizeHorizontalPosition(
        String(options.horizontal_position)
      );
    }

    // transparency: integer 1-100
    if (options.transparency !== undefined) {
      const num = Number(options.transparency);
      if (isNaN(num)) {
        options.transparency = 100;
        warnings.push('transparency must be a number. Using 100.');
      } else if (num < 1) {
        options.transparency = 1;
        warnings.push('Transparency must be 1-100. Using 1.');
      } else if (num > 100) {
        options.transparency = 100;
        warnings.push('Transparency must be 1-100. Using 100.');
      } else {
        options.transparency = Math.trunc(num);
      }
    }

    // rotation: integer 0-360
    if (options.rotation !== undefined) {
      const num = Number(options.rotation);
      if (!isNaN(num)) {
        options.rotation = Math.abs(Math.trunc(num)) % 360;
      }
    }

    // font_style: normalize to null | 'Bold' | 'Italic'
    if (options.font_style !== undefined && options.font_style !== null) {
      const supplied = String(options.font_style).trim();
      const s = supplied.toLowerCase();

      if (/\bbold\b|\bnegrita\b/.test(s)) {
        options.font_style = 'Bold';
      } else if (/\bitalic\b|\bcursiva\b/.test(s)) {
        options.font_style = 'Italic';
      } else if (
        s === 'null' ||
        s === '' ||
        s === 'regular' ||
        s === 'normal'
      ) {
        options.font_style = null;
      } else {
        options.font_style = null;
        warnings.push(
          `font_style '${supplied}' is not supported. Using Regular.`
        );
      }
    }
  }

  // -------------------------------------------------------------------------
  // pagenumber
  // -------------------------------------------------------------------------
  if (toolName === 'pagenumber') {
    if (options.font_family !== undefined) {
      const r = normalizeFontFamily(String(options.font_family));
      options.font_family = r.value;
      if (r.warning) warnings.push(r.warning);
    }

    if (options.font_size !== undefined) {
      const r = normalizeFontSize(options.font_size, 12);
      options.font_size = r.value;
      if (r.warning) warnings.push(r.warning);
    }

    if (options.font_color !== undefined) {
      const r = normalizeColor(options.font_color);
      options.font_color = r.value;
      if (r.warning) warnings.push(r.warning);
    }

    // vertical_position: pagenumber supports top|bottom ONLY (not middle)
    if (options.vertical_position !== undefined) {
      const r = normalizeVerticalPosition(
        String(options.vertical_position),
        'pagenumber'
      );
      options.vertical_position = r.value;
      if (r.warning) warnings.push(r.warning);
    }

    if (options.horizontal_position !== undefined) {
      options.horizontal_position = normalizeHorizontalPosition(
        String(options.horizontal_position)
      );
    }

    if (options.facing_pages !== undefined) {
      const r = normalizeBoolean(options.facing_pages, 'facing_pages');
      options.facing_pages = r.value;
      if (r.warning) warnings.push(r.warning);
    }

    // first_cover:true + pages:"all" → pages:"2-end"
    if (options.first_cover === true) {
      const pages = options.pages as string | undefined;
      if (!pages || pages === 'all') {
        options.pages = '2-end';
        warnings.push(
          "first_cover:true converts pages to '2-end' (page 1 skipped)."
        );
      }
    }

    // iLovePDF does not support "all pages except the last page":
    // only supports specific pages like "1-556 if file has 557 pages".
    // Keep behavior deterministic by falling back to all pages.
    if (options.last_cover === true) {
      options.pages = 'all';
      warnings.push(
        'iLovePDF does not allow excluding only the last page for page numbers. Using pages "all" instead.'
      );
    }

    if (
      typeof options.pages === 'string' &&
      requestsExcludeLastPage(options.pages)
    ) {
      options.pages = 'all';
      warnings.push(
        'iLovePDF does not allow excluding only the last page for page numbers. Using pages "all" instead.'
      );
    }

    // Normalize pages "end" → 9999
    if (typeof options.pages === 'string') {
      options.pages = options.pages.replace(/\bend\b/gi, '9999');
    }
  }

  return { options, warnings };
}
