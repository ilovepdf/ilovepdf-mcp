/**
 * test/core/option-normalizer.test.ts
 *
 * Unit tests for the ported option normalizer (DEC-2).
 *
 * DEC-2: the option-normalization logic that previously lived in the Worker
 * `/api/process` handler (source: ../openai-app/mcp-server/src/services/
 * option-normalizer.ts) is relocated into a PURE `normalizeOptions(op, options)`
 * that runs in the handler BEFORE execute. These tests pin the three known
 * corrections so headless callers don't regress against the Worker behaviour:
 *   (1) split-range: `end` → `9999`;
 *   (2) font fuzzy-match against VALID_FONT_FAMILIES;
 *   (3) watermark/pagenumber position mapping.
 */

import { describe, it, expect } from 'vitest';
import { normalizeOptions } from '../../src/core/option-normalizer.js';
import { VALID_FONT_FAMILIES } from '../../src/contract/options-schema.js';

describe('normalizeOptions — purity', () => {
  it('does not mutate the input options object', () => {
    const input = { ranges: '1-end' };
    const snapshot = JSON.stringify(input);
    normalizeOptions('split-pdf', input);
    expect(JSON.stringify(input)).toBe(snapshot);
  });

  it('returns a new options object (not the same reference)', () => {
    const input = { split_mode: 'ranges', ranges: '1-3' };
    const { options } = normalizeOptions('split-pdf', input);
    expect(options).not.toBe(input);
  });

  it('is a no-op (empty warnings, cloned options) for tools that need no normalization', () => {
    const input = { compression_level: 'extreme' };
    const { options, warnings } = normalizeOptions('compress-pdf', input);
    expect(options).toEqual(input);
    expect(options).not.toBe(input);
    expect(warnings).toEqual([]);
  });

  it('is a no-op for pdf-ocr (NO_OP_TOOLS)', () => {
    const input = { ocr_languages: ['eng'] };
    const { options, warnings } = normalizeOptions('pdf-ocr', input);
    expect(options).toEqual(input);
    expect(options).not.toBe(input);
    expect(warnings).toEqual([]);
  });

  it('is a no-op for unlock (NO_OP_TOOLS)', () => {
    const input = { password: 'secret' };
    const { options, warnings } = normalizeOptions('unlock', input);
    expect(options).toEqual(input);
    expect(options).not.toBe(input);
    expect(warnings).toEqual([]);
  });

  it('is a no-op for office-to-pdf (NO_OP_TOOLS)', () => {
    const { options, warnings } = normalizeOptions('office-to-pdf', {});
    expect(options).toEqual({});
    expect(warnings).toEqual([]);
  });
});

describe('normalizeOptions — split-pdf range normalization (end → 9999)', () => {
  it('replaces the "end" keyword with 9999 in ranges', () => {
    const { options } = normalizeOptions('split-pdf', {
      split_mode: 'ranges',
      ranges: '1-3,4-end',
    });
    expect(options.ranges).toBe('1-3,4-9999');
  });

  it('expands a single page into a self range and preserves numeric ranges', () => {
    const { options } = normalizeOptions('split-pdf', {
      split_mode: 'ranges',
      ranges: '2,5-9',
    });
    expect(options.ranges).toBe('2-2,5-9');
  });

  it('replaces "end" in remove_pages', () => {
    const { options } = normalizeOptions('split-pdf', {
      split_mode: 'remove_pages',
      remove_pages: '2,5-end',
    });
    expect(options.remove_pages).toBe('2-2,5-9999');
  });

  it('infers split_mode from ranges when omitted', () => {
    const { options } = normalizeOptions('split-pdf', { ranges: '1-2' });
    expect(options.split_mode).toBe('ranges');
  });

  it('drops params irrelevant to the chosen split_mode', () => {
    const { options } = normalizeOptions('split-pdf', {
      split_mode: 'ranges',
      ranges: '1-2',
      fixed_range: 3,
      remove_pages: '4',
    });
    expect(options.fixed_range).toBeUndefined();
    expect(options.remove_pages).toBeUndefined();
    expect(options.ranges).toBe('1-2');
  });
});

describe('normalizeOptions — font fuzzy-match', () => {
  it('matches a partial/lowercase font to the exact VALID_FONT_FAMILIES value', () => {
    const { options } = normalizeOptions('watermark', {
      text: 'x',
      font_family: 'times',
    });
    expect(options.font_family).toBe('Times New Roman');
    expect(VALID_FONT_FAMILIES).toContain(options.font_family);
  });

  it('keeps an exact font value unchanged', () => {
    const { options } = normalizeOptions('pagenumber', { font_family: 'Verdana' });
    expect(options.font_family).toBe('Verdana');
  });

  it('falls back to Arial Unicode MS with a warning for an unknown font', () => {
    const { options, warnings } = normalizeOptions('watermark', {
      text: 'x',
      font_family: 'Wingdings',
    });
    expect(options.font_family).toBe('Arial Unicode MS');
    expect(warnings.some(w => /Wingdings/.test(w))).toBe(true);
  });
});

describe('normalizeOptions — watermark position mapping', () => {
  it('maps a center vertical position to "middle" (watermark supports middle)', () => {
    const { options } = normalizeOptions('watermark', {
      text: 'x',
      vertical_position: 'center',
    });
    expect(options.vertical_position).toBe('middle');
  });

  it('maps horizontal synonyms to canonical values', () => {
    const { options } = normalizeOptions('watermark', {
      text: 'x',
      horizontal_position: 'izquierda',
    });
    expect(options.horizontal_position).toBe('left');
  });

  it('defaults mode to "text" and replaces pages "end" with 9999', () => {
    const { options } = normalizeOptions('watermark', {
      text: 'x',
      pages: '2-end',
    });
    expect(options.mode).toBe('text');
    expect(options.pages).toBe('2-9999');
  });
});

describe('normalizeOptions — pagenumber position mapping', () => {
  it('maps a center vertical position to "bottom" with a warning (pagenumber has no middle)', () => {
    const { options, warnings } = normalizeOptions('pagenumber', {
      vertical_position: 'center',
    });
    expect(options.vertical_position).toBe('bottom');
    expect(warnings.some(w => /pagenumber/i.test(w))).toBe(true);
  });

  it('maps top synonyms to "top"', () => {
    const { options } = normalizeOptions('pagenumber', {
      vertical_position: 'superior',
    });
    expect(options.vertical_position).toBe('top');
  });

  it('first_cover:true with pages "all" becomes "2-9999" (2-end then end→9999)', () => {
    const { options } = normalizeOptions('pagenumber', {
      first_cover: true,
      pages: 'all',
    });
    expect(options.pages).toBe('2-9999');
  });
});
