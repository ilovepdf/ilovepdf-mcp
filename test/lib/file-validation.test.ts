import { describe, it, expect } from 'vitest';
import { validateExtension, validateSize } from '../../src/lib/file-validation.js';
import { ToolError, isToolError } from '../../src/domain/errors.js';

describe('lib/file-validation', () => {
  describe('validateExtension', () => {
    it('accepts a file whose extension is in acceptedExtensions (FIO-7)', () => {
      expect(() => validateExtension('report.pdf', ['.pdf'])).not.toThrow();
    });

    it('matches case-insensitively for the filename extension (FIO-7)', () => {
      expect(() => validateExtension('Report.PDF', ['.pdf'])).not.toThrow();
      expect(() =>
        validateExtension('photo.PNG', ['.jpg', '.png'])
      ).not.toThrow();
    });

    it('matches case-insensitively for the registry extensions (FIO-7)', () => {
      expect(() => validateExtension('photo.png', ['.PNG'])).not.toThrow();
    });

    it('rejects a wrong extension with UNSUPPORTED_EXTENSION (FIO-7)', () => {
      let thrown: unknown;
      try {
        validateExtension('notes.txt', ['.pdf']);
      } catch (err) {
        thrown = err;
      }

      expect(isToolError(thrown)).toBe(true);
      expect((thrown as ToolError).code).toBe('UNSUPPORTED_EXTENSION');
    });

    it('rejects a filename with no extension (FIO-7)', () => {
      expect(() => validateExtension('README', ['.pdf'])).toThrow(ToolError);
    });
  });

  describe('validateSize', () => {
    it('accepts a file within the size limit (OPS-3)', () => {
      expect(() => validateSize(1_000_000, 95)).not.toThrow();
    });

    it('accepts a file exactly at the size limit (OPS-3)', () => {
      expect(() => validateSize(1 * 1024 * 1024, 1)).not.toThrow();
    });

    it('throws a typed ToolError when over the limit (OPS-3)', () => {
      let thrown: unknown;
      try {
        validateSize(2 * 1024 * 1024, 1);
      } catch (err) {
        thrown = err;
      }

      expect(isToolError(thrown)).toBe(true);
      expect((thrown as ToolError).code).toBe('VALIDATION_ERROR');
    });
  });
});
