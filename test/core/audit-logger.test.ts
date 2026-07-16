/**
 * Tests for core/audit-logger.ts (LOG-4, LOG-5).
 *
 * Covers:
 * - Redaction of `token` keys, `download_url` values, `?token=`/`&token=`
 *   query params, and `Bearer <jwt>` headers.
 * - The stdio-safety invariant (LOG-3): the logger MUST emit via
 *   `console.error` (stderr) and MUST NEVER call `console.log` (stdout is
 *   reserved for MCP protocol frames).
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  auditLogger,
  log,
  redact,
  redactObject,
} from '../../src/core/audit-logger.js';

describe('redact (string-level)', () => {
  it('redacts a ?token= query param', () => {
    expect(redact('https://api.example.com/f?token=abc123&x=1')).toBe(
      'https://api.example.com/f?token=[REDACTED]&x=1'
    );
  });

  it('redacts an &token= query param', () => {
    expect(redact('https://api.example.com/f?x=1&token=abc123')).toBe(
      'https://api.example.com/f?x=1&token=[REDACTED]'
    );
  });

  it('redacts a "download_url" JSON value', () => {
    expect(redact('{"download_url":"https://dl.example.com/v1/download/xyz"}')).toBe(
      '{"download_url":"[REDACTED_URL]"}'
    );
  });

  it('redacts a Bearer JWT', () => {
    const jwt = 'Bearer eyJhbGciOi.eyJzdWIiOiIx.SflKxwRJ';
    expect(redact(jwt)).toBe('Bearer [REDACTED_JWT]');
  });
});

describe('redactObject (deep)', () => {
  it('redacts a `token` key value to [REDACTED]', () => {
    expect(redactObject({ token: 'secret' })).toEqual({ token: '[REDACTED]' });
  });

  it('redacts a `download_url` key value to [REDACTED_URL]', () => {
    expect(redactObject({ download_url: 'https://dl.example.com/x' })).toEqual({
      download_url: '[REDACTED_URL]',
    });
  });

  it('recurses into nested objects and arrays', () => {
    const input = {
      nested: { token: 'abc' },
      list: [{ download_url: 'https://dl/x' }],
    };
    expect(redactObject(input)).toEqual({
      nested: { token: '[REDACTED]' },
      list: [{ download_url: '[REDACTED_URL]' }],
    });
  });
});

describe('stdio-safety: emit via console.error only (LOG-3)', () => {
  let logSpy: ReturnType<typeof vi.spyOn>;
  let errorSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    logSpy.mockRestore();
    errorSpy.mockRestore();
  });

  it('auditLogger.event emits via console.error and never console.log', () => {
    const audit = auditLogger('ilovepdf');
    audit.event('handler.entry', { operation: 'compress-pdf' });

    expect(errorSpy).toHaveBeenCalled();
    expect(logSpy).not.toHaveBeenCalled();
  });

  it('auditLogger.event redacts sensitive fields in emitted output', () => {
    const audit = auditLogger('ilovepdf');
    audit.event('handler.entry', {
      token: 'secret',
      download_url: 'https://dl/x',
    });

    const emitted = errorSpy.mock.calls.flat().join(' ');
    expect(emitted).toContain('[REDACTED]');
    expect(emitted).toContain('[REDACTED_URL]');
    expect(emitted).not.toContain('secret');
    expect(logSpy).not.toHaveBeenCalled();
  });

  it('log facade {info, warn, error} all route to console.error, never console.log', () => {
    log.info('info message');
    log.warn('warn message');
    log.error('error message');

    expect(errorSpy).toHaveBeenCalledTimes(3);
    expect(logSpy).not.toHaveBeenCalled();
  });

  it('log facade redacts sensitive values before emitting', () => {
    log.info('visit https://api/f?token=abc123');

    const emitted = errorSpy.mock.calls.flat().join(' ');
    expect(emitted).toContain('token=[REDACTED]');
    expect(emitted).not.toContain('abc123');
    expect(logSpy).not.toHaveBeenCalled();
  });
});
