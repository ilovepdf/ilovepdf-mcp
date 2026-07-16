/**
 * test/tools/input-shape.test.ts
 *
 * Contract tests for `buildInputShape(op)` (TOOL-3, TOOL-4).
 *
 * `buildInputShape` returns a ZodRawShape (a plain object of Zod pieces, NOT a
 * wrapped `z.object`) so the MCP SDK's `registerTool` can consume it directly as
 * `inputSchema`. It wires together:
 *   - `sources`     — reused `sourcesSchema` (array, min 1, each non-empty)
 *   - `output_path` — reused `outputPathSchema` (optional string)
 *   - `options`     — the per-op `op.optionsSchema` (`.passthrough()`), nested + optional
 *
 * See design §3.2.
 */

import { describe, it, expect } from 'vitest';
import { z } from 'zod';
import { buildInputShape } from '../../src/tools/input-shape.js';
import { OPERATIONS } from '../../src/domain/operations.js';

/** Unwrap a possibly-optional Zod schema down to its inner ZodObject. */
function unwrapObject(schema: z.ZodTypeAny): z.ZodObject<z.ZodRawShape> {
  const inner = schema instanceof z.ZodOptional ? schema.unwrap() : schema;
  return inner as z.ZodObject<z.ZodRawShape>;
}

describe('buildInputShape', () => {
  it('returns a raw shape object (not a wrapped z.object)', () => {
    const shape = buildInputShape(OPERATIONS['compress-pdf']);
    expect(shape).toBeTypeOf('object');
    expect(shape).not.toBeInstanceOf(z.ZodType);
    expect(Object.keys(shape).sort()).toEqual(
      ['options', 'output_path', 'sources'].sort()
    );
  });

  it('exposes a sources field: array with min 1 non-empty string', () => {
    const shape = buildInputShape(OPERATIONS['compress-pdf']);
    const wrapped = z.object(shape);

    expect(
      wrapped.safeParse({ sources: ['/tmp/a.pdf'] }).success
    ).toBe(true);
    expect(wrapped.safeParse({ sources: [] }).success).toBe(false);
    expect(wrapped.safeParse({ sources: [''] }).success).toBe(false);
    expect(wrapped.safeParse({}).success).toBe(false);
  });

  it('exposes an optional output_path field', () => {
    const shape = buildInputShape(OPERATIONS['compress-pdf']);
    const wrapped = z.object(shape);

    expect(
      wrapped.safeParse({ sources: ['/tmp/a.pdf'] }).success
    ).toBe(true);
    expect(
      wrapped.safeParse({
        sources: ['/tmp/a.pdf'],
        output_path: '/tmp/out.pdf',
      }).success
    ).toBe(true);
    expect(
      wrapped.safeParse({ sources: ['/tmp/a.pdf'], output_path: 123 }).success
    ).toBe(false);
  });

  it('nests op.optionsSchema under an optional options field', () => {
    const op = OPERATIONS['compress-pdf'];
    const shape = buildInputShape(op);
    const wrapped = z.object(shape);

    // options is optional
    expect(
      wrapped.safeParse({ sources: ['/tmp/a.pdf'] }).success
    ).toBe(true);
    // valid nested option
    expect(
      wrapped.safeParse({
        sources: ['/tmp/a.pdf'],
        options: { compression_level: 'low' },
      }).success
    ).toBe(true);
    // DEC-6: the SDK-level options schema is LOOSENED so invalid enum values
    // now PASS the SDK boundary and are validated inside the handler, which
    // returns a structured VALIDATION_ERROR (not an untyped -32602 error).
    expect(
      wrapped.safeParse({
        sources: ['/tmp/a.pdf'],
        options: { compression_level: 'nope' },
      }).success
    ).toBe(true);
  });

  it('keeps the options schema .passthrough() (unknown keys survive)', () => {
    const shape = buildInputShape(OPERATIONS['compress-pdf']);
    const wrapped = z.object(shape);

    const result = wrapped.safeParse({
      sources: ['/tmp/a.pdf'],
      options: { compression_level: 'low', future_flag: true },
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(
        (result.data.options as Record<string, unknown>).future_flag
      ).toBe(true);
    }
  });

  it('options field is a loosened schema (DEC-6): different object but preserves key set', () => {
    // DEC-6: buildInputShape now returns a LOOSENED options schema (not the strict
    // optionsSchema instance) so the SDK does not intercept bad option values.
    // Discoverability is preserved: all original keys are kept with their descriptions.
    const op = OPERATIONS['compress-pdf'];
    const shape = buildInputShape(op);
    const inner = unwrapObject(shape.options as z.ZodTypeAny);
    // It is a NEW loosened schema object — NOT the exact op.optionsSchema instance.
    expect(inner).not.toBe(op.optionsSchema);
    // Keys from the original schema are still present for model discoverability.
    expect(Object.keys(inner.shape)).toContain('compression_level');
  });

  it('compress shape exposes compression_level', () => {
    const shape = buildInputShape(OPERATIONS['compress-pdf']);
    const options = unwrapObject(shape.options as z.ZodTypeAny);
    expect(Object.keys(options.shape)).toContain('compression_level');
  });

  it('pdf-to-jpg shape exposes pdfjpg_mode, not compression_level', () => {
    const shape = buildInputShape(OPERATIONS['pdf-to-jpg']);
    const options = unwrapObject(shape.options as z.ZodTypeAny);
    const keys = Object.keys(options.shape);
    expect(keys).toContain('pdfjpg_mode');
    expect(keys).not.toContain('compression_level');
  });

  it('builds a shape for every operation with the same top-level keys', () => {
    for (const op of Object.values(OPERATIONS)) {
      const shape = buildInputShape(op);
      expect(Object.keys(shape).sort()).toEqual(
        ['options', 'output_path', 'sources'].sort()
      );
    }
  });
});
