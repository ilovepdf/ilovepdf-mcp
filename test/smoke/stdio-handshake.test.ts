/**
 * test/smoke/stdio-handshake.test.ts
 *
 * Integration smoke test: real stdio MCP handshake (R6 / LOG-1 / LOG-3).
 *
 * Spawns `node dist/index.js` as a child process, performs the MCP
 * `initialize → notifications/initialized → tools/list` exchange over
 * stdin/stdout, and asserts:
 *
 *   (a) the process starts — pid is assigned immediately after spawn
 *   (b) `initialize` returns a valid JSON-RPC result with `serverInfo`
 *   (c) `tools/list` returns exactly 9 tools whose names match the
 *       DEC-1 mechanical set (iLovePDF_<snake_case>)
 *   (d) LOG-3 — every line written to the child's stdout is a valid
 *       JSON-RPC 2.0 frame; no non-protocol output leaks through
 *
 * Design constraints:
 *   - Self-contained: builds dist if absent (gate ordering is preferred,
 *     but a missing build is handled gracefully via execSync).
 *   - Deterministic: 15 s generous timeout; polling-based line reader
 *     with no race conditions.
 *   - No leaks: child is killed in afterAll (runs even on failure/timeout)
 *     so the vitest runner cannot hang.
 *   - Dummy `ILOVEPDF_PUBLIC_KEY` given so LOG-6 startup-warning fires to
 *     stderr only; the real API is never contacted.
 */

import { describe, it, expect, afterAll, beforeAll } from 'vitest';
import { spawn, type ChildProcess, execSync } from 'child_process';
import { fileURLToPath } from 'url';
import { existsSync } from 'fs';
import * as path from 'path';

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------

const __filename = fileURLToPath(import.meta.url);
const PROJECT_ROOT = path.resolve(path.dirname(__filename), '../../');
const DIST_ENTRY = path.join(PROJECT_ROOT, 'dist', 'index.js');

// ---------------------------------------------------------------------------
// DEC-1 mechanical tool name set (9 tools — unlock temporarily disabled — single
// source of truth here mirrors src/domain/operations.ts to confirm the
// handshake returns the canonical set without importing from src/).
// ---------------------------------------------------------------------------

const EXPECTED_TOOL_NAMES: ReadonlyArray<string> = [
  'iLovePDF_compress_pdf',
  'iLovePDF_pdf_to_jpg',
  'iLovePDF_image_to_pdf',
  'iLovePDF_office_to_pdf',
  'iLovePDF_merge_pdf',
  'iLovePDF_split_pdf',
  // 'iLovePDF_unlock', // TEMPORARILY DISABLED — re-enable to publish.
  'iLovePDF_watermark',
  'iLovePDF_pagenumber',
  'iLovePDF_pdf_ocr',
];

// ---------------------------------------------------------------------------
// Timing constants
// ---------------------------------------------------------------------------

/** Total vitest test timeout (ms). Must exceed RESPONSE_TIMEOUT × 2. */
const TEST_TIMEOUT = 15_000;

/** Per-response wait ceiling (ms). */
const RESPONSE_TIMEOUT = 10_000;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Poll every 50 ms until `lines.length >= count` or `timeoutMs` elapses.
 * Rejects with a descriptive error on timeout so the assertion surface is clear.
 */
function waitForLines(
  lines: string[],
  count: number,
  timeoutMs: number
): Promise<void> {
  return new Promise((resolve, reject) => {
    const start = Date.now();
    const check = () => {
      if (lines.length >= count) {
        resolve();
      } else if (Date.now() - start >= timeoutMs) {
        reject(
          new Error(
            `Timeout after ${timeoutMs} ms: expected ≥${count} JSON-RPC line(s) on stdout, ` +
            `received ${lines.length}.`
          )
        );
      } else {
        setTimeout(check, 50);
      }
    };
    check();
  });
}

/**
 * Find the first JSON-RPC response object with `id === targetId` in the
 * collected stdout lines. Throws if not found.
 */
function findResponseById(
  lines: string[],
  targetId: number
): Record<string, unknown> {
  for (const line of lines) {
    const obj = JSON.parse(line) as Record<string, unknown>;
    if (obj['id'] === targetId) return obj;
  }
  throw new Error(
    `No JSON-RPC response with id=${targetId} found in stdout lines:\n` +
    lines.join('\n')
  );
}

// ---------------------------------------------------------------------------
// Smoke test suite
// ---------------------------------------------------------------------------

describe('stdio handshake smoke test (R6 / LOG-1 / LOG-3)', () => {
  let child: ChildProcess | null = null;
  /** All non-empty lines received on the child's stdout during the test. */
  const stdoutLines: string[] = [];

  // -------------------------------------------------------------------------
  // Setup: ensure dist/index.js exists before spawning.
  // -------------------------------------------------------------------------

  beforeAll(() => {
    if (!existsSync(DIST_ENTRY)) {
      // Build if not already present (supports running npm run test without
      // a prior explicit build step).
      execSync('npm run build', { cwd: PROJECT_ROOT, stdio: 'pipe' });
    }
  });

  // -------------------------------------------------------------------------
  // Teardown: guaranteed kill so vitest cannot hang waiting for the child.
  // -------------------------------------------------------------------------

  afterAll(() => {
    if (child && !child.killed) {
      child.kill('SIGTERM');
    }
  });

  // -------------------------------------------------------------------------
  // Main test: full initialize → tools/list handshake
  // -------------------------------------------------------------------------

  it(
    'performs initialize → tools/list and asserts (a)–(d)',
    async () => {
      // (a) Spawn — pid is assigned immediately; process failure surfaces via
      //     the stdio error event or a missing response (handled by waitForLines timeout).
      child = spawn('node', [DIST_ENTRY], {
        stdio: ['pipe', 'pipe', 'pipe'],
        env: {
          ...process.env,
          // Dummy key: server starts normally; LOG-6 warning → stderr only.
          ILOVEPDF_PUBLIC_KEY: 'smoke-test-dummy-key',
        },
      });

      expect(child.pid, 'child process must have a pid after spawn').toBeDefined();
      expect(typeof child.pid).toBe('number');

      // Accumulate stdout into newline-delimited JSON-RPC lines.
      let buffer = '';
      child.stdout!.on('data', (chunk: Buffer) => {
        buffer += chunk.toString();
        const parts = buffer.split('\n');
        // Last element is the incomplete tail (may be empty string).
        buffer = parts.pop() ?? '';
        for (const part of parts) {
          const trimmed = part.trim();
          if (trimmed) stdoutLines.push(trimmed);
        }
      });

      // Helper: write a JSON-RPC frame to the child's stdin.
      const sendFrame = (obj: object): void => {
        child!.stdin!.write(JSON.stringify(obj) + '\n');
      };

      // ------------------------------------------------------------------
      // Step 1 — initialize
      // ------------------------------------------------------------------

      sendFrame({
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: {
          protocolVersion: '2024-11-05',
          capabilities: {},
          clientInfo: { name: 'smoke-test', version: '0.0.1' },
        },
      });

      await waitForLines(stdoutLines, 1, RESPONSE_TIMEOUT);

      // (b) initialize response must contain serverInfo
      const initResp = findResponseById(stdoutLines, 1);
      expect(initResp['jsonrpc']).toBe('2.0');
      expect(
        initResp['result'],
        'initialize response must have a result'
      ).toBeDefined();

      const initResult = initResp['result'] as Record<string, unknown>;
      expect(
        initResult['serverInfo'],
        'initialize result must have serverInfo'
      ).toBeDefined();

      const serverInfo = initResult['serverInfo'] as Record<string, unknown>;
      expect(
        typeof serverInfo['name'],
        'serverInfo.name must be a string'
      ).toBe('string');
      expect(
        typeof serverInfo['version'],
        'serverInfo.version must be a string'
      ).toBe('string');

      // ------------------------------------------------------------------
      // Step 2 — notifications/initialized (required before further requests)
      // ------------------------------------------------------------------

      sendFrame({ jsonrpc: '2.0', method: 'notifications/initialized' });

      // ------------------------------------------------------------------
      // Step 3 — tools/list
      // ------------------------------------------------------------------

      sendFrame({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} });

      // Some servers emit an extra notification before the response —
      // keep waiting until we find the frame with id=2.
      await waitForLines(stdoutLines, 2, RESPONSE_TIMEOUT);

      // (c) tools/list must return exactly 9 tools matching the DEC-1 set
      const listResp = findResponseById(stdoutLines, 2);
      expect(listResp['jsonrpc']).toBe('2.0');
      expect(
        listResp['result'],
        'tools/list response must have a result'
      ).toBeDefined();

      const listResult = listResp['result'] as Record<string, unknown>;
      const tools = listResult['tools'] as Array<Record<string, unknown>>;
      expect(Array.isArray(tools), 'tools must be an array').toBe(true);
      expect(tools, 'tools/list must return exactly 9 tools').toHaveLength(9);

      const toolNames = tools.map(t => t['name'] as string);
      for (const expected of EXPECTED_TOOL_NAMES) {
        expect(
          toolNames,
          `DEC-1 tool "${expected}" must appear in tools/list`
        ).toContain(expected);
      }

      // (d) LOG-3 — every stdout line must be a valid JSON-RPC 2.0 frame
      for (const line of stdoutLines) {
        let parsed: Record<string, unknown> | undefined;
        expect(() => {
          parsed = JSON.parse(line) as Record<string, unknown>;
        }, `stdout line must be valid JSON: ${line}`).not.toThrow();
        expect(
          parsed!['jsonrpc'],
          `every stdout line must have jsonrpc:"2.0" (line: ${line})`
        ).toBe('2.0');
      }
    },
    TEST_TIMEOUT
  );
});
