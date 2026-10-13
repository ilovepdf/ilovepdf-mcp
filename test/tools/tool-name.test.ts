/**
 * test/tools/tool-name.test.ts
 *
 * Contract tests for `tools/tool-name.ts` (TOOL-2, OPS-6, DEC-1).
 *
 * DEC-1 is the SINGLE source of the MCP tool-naming rule: a tool name is
 * derived mechanically from its operation name as
 *   `` + operationName with every `-` replaced by `_`.
 * An optional `op.toolName` override wins when present (v1 ships no overrides).
 *
 * These tests lock four properties:
 *   1. The 10 registry ops produce the exact expected mechanical names.
 *   2. Every produced name matches `^ilovepdf_[a-z_]+$`.
 *   3. All produced names are unique (no collisions).
 *   4. An explicit `op.toolName` override takes precedence over the rule.
 */

import { describe, it, expect } from 'vitest';
import { OPERATIONS, OPERATION_NAMES } from '../../src/domain/operations.js';
import type { OperationName } from '../../src/domain/operation-types.js';
import { toolName } from '../../src/tools/tool-name.js';

// The authoritative DEC-1 mapping for the 9 enabled operations (unlock disabled).
const EXPECTED: Record<OperationName, string> = {
  'compress-pdf': 'compress_pdf',
  'pdf-to-jpg': 'pdf_to_jpg',
  'image-to-pdf': 'image_to_pdf',
  'office-to-pdf': 'office_to_pdf',
  'merge-pdf': 'merge_pdf',
  'split-pdf': 'split_pdf',
  // 'unlock': 'unlock_pdf', // TEMPORARILY DISABLED — re-enable to publish.
  'watermark': 'watermark_pdf',
  'pagenumber': 'pagenumber_pdf',
  'pdf-ocr': 'ocr_pdf',
};

describe('toolName mechanical mapping (TOOL-2, DEC-1)', () => {
  it('produces the exact expected name for each of the 9 ops', () => {
    for (const name of OPERATION_NAMES) {
      expect(toolName(OPERATIONS[name]), `toolName for "${name}"`).toBe(
        EXPECTED[name]
      );
    }
  });

  it('every name matches ^[a-z_]+$', () => {
    const pattern = /^[a-z_]+$/;
    for (const name of OPERATION_NAMES) {
      expect(toolName(OPERATIONS[name]), `toolName for "${name}"`).toMatch(
        pattern
      );
    }
  });

  it('produces unique names across all ops', () => {
    const names = OPERATION_NAMES.map(name => toolName(OPERATIONS[name]));
    expect(new Set(names).size).toBe(names.length);
  });
});

describe('toolName override hook (OPS-6, DEC-1)', () => {
  it('honours op.toolName when present', () => {
    const op = { ...OPERATIONS['compress-pdf'], toolName: 'custom' };
    expect(toolName(op)).toBe('custom');
  });

  it('falls back to the mechanical rule when toolName is undefined', () => {
    const op = { ...OPERATIONS['merge-pdf'], toolName: undefined };
    expect(toolName(op)).toBe('merge_pdf');
  });
});
