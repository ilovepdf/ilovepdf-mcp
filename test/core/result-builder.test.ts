/**
 * test/core/result-builder.test.ts
 *
 * Unit tests for the headless result builder (core/result-builder.ts).
 *
 * Coverage (TOOL-5, TOOL-7, TOOL-8, DEC-4, R1, R5):
 * - Download → write → metrics → LOCKED structuredContent (TOOL-5), validated
 *   against RESULT_OUTPUT_SHAPE.
 * - Exactly one markdown `content` block naming the operation, the produced
 *   file's absolute path, and `2.4 MB → 1.1 MB (54% smaller)` (TOOL-7).
 * - Default-filename derivation when `output_path` is omitted (TOOL-8) and
 *   honoring an explicit `output_path`.
 * - Multi-file output → single `.zip` + `fileCount` (R5).
 * - Non-OK download → ToolError('UPSTREAM_ERROR', retryable:true) (R1).
 * - DEC-4: the returned `download_url` carries NO `token=` query param and no
 *   JWT — host + path only; the authoritative result is the local `output.path`.
 *
 * The shared mock fetch router serves the download endpoint so no network is
 * touched.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, existsSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promises as dnsPromises } from 'node:dns';
import { z } from 'zod';
import {
  installMockILovePDFFetch,
  TEST_SERVER,
  TEST_TASK,
  TEST_TOKEN,
  type MockILovePDFHandle,
} from '../helpers/mock-ilovepdf-fetch.js';
import { buildResult } from '../../src/core/result-builder.js';
import { specFor } from '../../src/domain/operations.js';
import { loadAllowlist, type Allowlist } from '../../src/lib/file-io.js';
import { ToolError, isToolError } from '../../src/domain/errors.js';
import { RESULT_OUTPUT_SHAPE } from '../../src/contract/result-schema.js';
import type { ExecuteResult } from '../../src/core/operation-executor.js';

let mock: MockILovePDFHandle;
let work: string;
let allow: Allowlist;

/** A raw, tokenized download URL exactly as iLovePDF returns it. */
const RAW_DOWNLOAD_URL = `https://${TEST_SERVER}/v1/download/${TEST_TASK}?token=${TEST_TOKEN}`;

/** Build a plausible ExecuteResult; override any field per-test. */
function makeExec(overrides: Partial<ExecuteResult> = {}): ExecuteResult {
  return {
    download_url: RAW_DOWNLOAD_URL,
    output_filename: 'output.pdf',
    processing_time: '0.42',
    original_size_kb: 2458,
    output_size_kb: 1126,
    file_count: 1,
    ...overrides,
  };
}

/** Set the mocked download endpoint to return a buffer of a given length. */
function setDownloadSize(bytes: number): void {
  mock.config.download = { body: new Uint8Array(bytes) };
}

/** Awaits `promise`, returning the ToolError it rejects with. */
async function catchToolErrorAsync(promise: Promise<unknown>): Promise<ToolError> {
  try {
    await promise;
  } catch (err) {
    if (isToolError(err)) return err;
    throw err;
  }
  throw new Error('expected the promise to reject with a ToolError but it resolved');
}

beforeEach(() => {
  mock = installMockILovePDFFetch();
  work = mkdtempSync(path.join(tmpdir(), 'result-builder-'));
  allow = loadAllowlist({ ILOVEPDF_MCP_WORKDIR: work } as NodeJS.ProcessEnv);
  // Mock DNS so the SSRF guard inside safeFetch does NOT make real lookups.
  // api1g.ilovepdf.com (TEST_SERVER) is a hostname — resolve it to a public IP.
  vi.spyOn(dnsPromises, 'lookup').mockResolvedValue(
    [{ address: '1.2.3.4', family: 4 }] as Awaited<ReturnType<typeof dnsPromises.lookup>>
  );
});

afterEach(() => {
  mock.restore();
  vi.restoreAllMocks();
  rmSync(work, { recursive: true, force: true });
});

describe('buildResult — success surface (TOOL-5)', () => {
  it('downloads, writes, and returns a LOCKED structuredContent that validates against RESULT_OUTPUT_SHAPE', async () => {
    setDownloadSize(1153433);

    const result = await buildResult({
      op: specFor('compress-pdf'),
      exec: makeExec(),
      sources: [path.join(work, 'in.pdf')],
      inputBytes: 2516582,
      allow,
      startedAt: Date.now(),
    });

    const sc = result.structuredContent;
    expect(sc.operation).toBe('compress-pdf');
    expect(sc.status).toBe('completed');
    expect(sc.input).toEqual({
      sources: [path.join(work, 'in.pdf')],
      count: 1,
      totalBytes: 2516582,
    });
    expect(sc.output.bytes).toBe(1153433);
    expect(sc.output.fileCount).toBe(1);
    expect(sc.metrics.inputBytes).toBe(2516582);
    expect(sc.metrics.outputBytes).toBe(1153433);
    expect(sc.metrics.ratio).toBeCloseTo(1153433 / 2516582, 5);
    expect(sc.metrics.durationMs).toBeGreaterThanOrEqual(0);

    // The whole structuredContent must satisfy the LOCKED output contract.
    expect(() => z.object(RESULT_OUTPUT_SHAPE).parse(sc)).not.toThrow();
  });

  it('writes the produced bytes to disk at output.path', async () => {
    setDownloadSize(2048);

    const result = await buildResult({
      op: specFor('compress-pdf'),
      exec: makeExec(),
      sources: [path.join(work, 'in.pdf')],
      inputBytes: 4096,
      allow,
      startedAt: Date.now(),
    });

    expect(existsSync(result.structuredContent.output.path)).toBe(true);
    expect(readFileSync(result.structuredContent.output.path).byteLength).toBe(2048);
  });

  it('guards divide-by-zero: ratio is finite when inputBytes is 0', async () => {
    setDownloadSize(1024);

    const result = await buildResult({
      op: specFor('compress-pdf'),
      exec: makeExec({ original_size_kb: 0 }),
      sources: [path.join(work, 'in.pdf')],
      inputBytes: 0,
      allow,
      startedAt: Date.now(),
    });

    expect(Number.isFinite(result.structuredContent.metrics.ratio)).toBe(true);
  });
});

describe('buildResult — markdown content (TOOL-7)', () => {
  it('emits exactly one markdown block naming the op, the before→after sizes, and the absolute path', async () => {
    setDownloadSize(1153433);

    const result = await buildResult({
      op: specFor('compress-pdf'),
      exec: makeExec(),
      sources: [path.join(work, 'in.pdf')],
      inputBytes: 2516582,
      allow,
      startedAt: Date.now(),
    });

    expect(result.content).toHaveLength(1);
    expect(result.content[0].type).toBe('text');

    const text = result.content[0].text;
    expect(text).toContain('2.4 MB → 1.1 MB (54% smaller)');
    expect(text).toMatch(/compress/i);
    expect(text).toContain(result.structuredContent.output.path);
  });
});

describe('buildResult — output filename (TOOL-8)', () => {
  it('derives the default filename in the workdir when output_path is omitted', async () => {
    setDownloadSize(512);

    const result = await buildResult({
      op: specFor('compress-pdf'),
      exec: makeExec({ output_filename: '' }),
      sources: [path.join(work, 'report.pdf')],
      inputBytes: 1024,
      allow,
      startedAt: Date.now(),
    });

    const out = result.structuredContent.output.path;
    expect(path.dirname(out)).toBe(work);
    expect(path.basename(out)).toBe('report-compress.pdf');
  });

  it('honors an explicit output_path', async () => {
    setDownloadSize(512);

    const explicit = path.join(work, 'nested', 'custom.pdf');
    const result = await buildResult({
      op: specFor('compress-pdf'),
      exec: makeExec(),
      sources: [path.join(work, 'in.pdf')],
      inputBytes: 1024,
      output_path: explicit,
      allow,
      startedAt: Date.now(),
    });

    expect(result.structuredContent.output.path).toBe(explicit);
    expect(existsSync(explicit)).toBe(true);
  });
});

describe('buildResult — multi-file output (R5)', () => {
  it('saves a single .zip and reports fileCount for split / pdf-to-jpg', async () => {
    setDownloadSize(4096);

    const result = await buildResult({
      op: specFor('pdf-to-jpg'),
      exec: makeExec({ file_count: 3, output_filename: 'output.pdf' }),
      sources: [path.join(work, 'scan.pdf')],
      inputBytes: 8192,
      allow,
      startedAt: Date.now(),
    });

    expect(result.structuredContent.output.path.endsWith('.zip')).toBe(true);
    expect(result.structuredContent.output.fileCount).toBe(3);
    expect(existsSync(result.structuredContent.output.path)).toBe(true);
  });
});

describe('buildResult — DEC-4 credential stripping', () => {
  it('strips the token query param and any JWT from the returned download_url', async () => {
    setDownloadSize(1024);

    const result = await buildResult({
      op: specFor('compress-pdf'),
      exec: makeExec(),
      sources: [path.join(work, 'in.pdf')],
      inputBytes: 2048,
      allow,
      startedAt: Date.now(),
    });

    const url = result.structuredContent.output.download_url;
    expect(url).not.toContain('token=');
    expect(url).not.toContain(TEST_TOKEN);
    // No query string at all — the credential lived entirely in the query.
    expect(url).not.toContain('?');
    // Host + path are preserved so the file remains addressable.
    expect(url).toBe(`https://${TEST_SERVER}/v1/download/${TEST_TASK}`);
  });
});

// ---------------------------------------------------------------------------
// SSRF: redirect host allow-list gap (Fix 2)
// ---------------------------------------------------------------------------

describe('buildResult — SSRF: download redirect host allow-list', () => {
  it('rejects a download that 3xx-redirects to an external host → VALIDATION_ERROR, no output file written', async () => {
    // The download endpoint returns a 301 redirect to an attacker-controlled host.
    // The safeFetch allowHost predicate must reject the redirect target before
    // any bytes are written to disk.
    mock.config.download = {
      status: 301,
      headers: { location: 'https://attacker.example/stolen-file.pdf' },
    };

    const err = await catchToolErrorAsync(
      buildResult({
        op: specFor('compress-pdf'),
        exec: makeExec(),
        sources: [path.join(work, 'in.pdf')],
        inputBytes: 1024,
        allow,
        startedAt: Date.now(),
      })
    );

    expect(err.code).toBe('VALIDATION_ERROR');
    // No output file must be written — the work dir should still be empty.
    expect(readdirSync(work)).toHaveLength(0);
  });
});

describe('buildResult — download failure (R1)', () => {
  it('throws ToolError(UPSTREAM_ERROR, retryable:true) on a non-OK download', async () => {
    mock.forceError('download', 500);

    const err = await catchToolErrorAsync(
      buildResult({
        op: specFor('compress-pdf'),
        exec: makeExec(),
        sources: [path.join(work, 'in.pdf')],
        inputBytes: 2048,
        allow,
        startedAt: Date.now(),
      })
    );

    expect(err.code).toBe('UPSTREAM_ERROR');
    expect(err.retryable).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// SSRF-5 — host allow-list for download_url
// ---------------------------------------------------------------------------

describe('buildResult — SSRF-5: download_url host allow-list', () => {
  it('rejects a download_url on an unexpected host → VALIDATION_ERROR, no output file written', async () => {
    const badExec = makeExec({
      download_url: 'https://evil.example.com/v1/download/task?token=xyz',
    });

    const err = await catchToolErrorAsync(
      buildResult({
        op: specFor('compress-pdf'),
        exec: badExec,
        sources: [path.join(work, 'in.pdf')],
        inputBytes: 1024,
        allow,
        startedAt: Date.now(),
      })
    );

    expect(err.code).toBe('VALIDATION_ERROR');
    // No output file must be written — the work dir should still be empty.
    expect(readdirSync(work)).toHaveLength(0);
  });

  it('allows a download_url on a regional iLovePDF host (e.g. api7.ilovepdf.com)', async () => {
    // api7.ilovepdf.com ends in .ilovepdf.com — host check should pass.
    // The DNS spy from beforeEach returns a public IP, so SSRF-3 also passes.
    setDownloadSize(512);
    const exec = makeExec({
      download_url: `https://api7.ilovepdf.com/v1/download/${TEST_TASK}?token=${TEST_TOKEN}`,
    });

    await expect(
      buildResult({
        op: specFor('compress-pdf'),
        exec,
        sources: [path.join(work, 'in.pdf')],
        inputBytes: 1024,
        allow,
        startedAt: Date.now(),
      })
    ).resolves.toBeDefined();
  });
});
