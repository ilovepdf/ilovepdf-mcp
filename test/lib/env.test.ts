import { describe, it, expect, afterEach, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { getEnv, requireEnv, getPublicKey, getWorkdir } from '../../src/lib/env.js';
import { ToolError, isToolError } from '../../src/domain/errors.js';

describe('lib/env', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  describe('requireEnv', () => {
    it('returns the value when the env var is set (ENV-1)', () => {
      vi.stubEnv('ILOVEPDF_PUBLIC_KEY', 'pk_test_123');
      expect(requireEnv('ILOVEPDF_PUBLIC_KEY')).toBe('pk_test_123');
    });

    it('throws a ToolError(CONFIG_ERROR) when unset (ENV-1, ENV-6)', () => {
      vi.stubEnv('ILOVEPDF_PUBLIC_KEY', '');
      let thrown: unknown;
      try {
        requireEnv('ILOVEPDF_PUBLIC_KEY');
      } catch (err) {
        thrown = err;
      }

      expect(isToolError(thrown)).toBe(true);
      expect((thrown as ToolError).code).toBe('CONFIG_ERROR');
    });

    it('names the missing env var but does NOT leak .env/Cloudflare/Workers wording (ENV-1)', () => {
      vi.stubEnv('ILOVEPDF_PUBLIC_KEY', '');
      let message = '';
      try {
        requireEnv('ILOVEPDF_PUBLIC_KEY');
      } catch (err) {
        message = (err as Error).message;
      }

      expect(message).toContain('ILOVEPDF_PUBLIC_KEY');
      expect(message).not.toContain('.env');
      expect(message).not.toMatch(/Cloudflare/i);
      expect(message).not.toMatch(/Workers/i);
    });
  });

  describe('getEnv', () => {
    it('returns undefined for unset keys (ENV-2)', () => {
      vi.stubEnv('SOME_UNSET_KEY', '');
      expect(getEnv('SOME_UNSET_KEY')).toBeUndefined();
    });

    it('reads the value from process.env when set (ENV-2)', () => {
      vi.stubEnv('SOME_SET_KEY', 'hello');
      expect(getEnv('SOME_SET_KEY')).toBe('hello');
    });
  });

  describe('getPublicKey / getWorkdir', () => {
    it('getPublicKey reads ILOVEPDF_PUBLIC_KEY', () => {
      vi.stubEnv('ILOVEPDF_PUBLIC_KEY', 'pk_live_abc');
      expect(getPublicKey()).toBe('pk_live_abc');
    });

    it('getWorkdir reads ILOVEPDF_MCP_WORKDIR and is optional (ENV-3)', () => {
      vi.stubEnv('ILOVEPDF_MCP_WORKDIR', '');
      expect(getWorkdir()).toBeUndefined();

      vi.stubEnv('ILOVEPDF_MCP_WORKDIR', '/tmp/work');
      expect(getWorkdir()).toBe('/tmp/work');
    });
  });

  describe('source scan (ENV-2, ENV-5)', () => {
    const source = readFileSync(
      fileURLToPath(new URL('../../src/lib/env.ts', import.meta.url)),
      'utf8'
    );

    it('contains no Cloudflare env references (ENV-2)', () => {
      expect(source).not.toContain('CLOUDFLARE_ENV');
      expect(source).not.toContain('CloudflareEnv');
    });

    it('contains no ILOVEPDF_SECRET_KEY reference (ENV-5)', () => {
      expect(source).not.toContain('ILOVEPDF_SECRET_KEY');
    });
  });
});
