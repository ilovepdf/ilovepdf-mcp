/**
 * test/smoke/validation-e2e.test.ts
 *
 * Spawn-based E2E regression guard for fix E3 (IPv4-mapped IPv6 SSRF bypass)
 * and fixes F1/F2 (options-validation structured error surface — DEC-6).
 *
 * These tests caught discrepancies that UNIT tests missed because unit tests
 * call the handler DIRECTLY, bypassing the MCP SDK's input-validation layer
 * that only fires in the registered server. This suite goes through the REAL
 * server path by:
 *   1. Spawning `node dist/index.js` as a child process.
 *   2. Connecting via `@modelcontextprotocol/sdk/client` StdioClientTransport.
 *   3. Calling tools and asserting that the result carries the correct
 *      `structuredContent.error_code === 'VALIDATION_ERROR'`.
 *
 * Design constraints:
 *   - Deterministic: no iLovePDF API key/network needed — both failures are
 *     caught at pre-flight validation BEFORE any file is uploaded.
 *   - Self-contained: builds `dist/` if absent (same pattern as
 *     test/smoke/stdio-handshake.test.ts).
 *   - Generous timeout: 30 s to accommodate cold builds.
 *   - Guaranteed teardown: `afterAll` closes the client even on failure/timeout.
 *
 * Mirrors the approach in `sandbox/mcp-client.mjs` but wrapped in vitest.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { existsSync, execSync } from 'fs';
import { fileURLToPath } from 'url';
import * as path from 'path';

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------

const __filename = fileURLToPath(import.meta.url);
const PROJECT_ROOT = path.resolve(path.dirname(__filename), '../../');
const DIST_ENTRY = path.join(PROJECT_ROOT, 'dist', 'index.js');

/**
 * A real PDF file that lives in the project sandbox. Used as the `sources`
 * argument for the options-validation test so the handler can resolve the
 * source (local file read) before validateOptions fires. The test asserts a
 * VALIDATION_ERROR from validateOptions — no API call is made.
 */
const SAMPLE_PDF = path.join(PROJECT_ROOT, 'sandbox', 'sample.pdf');

// ---------------------------------------------------------------------------
// Timing constants
// ---------------------------------------------------------------------------

/** Total vitest test-suite timeout (ms). Covers build + two tool calls. */
const TEST_TIMEOUT = 30_000;

// ---------------------------------------------------------------------------
// Shared client / transport (one server instance for the whole suite)
// ---------------------------------------------------------------------------

let client: Client;
let transport: StdioClientTransport;

// ---------------------------------------------------------------------------
// Setup / teardown
// ---------------------------------------------------------------------------

beforeAll(async () => {
  // Build dist if absent — supports running `npm run test` without a prior
  // explicit build step (gate-ordering is the primary path; this fallback
  // prevents silent failures in bare test runs).
  if (!existsSync(DIST_ENTRY)) {
    execSync('npm run build', { cwd: PROJECT_ROOT, stdio: 'pipe' });
  }

  transport = new StdioClientTransport({
    command: 'node',
    args: [DIST_ENTRY],
    env: {
      // Cast: process.env may have undefined values; StdioClientTransport
      // only uses entries it recognises, undefined slots are harmless.
      ...(process.env as Record<string, string>),
      // Dummy key: server starts normally; LOG-6 warning → stderr only.
      // validateOptions / assertUrlPrecheck both fire BEFORE any API call.
      ILOVEPDF_PUBLIC_KEY: 'e2e-validation-test-dummy',
      // Pin the allowlist root to the project dir so sandbox/sample.pdf is
      // accessible for the options-validation call.
      ILOVEPDF_MCP_WORKDIR: PROJECT_ROOT,
    },
  });

  client = new Client(
    { name: 'validation-e2e-test', version: '0.0.0' },
    { capabilities: {} }
  );

  await client.connect(transport);
}, TEST_TIMEOUT);

afterAll(async () => {
  // Guaranteed teardown — runs even on test failure or timeout so the
  // vitest runner cannot hang waiting for the child process.
  try {
    await client?.close();
  } catch {
    // Ignore errors during shutdown (child may already be dead).
  }
});

// ---------------------------------------------------------------------------
// Validation E2E assertions
// ---------------------------------------------------------------------------

describe('validation-e2e (real server path — SDK schema + handler)', () => {
  it(
    'F1/DEC-6: compress-pdf with compression_level="ultra" → structuredContent.error_code=VALIDATION_ERROR',
    async () => {
      // Before fix: SDK intercepts the strict schema → -32602 protocol error
      // (no structuredContent). After fix: loosened SDK schema → handler runs
      // → validateOptions throws → toErrorResult returns the structured surface.
      const result = await client.callTool({
        name: 'ilovepdf_compress_pdf',
        arguments: {
          sources: [SAMPLE_PDF],
          options: { compression_level: 'ultra' },
        },
      });

      const sc = result.structuredContent as Record<string, unknown> | undefined;
      expect(sc, 'structuredContent must be present').toBeDefined();
      expect(sc?.error_code).toBe('VALIDATION_ERROR');
      expect(sc?.success).toBe(false);
    },
    TEST_TIMEOUT
  );

  it(
    'E3: IPv4-mapped IPv6 http://[::ffff:169.254.169.254]/ → structuredContent.error_code=VALIDATION_ERROR (not INTERNAL)',
    async () => {
      // Before fix: assertUrlPrecheck skips mixed dotted-quad IPv6 (net.isIPv6
      // returns false) → URL delegated to iLovePDF → INTERNAL error without
      // structuredContent. After fix: hostname.includes(':') triggers
      // isBlockedIpv6 → VALIDATION_ERROR returned with the structured surface.
      const result = await client.callTool({
        name: 'ilovepdf_compress_pdf',
        arguments: {
          sources: ['http://[::ffff:169.254.169.254]/doc.pdf'],
        },
      });

      const sc = result.structuredContent as Record<string, unknown> | undefined;
      expect(sc, 'structuredContent must be present').toBeDefined();
      expect(sc?.error_code).toBe('VALIDATION_ERROR');
      expect(sc?.success).toBe(false);
    },
    TEST_TIMEOUT
  );
});
