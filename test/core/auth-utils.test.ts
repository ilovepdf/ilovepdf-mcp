import { describe, it, expect } from 'vitest';
import { isAuthError, isTransientError } from '../../src/core/auth-utils.js';

describe('core/auth-utils', () => {
  describe('isAuthError', () => {
    it('is true for 401 messages', () => {
      expect(isAuthError(new Error('Request failed with status 401'))).toBe(
        true
      );
    });

    it('is true for 403 messages', () => {
      expect(isAuthError(new Error('HTTP 403 Forbidden'))).toBe(true);
    });

    it('is true for common auth-failure phrases', () => {
      expect(isAuthError(new Error('Unauthorized'))).toBe(true);
      expect(isAuthError(new Error('Signature verification failed'))).toBe(true);
    });

    it('accepts non-Error values via String coercion', () => {
      expect(isAuthError('401')).toBe(true);
      expect(isAuthError('all good')).toBe(false);
    });

    it('is false for non-auth errors', () => {
      expect(isAuthError(new Error('500 Internal Server Error'))).toBe(false);
      expect(isAuthError(new Error('502 Bad Gateway'))).toBe(false);
      expect(isAuthError(undefined)).toBe(false);
    });
  });

  describe('isTransientError', () => {
    it('is true for 502/503/504 status codes', () => {
      expect(isTransientError(new Error('502'))).toBe(true);
      expect(isTransientError(new Error('503'))).toBe(true);
      expect(isTransientError(new Error('504'))).toBe(true);
    });

    it('is true for common transient-failure phrases', () => {
      expect(isTransientError(new Error('Bad Gateway'))).toBe(true);
      expect(isTransientError(new Error('Service Unavailable'))).toBe(true);
      expect(isTransientError(new Error('Gateway Timeout'))).toBe(true);
    });

    it('accepts non-Error values via String coercion', () => {
      expect(isTransientError('503')).toBe(true);
      expect(isTransientError('ok')).toBe(false);
    });

    it('is false for non-transient errors', () => {
      expect(isTransientError(new Error('401 Unauthorized'))).toBe(false);
      expect(isTransientError(new Error('500 Internal Server Error'))).toBe(
        false
      );
      expect(isTransientError(undefined)).toBe(false);
    });
  });
});
