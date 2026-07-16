/**
 * test/tools/descriptions.test.ts
 *
 * Contract tests for `tools/descriptions.ts` (TOOL-7).
 *
 * The headless server exposes ONE MCP tool per operation. Each tool needs a
 * SHORT, client-agnostic description that a generic MCP client (Claude Desktop,
 * Cursor, etc.) can show and route on. These tests lock three properties for
 * EVERY op in the registry:
 *   1. describeTool(op) is a short, non-empty string.
 *   2. It carries NO widget / ChatGPT / Skybridge / OpenAI-app wording — the
 *      old descriptions assumed a ChatGPT widget UX that no longer exists.
 *   3. It conveys the local-file/URL input semantics of this headless server
 *      (input comes from local paths or URLs, not attachments/uploads).
 *
 * Coverage is driven off OPERATION_NAMES so the suite fails the moment a new
 * op is added without a description.
 */

import { describe, it, expect } from 'vitest';
import { OPERATION_NAMES } from '../../src/domain/operations.js';
import { describeTool } from '../../src/tools/descriptions.js';

// Wording that betrays the old ChatGPT-widget UX. None may appear in any
// client-agnostic description. Matched case-insensitively.
const FORBIDDEN_WORDING = [
  'widget',
  'chatgpt',
  'skybridge',
  'openai app',
  'apps sdk',
  'in-card',
  'card',
  'attach', // attachment/upload flow is widget-only
];

// A short description stays well under this budget (single sentence + input hint).
const MAX_LENGTH = 320;

describe('describeTool coverage (TOOL-7)', () => {
  it('returns a description for every op in OPERATION_NAMES', () => {
    for (const op of OPERATION_NAMES) {
      const desc = describeTool(op);
      expect(typeof desc, `describeTool("${op}") type`).toBe('string');
    }
  });

  it('every description is non-empty', () => {
    for (const op of OPERATION_NAMES) {
      expect(describeTool(op).trim().length, `describeTool("${op}") length`).toBeGreaterThan(0);
    }
  });

  it('every description is SHORT', () => {
    for (const op of OPERATION_NAMES) {
      const desc = describeTool(op);
      expect(desc.length, `describeTool("${op}") should be short`).toBeLessThanOrEqual(
        MAX_LENGTH
      );
    }
  });
});

describe('describeTool client-agnostic wording (TOOL-7)', () => {
  it('contains NO widget/ChatGPT/Skybridge wording', () => {
    for (const op of OPERATION_NAMES) {
      const desc = describeTool(op).toLowerCase();
      for (const banned of FORBIDDEN_WORDING) {
        expect(
          desc.includes(banned),
          `describeTool("${op}") must not mention "${banned}"`
        ).toBe(false);
      }
    }
  });
});

describe('describeTool input semantics (TOOL-7)', () => {
  it('conveys local-file/URL input for every op', () => {
    // A headless MCP client provides inputs as local file paths or URLs. Every
    // description must signal this so a client knows what to pass.
    const semantics = /(local\s+file|file\s+path|path|url)/i;
    for (const op of OPERATION_NAMES) {
      expect(describeTool(op), `describeTool("${op}") input semantics`).toMatch(semantics);
    }
  });
});
