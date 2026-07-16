import { describe, it, expect } from 'vitest';
import {
  ToolError,
  isToolError,
  ERROR_CODES,
  type ErrorCode,
} from '../../src/domain/errors.js';

describe('domain/errors', () => {
  describe('ToolError', () => {
    it('exposes code, message, userMessage, and retryable', () => {
      const err = new ToolError(
        'UPLOAD_FAILED',
        'raw api text',
        'Upload failed. Please try again.',
        true
      );

      expect(err.code).toBe('UPLOAD_FAILED');
      expect(err.message).toBe('raw api text');
      expect(err.userMessage).toBe('Upload failed. Please try again.');
      expect(err.retryable).toBe(true);
    });

    it('defaults retryable to false', () => {
      const err = new ToolError('INTERNAL', 'boom', 'Something went wrong.');
      expect(err.retryable).toBe(false);
    });

    it('is an instance of Error and ToolError', () => {
      const err = new ToolError('INTERNAL', 'boom', 'Something went wrong.');
      expect(err).toBeInstanceOf(Error);
      expect(err).toBeInstanceOf(ToolError);
      expect(err.name).toBe('ToolError');
    });

    it('toStructured() returns a flat failure payload', () => {
      const err = new ToolError(
        'PROCESS_FAILED',
        'process 500',
        'Processing failed.',
        false
      );

      expect(err.toStructured()).toEqual({
        success: false,
        error_code: 'PROCESS_FAILED',
        error: 'Processing failed.',
        detail: 'process 500',
        retryable: false,
      });
    });
  });

  describe('isToolError', () => {
    it('returns true for a ToolError instance', () => {
      expect(isToolError(new ToolError('INTERNAL', 'x', 'y'))).toBe(true);
    });

    it('returns false for a plain Error', () => {
      expect(isToolError(new Error('plain'))).toBe(false);
    });

    it('returns false for non-error values', () => {
      expect(isToolError(null)).toBe(false);
      expect(isToolError(undefined)).toBe(false);
      expect(isToolError('UPLOAD_FAILED')).toBe(false);
      expect(isToolError({ code: 'UPLOAD_FAILED' })).toBe(false);
    });
  });

  describe('ErrorCode union (ERR-2)', () => {
    it('contains EXACTLY the headless set — no more, no less', () => {
      const expected = [
        // retained
        'UPLOAD_FAILED',
        'PROCESS_FAILED',
        'AUTH_FAILED',
        'UNSUPPORTED_EXTENSION',
        'UPSTREAM_ERROR',
        'VALIDATION_ERROR',
        'INTERNAL',
        'TASK_ALREADY_PROCESSED',
        // added
        'FILE_ACCESS_DENIED',
        'FILE_NOT_FOUND',
        'CONFIG_ERROR',
      ] as const;

      expect([...ERROR_CODES].sort()).toEqual([...expected].sort());
      expect(ERROR_CODES).toHaveLength(11);
    });

    it('does NOT contain dropped widget/OpenAI-only codes', () => {
      const dropped = [
        'MIXED_SOURCE_NOT_SUPPORTED',
        'MISSING_UPLOADED_FILES_IN_PROCESS_FILES',
        'MISSING_TASK_TOOL',
        'OUTPUT_CONTRACT_VIOLATION',
        'MISSING_REQUIRED_PARAMETER',
      ];

      for (const code of dropped) {
        expect(ERROR_CODES).not.toContain(code);
      }
    });

    it('every ERROR_CODES entry is a usable ErrorCode', () => {
      for (const code of ERROR_CODES) {
        const asCode: ErrorCode = code;
        expect(new ToolError(asCode, 'm', 'u').code).toBe(code);
      }
    });
  });
});
