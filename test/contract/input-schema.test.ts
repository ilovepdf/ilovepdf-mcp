/**
 * test/contract/input-schema.test.ts
 *
 * Contract tests for the ported Zod input pieces (TOOL-4).
 *
 * The headless server drops the widget-shaped input (uploaded_files / url files).
 * Input now describes LOCAL files:
 *   - `sources`     — array of non-empty file paths, at least one required
 *   - `output_path` — optional destination path
 *
 * These small Zod pieces are consumed by `tools/input-shape.ts`.
 */

import { describe, it, expect } from 'vitest';
import { sourcesSchema, outputPathSchema } from '../../src/contract/input-schema.js';

describe('sourcesSchema', () => {
  it('accepts an array with one non-empty string', () => {
    const result = sourcesSchema.safeParse(['/tmp/doc.pdf']);
    expect(result.success).toBe(true);
  });

  it('accepts an array with multiple non-empty strings', () => {
    const result = sourcesSchema.safeParse(['/a.pdf', '/b.pdf', '/c.pdf']);
    expect(result.success).toBe(true);
  });

  it('rejects an empty array', () => {
    const result = sourcesSchema.safeParse([]);
    expect(result.success).toBe(false);
  });

  it('rejects an array containing an empty string', () => {
    const result = sourcesSchema.safeParse(['']);
    expect(result.success).toBe(false);
  });

  it('rejects a non-array value', () => {
    const result = sourcesSchema.safeParse('/tmp/doc.pdf');
    expect(result.success).toBe(false);
  });
});

describe('outputPathSchema', () => {
  it('accepts a non-empty string', () => {
    const result = outputPathSchema.safeParse('/tmp/out.pdf');
    expect(result.success).toBe(true);
  });

  it('accepts undefined (optional)', () => {
    const result = outputPathSchema.safeParse(undefined);
    expect(result.success).toBe(true);
  });

  it('rejects a non-string value', () => {
    const result = outputPathSchema.safeParse(123);
    expect(result.success).toBe(false);
  });
});

describe('dropped widget-shaped exports', () => {
  it('no longer exports the widget-only schemas', async () => {
    const mod = await import('../../src/contract/input-schema.js');
    expect((mod as Record<string, unknown>).uploadedFileSchema).toBeUndefined();
    expect((mod as Record<string, unknown>).urlFileSchema).toBeUndefined();
    expect((mod as Record<string, unknown>).IlovepdfInputSchema).toBeUndefined();
    expect((mod as Record<string, unknown>).ilovepdfInputSchemaJson).toBeUndefined();
  });
});
