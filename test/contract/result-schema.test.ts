/**
 * test/contract/result-schema.test.ts
 *
 * Contract tests for RESULT_OUTPUT_SHAPE (TOOL-5, TOOL-6, TOOL-9, ERR-8).
 *
 * ONE ZodRawShape must validate BOTH result surfaces returned by every
 * generated tool:
 *   - SUCCESS: status="completed" with operation, input, output, metrics.
 *   - FAILURE: status="failed" with operation, input and a FLAT error surface
 *     (error_code + retryable, plus toStructured's success/error/detail).
 *       Success-only fields (output, metrics) are ABSENT on failure.
 *
 * A malformed success object that omits `metrics.durationMs` (TOOL-6) must be
 * rejected: metrics is optional, but when present durationMs is required.
 *
 * RESULT_OUTPUT_SHAPE is a ZodRawShape (the plain object MCP SDK
 * `registerTool` expects as `outputSchema`), so tests wrap it in z.object().
 */

import { describe, it, expect } from 'vitest';
import { z } from 'zod';
import { RESULT_OUTPUT_SHAPE } from '../../src/contract/result-schema.js';

const resultSchema = z.object(RESULT_OUTPUT_SHAPE);

describe('RESULT_OUTPUT_SHAPE — SUCCESS surface', () => {
  const successResult = {
    operation: 'compress-pdf',
    status: 'completed',
    input: {
      sources: ['/tmp/doc.pdf'],
      count: 1,
      totalBytes: 2048,
    },
    output: {
      path: '/tmp/doc-compressed.pdf',
      download_url: 'https://example.com/download/abc',
      bytes: 1024,
      fileCount: 1,
    },
    metrics: {
      inputBytes: 2048,
      outputBytes: 1024,
      ratio: 0.5,
      durationMs: 1234,
    },
  };

  it('validates a full success object', () => {
    const result = resultSchema.safeParse(successResult);
    expect(result.success).toBe(true);
  });

  it('rejects a success object missing metrics.durationMs (TOOL-6 malformed guard)', () => {
    const metricsWithoutDuration = {
      inputBytes: successResult.metrics.inputBytes,
      outputBytes: successResult.metrics.outputBytes,
      ratio: successResult.metrics.ratio,
    };
    const malformed = { ...successResult, metrics: metricsWithoutDuration };
    const result = resultSchema.safeParse(malformed);
    expect(result.success).toBe(false);
  });
});

describe('RESULT_OUTPUT_SHAPE — FAILURE surface', () => {
  const failureResult = {
    operation: 'compress-pdf',
    status: 'failed',
    input: {
      sources: ['/tmp/doc.pdf'],
      count: 1,
      totalBytes: 2048,
    },
    // FLAT error surface (ERR-8) — output/metrics ABSENT.
    success: false,
    error_code: 'UPLOAD_FAILED',
    error: 'Upload failed. Please try again.',
    detail: 'connection reset by peer',
    retryable: true,
  };

  it('validates a failure object with a flat error surface', () => {
    const result = resultSchema.safeParse(failureResult);
    expect(result.success).toBe(true);
  });

  it('accepts a failure with output and metrics absent', () => {
    const result = resultSchema.safeParse(failureResult);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.output).toBeUndefined();
      expect(result.data.metrics).toBeUndefined();
    }
  });

  it('surfaces error_code and retryable (ERR-8)', () => {
    const result = resultSchema.safeParse(failureResult);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.error_code).toBe('UPLOAD_FAILED');
      expect(result.data.retryable).toBe(true);
    }
  });

  it('rejects an unknown error_code', () => {
    const bad = { ...failureResult, error_code: 'NOT_A_REAL_CODE' };
    const result = resultSchema.safeParse(bad);
    expect(result.success).toBe(false);
  });
});

describe('RESULT_OUTPUT_SHAPE — shared invariants', () => {
  it('requires operation, status and input on both surfaces', () => {
    const missingRequired = resultSchema.safeParse({ status: 'completed' });
    expect(missingRequired.success).toBe(false);
  });

  it('rejects a status outside the completed/failed enum', () => {
    const result = resultSchema.safeParse({
      operation: 'compress-pdf',
      status: 'pending',
      input: { sources: ['/a.pdf'], count: 1, totalBytes: 1 },
    });
    expect(result.success).toBe(false);
  });
});
