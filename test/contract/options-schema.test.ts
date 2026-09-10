/**
 * test/contract/options-schema.test.ts
 *
 * Contract tests for the per-operation Zod options schemas (OPS-4, TOOL-3).
 *
 * Every schema is `.passthrough()` so KNOWN fields are type-checked while
 * unknown keys survive for forward-compat with the iLovePDF API. A wrong enum
 * value on a known field must be rejected.
 *
 * `validateOptions` is the runtime guard: it throws
 * `ToolError('VALIDATION_ERROR')` on failure (headless port change from the
 * source's result-object return shape).
 */

import { describe, it, expect } from 'vitest';
import {
  OPTIONS_SCHEMAS,
  VALID_FONT_FAMILIES,
  validateOptions,
  compressOptionsSchema,
  pdfToJpgOptionsSchema,
  pdfOcrOptionsSchema,
  unlockOptionsSchema,
  officeToPdfOptionsSchema,
} from '../../src/contract/options-schema.js';
import { ToolError, isToolError } from '../../src/domain/errors.js';
import type { OperationName } from '../../src/domain/operation-types.js';

const ALL_OPS: OperationName[] = [
  'compress-pdf',
  'pdf-to-jpg',
  'image-to-pdf',
  'office-to-pdf',
  'merge-pdf',
  'split-pdf',
  // 'unlock', // TEMPORARILY DISABLED — unlock tool commented out; re-enable to publish.
  'watermark',
  'pagenumber',
  'pdf-ocr',
];

describe('OPTIONS_SCHEMAS', () => {
  it('has an entry for every operation name', () => {
    for (const op of ALL_OPS) {
      expect(OPTIONS_SCHEMAS[op]).toBeDefined();
    }
    expect(Object.keys(OPTIONS_SCHEMAS).sort()).toEqual([...ALL_OPS].sort());
  });

  it('accepts a valid options object for each operation', () => {
    const valid: Record<OperationName, unknown> = {
      'compress-pdf': { compression_level: 'extreme' },
      'pdf-to-jpg': { pdfjpg_mode: 'pages', quality: 'High' },
      'image-to-pdf': { orientation: 'landscape', margin: 10, pagesize: 'A4' },
      'office-to-pdf': {},
      'merge-pdf': {},
      'split-pdf': { split_mode: 'ranges', ranges: '1-3,4-6' },
      // 'unlock': { password: 'secret' }, // TEMPORARILY DISABLED — re-enable to publish.
      'watermark': { mode: 'text', text: 'DRAFT', transparency: 50 },
      'pagenumber': { pages: 'all', starting_number: 1 },
      'pdf-ocr': { ocr_languages: ['eng', 'spa'] },
    };
    for (const op of ALL_OPS) {
      const result = OPTIONS_SCHEMAS[op].safeParse(valid[op]);
      expect(result.success, `${op} should accept its valid object`).toBe(true);
    }
  });

  it('passes unknown keys through (.passthrough())', () => {
    for (const op of ALL_OPS) {
      const result = OPTIONS_SCHEMAS[op].safeParse({ some_future_key: 'x' });
      expect(result.success, `${op} should passthrough unknown keys`).toBe(true);
      if (result.success) {
        expect((result.data as Record<string, unknown>).some_future_key).toBe('x');
      }
    }
  });
});

describe('compress-pdf schema', () => {
  it('accepts a valid compression_level', () => {
    expect(
      compressOptionsSchema.safeParse({ compression_level: 'recommended' }).success
    ).toBe(true);
  });

  it('rejects a wrong compression_level enum', () => {
    expect(
      compressOptionsSchema.safeParse({ compression_level: 'ultra' }).success
    ).toBe(false);
  });
});

describe('pdf-to-jpg schema', () => {
  it('exposes pdfjpg_mode with pages|extract', () => {
    expect(pdfToJpgOptionsSchema.safeParse({ pdfjpg_mode: 'pages' }).success).toBe(
      true
    );
    expect(
      pdfToJpgOptionsSchema.safeParse({ pdfjpg_mode: 'extract' }).success
    ).toBe(true);
    expect(
      pdfToJpgOptionsSchema.safeParse({ pdfjpg_mode: 'wrong' }).success
    ).toBe(false);
  });

  it('does NOT type-check compression_level (it is not a pdf-to-jpg field)', () => {
    // compression_level is unknown here → passthrough, not enum-validated.
    const result = pdfToJpgOptionsSchema.safeParse({ compression_level: 'ultra' });
    expect(result.success).toBe(true);
  });
});

describe('pdf-ocr schema', () => {
  it('accepts a single language', () => {
    expect(pdfOcrOptionsSchema.safeParse({ ocr_languages: ['eng'] }).success).toBe(true);
  });

  it('accepts multiple languages', () => {
    expect(
      pdfOcrOptionsSchema.safeParse({ ocr_languages: ['eng', 'spa', 'fra'] }).success
    ).toBe(true);
  });

  it('accepts non-standard codes without enum rejection (forward-compat)', () => {
    // iLovePDF adds codes over time; individual values are not enum-validated by design
    expect(pdfOcrOptionsSchema.safeParse({ ocr_languages: ['aze_cyrl'] }).success).toBe(true);
  });

  it('accepts empty options (default ["eng"] is applied downstream)', () => {
    expect(pdfOcrOptionsSchema.safeParse({}).success).toBe(true);
  });

  it('rejects ocr_languages as a bare string (must be an array)', () => {
    expect(pdfOcrOptionsSchema.safeParse({ ocr_languages: 'eng' }).success).toBe(false);
  });

  it('rejects a non-string element in the languages array', () => {
    expect(pdfOcrOptionsSchema.safeParse({ ocr_languages: [123] }).success).toBe(false);
  });

  it('passes unknown keys through (.passthrough())', () => {
    const result = pdfOcrOptionsSchema.safeParse({ ocr_languages: ['eng'], future_param: true });
    expect(result.success).toBe(true);
  });
});

describe('unlock schema', () => {
  it('accepts a string password', () => {
    expect(unlockOptionsSchema.safeParse({ password: 'secret' }).success).toBe(true);
  });

  it('accepts empty options (password-free unlock)', () => {
    expect(unlockOptionsSchema.safeParse({}).success).toBe(true);
  });

  it('rejects a numeric password', () => {
    expect(unlockOptionsSchema.safeParse({ password: 123 }).success).toBe(false);
  });

  it('rejects a boolean password', () => {
    expect(unlockOptionsSchema.safeParse({ password: true }).success).toBe(false);
  });

  it('passes unknown keys through (.passthrough())', () => {
    const result = unlockOptionsSchema.safeParse({ password: 'pw', future_param: 'x' });
    expect(result.success).toBe(true);
  });
});

describe('office-to-pdf schema', () => {
  it('accepts empty options (API has no extra process parameters)', () => {
    expect(officeToPdfOptionsSchema.safeParse({}).success).toBe(true);
  });

  it('passes any key through (no typed fields to reject)', () => {
    const result = officeToPdfOptionsSchema.safeParse({ future_param: 'value', another: 42 });
    expect(result.success).toBe(true);
    if (result.success) {
      expect((result.data as Record<string, unknown>).future_param).toBe('value');
    }
  });
});

describe('VALID_FONT_FAMILIES', () => {
  it('contains the exact iLovePDF font list', () => {
    expect(VALID_FONT_FAMILIES).toContain('Arial');
    expect(VALID_FONT_FAMILIES).toContain('Times New Roman');
    expect(VALID_FONT_FAMILIES.length).toBe(8);
  });
});

describe('validateOptions', () => {
  it('returns for valid options without throwing', () => {
    expect(() =>
      validateOptions('compress-pdf', { compression_level: 'low' })
    ).not.toThrow();
  });

  it('is a no-op for unknown tool / null options', () => {
    expect(() => validateOptions(undefined, { x: 1 })).not.toThrow();
    expect(() => validateOptions('compress-pdf', null)).not.toThrow();
    expect(() => validateOptions('not-a-tool', { x: 1 })).not.toThrow();
  });

  it('throws ToolError(VALIDATION_ERROR) on a wrong enum', () => {
    let caught: unknown;
    try {
      validateOptions('compress-pdf', { compression_level: 'ultra' });
    } catch (err) {
      caught = err;
    }
    expect(isToolError(caught)).toBe(true);
    expect((caught as ToolError).code).toBe('VALIDATION_ERROR');
  });

  it('throws ToolError(VALIDATION_ERROR) for pdf-ocr with ocr_languages as a string', () => {
    let caught: unknown;
    try {
      validateOptions('pdf-ocr', { ocr_languages: 'eng' });
    } catch (err) {
      caught = err;
    }
    expect(isToolError(caught)).toBe(true);
    expect((caught as ToolError).code).toBe('VALIDATION_ERROR');
  });

  it('throws ToolError(VALIDATION_ERROR) for pdf-ocr with a non-string in ocr_languages', () => {
    let caught: unknown;
    try {
      validateOptions('pdf-ocr', { ocr_languages: [123] });
    } catch (err) {
      caught = err;
    }
    expect(isToolError(caught)).toBe(true);
    expect((caught as ToolError).code).toBe('VALIDATION_ERROR');
  });

  it('throws ToolError(VALIDATION_ERROR) for unlock with a numeric password', () => {
    let caught: unknown;
    try {
      validateOptions('unlock', { password: 123 });
    } catch (err) {
      caught = err;
    }
    expect(isToolError(caught)).toBe(true);
    expect((caught as ToolError).code).toBe('VALIDATION_ERROR');
  });

  it('does not throw for office-to-pdf with empty options', () => {
    expect(() => validateOptions('office-to-pdf', {})).not.toThrow();
  });
});

describe('dropped exports', () => {
  it('no longer exports optionsJsonSchema', async () => {
    const mod = await import('../../src/contract/options-schema.js');
    expect((mod as Record<string, unknown>).optionsJsonSchema).toBeUndefined();
  });
});
