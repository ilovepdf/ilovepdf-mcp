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
 *     test/smoke/stdio-handshake.test.ts). Creates its own temp workdir and
 *     generates a minimal valid PDF into it — no dependency on gitignored
 *     files such as gitignored build artifacts.
 *   - Generous timeout: 30 s to accommodate cold builds.
 *   - Guaranteed teardown: `afterAll` closes the client and removes the temp
 *     dir even on failure/timeout.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { existsSync, execSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { fileURLToPath } from 'url';
import * as path from 'path';

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------

const __filename = fileURLToPath(import.meta.url);
const PROJECT_ROOT = path.resolve(path.dirname(__filename), '../../');
const DIST_ENTRY = path.join(PROJECT_ROOT, 'dist', 'index.js');

// ---------------------------------------------------------------------------
// Minimal valid PDF generator
// ---------------------------------------------------------------------------

/**
 * Generate a minimal single-page PDF as a Buffer with correct xref offsets.
 * The content is structurally valid (Acrobat-readable) but carries no visual
 * content — sufficient for the pre-flight validation tests below, which never
 * upload to iLovePDF.
 */
function makeMinimalPdf(): Buffer {
  const header = '%PDF-1.4\n';
  const obj1 = '1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n';
  const obj2 = '2 0 obj\n<< /Type /Pages /Kids [3 0 R] /Count 1 >>\nendobj\n';
  const obj3 =
    '3 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] >>\nendobj\n';

  const off1 = header.length;
  const off2 = off1 + obj1.length;
  const off3 = off2 + obj2.length;
  const xrefOffset = off3 + obj3.length;

  const pad = (n: number) => String(n).padStart(10, '0');

  const xref =
    'xref\n' +
    '0 4\n' +
    `0000000000 65535 f \n` +
    `${pad(off1)} 00000 n \n` +
    `${pad(off2)} 00000 n \n` +
    `${pad(off3)} 00000 n \n` +
    'trailer\n' +
    '<< /Size 4 /Root 1 0 R >>\n' +
    'startxref\n' +
    `${xrefOffset}\n` +
    '%%EOF\n';

  return Buffer.from(header + obj1 + obj2 + obj3 + xref, 'latin1');
}

// ---------------------------------------------------------------------------
// Timing constants
// ---------------------------------------------------------------------------

/** Total vitest test-suite timeout (ms). Covers build + two tool calls. */
const TEST_TIMEOUT = 30_000;

// ---------------------------------------------------------------------------
// Shared state (one server instance + one temp dir for the whole suite)
// ---------------------------------------------------------------------------

let client: Client;
let transport: StdioClientTransport;
/** Temp workdir created in beforeAll and removed in afterAll. */
let tempDir: string;
/** Absolute path to the generated sample PDF inside tempDir. */
let samplePdf: string;

// ---------------------------------------------------------------------------
// Setup / teardown
// ---------------------------------------------------------------------------

beforeAll(async () => {
  // Create a fresh temp workdir and write a minimal valid PDF into it.
  // This makes the suite self-contained — no gitignored files are required.
  tempDir = realpathSync(mkdtempSync(path.join(tmpdir(), 'ilovepdf-e2e-')));
  samplePdf = path.join(tempDir, 'sample.pdf');
  writeFileSync(samplePdf, makeMinimalPdf());

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
      // Pin the allowlist root to the generated temp dir so samplePdf is
      // accessible for the options-validation call.
      ILOVEPDF_MCP_WORKDIR: tempDir,
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

  // Remove the temp workdir created in beforeAll.
  try {
    if (tempDir && existsSync(tempDir)) {
      rmSync(tempDir, { recursive: true, force: true });
    }
  } catch {
    // Best-effort cleanup — test isolation does not depend on this succeeding.
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
      //
      // The handler reads samplePdf from the temp workdir (resolveSources),
      // validates the .pdf extension, then validateOptions fires on the
      // invalid compression_level value — no API call is ever made.
      const result = await client.callTool({
        name: 'ilovepdf_compress_pdf',
        arguments: {
          sources: [samplePdf],
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
      //
      // This test uses a URL source and has no dependency on any local file.
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
