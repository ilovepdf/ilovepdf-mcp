/**
 * test/tools/handler.test.ts
 *
 * Unit tests for the tool handler orchestrator (tools/handler.ts).
 *
 * This is a UNIT test of orchestration, so the transport-agnostic core is
 * MOCKED: `core/upload-service` (uploadFiles / uploadIntoSharedTask),
 * `core/operation-executor` (execute) and `core/result-builder` (buildResult).
 * The lib layer it composes (file-io allowlist, file-validation, env,
 * option-normalizer) runs FOR REAL against a temp workdir so the handler's
 * validate → resolve → normalize → upload → execute → build pipeline is
 * exercised end to end without touching the network.
 *
 * Coverage:
 *  - TOOL-5: happy path returns `{ content, structuredContent }` from the
 *    builder and passes the builder the correct inputs (op, exec, sources,
 *    inputBytes, allow, startedAt).
 *  - TOOL-4: arity — compress with 2 sources and merge with 1 source both fail
 *    with `VALIDATION_ERROR` before any upload/execute.
 *  - TOOL-8: `output_path` outside the allowlist fails with `FILE_ACCESS_DENIED`
 *    and performs NO write and NO upload (fail-fast, before network work).
 *  - TOOL-9 / ERR-8: failure path returns `isError:true` with a flat error
 *    surface (`success:false`, `error_code`, `retryable`, `error`) in
 *    `structuredContent` and `userMessage` as the `content` text.
 *  - INTERNAL wrapping: a non-`ToolError` throwable is wrapped as `INTERNAL`.
 *  - DEC-2: `normalizeOptions` is applied AFTER defaults merge and BEFORE
 *    `execute`, and the collected warnings are surfaced in the result.
 *  - DEC-5 (CRITICAL): the client-facing failure `structuredContent` carries
 *    ONLY `success/error_code/retryable/error` — the raw `detail` (which may
 *    embed absolute workdir paths) is ABSENT and NO such path appears anywhere
 *    in the returned surface; the FULL `toStructured()` (incl. detail) is
 *    emitted to stderr via the audit-logger.
 */

import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { z } from 'zod';

// --- Mock the core (this is a unit test of handler orchestration) -----------
vi.mock('../../src/core/upload-service.js', () => ({
  uploadFiles: vi.fn(),
  uploadIntoSharedTask: vi.fn(),
}));
vi.mock('../../src/core/operation-executor.js', () => ({
  execute: vi.fn(),
}));
vi.mock('../../src/core/result-builder.js', () => ({
  buildResult: vi.fn(),
}));

import { uploadFiles, uploadIntoSharedTask } from '../../src/core/upload-service.js';
import { execute } from '../../src/core/operation-executor.js';
import { buildResult } from '../../src/core/result-builder.js';
import { log } from '../../src/core/audit-logger.js';
import { makeHandler } from '../../src/tools/handler.js';
import { specFor } from '../../src/domain/operations.js';
import { ToolError } from '../../src/domain/errors.js';
import { RESULT_OUTPUT_SHAPE } from '../../src/contract/result-schema.js';
import type { ExecuteResult } from '../../src/core/operation-executor.js';
import type { TaskCreds } from '../../src/core/upload-service.js';

const RESULT_SCHEMA = z.object(RESULT_OUTPUT_SHAPE);

let work: string;

/** A minimal fake TaskCreds returned by the mocked upload service. */
const FAKE_CREDS: TaskCreds = {
  server: 'api-mock.iloveimg.com',
  task: 'task_mock',
  token: 'token_mock',
  task_tool: 'compress',
  files: [{ server_filename: 's.pdf', filename: 'in.pdf' }],
};

/** A plausible ExecuteResult returned by the mocked executor. */
function makeExec(overrides: Partial<ExecuteResult> = {}): ExecuteResult {
  return {
    download_url: 'https://api-mock.iloveimg.com/v1/download/task_mock?token=x',
    output_filename: 'out.pdf',
    processing_time: '0.42',
    original_size_kb: 100,
    output_size_kb: 50,
    file_count: 1,
    ...overrides,
  };
}

/** Write a file inside the workdir and return its absolute path + byte size. */
function writeFixture(name: string, bytes: number): { p: string; size: number } {
  const p = path.join(work, name);
  writeFileSync(p, Buffer.alloc(bytes, 7));
  return { p, size: bytes };
}

beforeEach(() => {
  work = mkdtempSync(path.join(tmpdir(), 'ilovepdf-handler-'));
  process.env.ILOVEPDF_MCP_WORKDIR = work;
  process.env.ILOVEPDF_PUBLIC_KEY = 'test-public-key';
  delete process.env.ILOVEPDF_MCP_ALLOWED_DIRS;
  vi.mocked(uploadFiles).mockReset().mockResolvedValue(FAKE_CREDS);
  vi.mocked(uploadIntoSharedTask).mockReset().mockResolvedValue(FAKE_CREDS);
  vi.mocked(execute).mockReset().mockResolvedValue(makeExec());
  vi.mocked(buildResult).mockReset();
});

afterEach(() => {
  rmSync(work, { recursive: true, force: true });
  vi.restoreAllMocks();
  delete process.env.ILOVEPDF_MCP_WORKDIR;
  delete process.env.ILOVEPDF_PUBLIC_KEY;
});

// ---------------------------------------------------------------------------
// Happy path (TOOL-5)
// ---------------------------------------------------------------------------

describe('makeHandler — happy path (TOOL-5)', () => {
  it('returns the builder result and feeds the builder the correct inputs', async () => {
    const { p, size } = writeFixture('in.pdf', 4096);
    const fakeExec = makeExec();
    vi.mocked(execute).mockResolvedValue(fakeExec);

    const built = {
      content: [{ type: 'text' as const, text: 'Compressed 1 PDF.' }],
      structuredContent: {
        operation: 'compress-pdf',
        status: 'completed' as const,
        input: { sources: [p], count: 1, totalBytes: size },
        output: {
          path: path.join(work, 'out.pdf'),
          download_url: 'https://api-mock.iloveimg.com/v1/download/task_mock',
          bytes: 50,
          fileCount: 1,
        },
        metrics: { inputBytes: size, outputBytes: 50, ratio: 0.5, durationMs: 3 },
      },
    };
    vi.mocked(buildResult).mockResolvedValue(built);

    const handler = makeHandler(specFor('compress-pdf'));
    const res = await handler({ sources: [p] });

    // Handler returns exactly what the builder produced (no warnings here).
    expect(res).toBe(built);
    expect(res.content).toHaveLength(1);
    // structuredContent validates against the LOCKED result contract.
    expect(() => RESULT_SCHEMA.parse(res.structuredContent)).not.toThrow();
    expect(res.structuredContent.status).toBe('completed');

    // Single-file op → uploadFiles (NOT the shared-task variant).
    expect(uploadFiles).toHaveBeenCalledTimes(1);
    expect(uploadIntoSharedTask).not.toHaveBeenCalled();
    expect(execute).toHaveBeenCalledTimes(1);

    // Builder gets the op, the exec result, the source list, the measured input
    // bytes, a real allowlist and a numeric start timestamp.
    expect(buildResult).toHaveBeenCalledWith(
      expect.objectContaining({
        op: specFor('compress-pdf'),
        exec: fakeExec,
        sources: [p],
        inputBytes: size,
        allow: expect.objectContaining({ roots: expect.any(Array) }),
        startedAt: expect.any(Number),
      })
    );
  });

  it('uses uploadIntoSharedTask for requiresSharedTask operations', async () => {
    const a = writeFixture('a.png', 1024);
    const b = writeFixture('b.png', 2048);
    vi.mocked(buildResult).mockResolvedValue({
      content: [{ type: 'text', text: 'Converted 2 images to PDF.' }],
      structuredContent: {
        operation: 'image-to-pdf',
        status: 'completed',
        input: { sources: [a.p, b.p], count: 2, totalBytes: a.size + b.size },
        output: { path: path.join(work, 'o.pdf'), download_url: 'https://x/y', bytes: 10, fileCount: 1 },
        metrics: { inputBytes: a.size + b.size, outputBytes: 10, ratio: 0.003, durationMs: 2 },
      },
    });

    const handler = makeHandler(specFor('image-to-pdf'));
    await handler({ sources: [a.p, b.p] });

    expect(uploadIntoSharedTask).toHaveBeenCalledTimes(1);
    expect(uploadFiles).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Arity (TOOL-4)
// ---------------------------------------------------------------------------

describe('makeHandler — arity (TOOL-4)', () => {
  it('compress with 2 sources → VALIDATION_ERROR, no upload/execute', async () => {
    const a = writeFixture('a.pdf', 512);
    const b = writeFixture('b.pdf', 512);

    const handler = makeHandler(specFor('compress-pdf'));
    const res = await handler({ sources: [a.p, b.p] });

    expect(res.isError).toBe(true);
    expect(res.structuredContent.error_code).toBe('VALIDATION_ERROR');
    expect(res.structuredContent.status).toBe('failed');
    expect(uploadFiles).not.toHaveBeenCalled();
    expect(uploadIntoSharedTask).not.toHaveBeenCalled();
    expect(execute).not.toHaveBeenCalled();
  });

  it('merge with 1 source → VALIDATION_ERROR, no upload/execute', async () => {
    const a = writeFixture('only.pdf', 512);

    const handler = makeHandler(specFor('merge-pdf'));
    const res = await handler({ sources: [a.p] });

    expect(res.isError).toBe(true);
    expect(res.structuredContent.error_code).toBe('VALIDATION_ERROR');
    expect(uploadFiles).not.toHaveBeenCalled();
    expect(uploadIntoSharedTask).not.toHaveBeenCalled();
    expect(execute).not.toHaveBeenCalled();
  });

  it('image-to-pdf with 1 source → reaches upload and execute (NOT a VALIDATION_ERROR)', async () => {
    // image-to-pdf accepts one or more images (minSources=1, unbounded max).
    // A single image must NOT be rejected by cardinality enforcement.
    const { p, size } = writeFixture('solo.png', 1024);
    vi.mocked(buildResult).mockResolvedValue({
      content: [{ type: 'text', text: 'Converted 1 image to PDF.' }],
      structuredContent: {
        operation: 'image-to-pdf',
        status: 'completed',
        input: { sources: [p], count: 1, totalBytes: size },
        output: { path: path.join(work, 'solo-imagepdf.pdf'), download_url: 'https://x/y', bytes: 20, fileCount: 1 },
        metrics: { inputBytes: size, outputBytes: 20, ratio: 0.02, durationMs: 1 },
      },
    });

    const handler = makeHandler(specFor('image-to-pdf'));
    const res = await handler({ sources: [p] });

    // Single-image path must succeed — cardinality must NOT block it.
    expect(res.isError).toBeUndefined();
    // image-to-pdf is a requiresSharedTask operation regardless of source count.
    expect(uploadIntoSharedTask).toHaveBeenCalledTimes(1);
    expect(uploadFiles).not.toHaveBeenCalled();
    expect(execute).toHaveBeenCalledTimes(1);
  });

  it('image-to-pdf with 2 sources → reaches upload and execute (multi-image path)', async () => {
    const a = writeFixture('img-a.png', 512);
    const b = writeFixture('img-b.png', 512);
    vi.mocked(buildResult).mockResolvedValue({
      content: [{ type: 'text', text: 'Converted 2 images to PDF.' }],
      structuredContent: {
        operation: 'image-to-pdf',
        status: 'completed',
        input: { sources: [a.p, b.p], count: 2, totalBytes: a.size + b.size },
        output: { path: path.join(work, 'out.pdf'), download_url: 'https://x/y', bytes: 10, fileCount: 1 },
        metrics: { inputBytes: a.size + b.size, outputBytes: 10, ratio: 0.01, durationMs: 1 },
      },
    });

    const handler = makeHandler(specFor('image-to-pdf'));
    const res = await handler({ sources: [a.p, b.p] });

    expect(res.isError).toBeUndefined();
    expect(uploadIntoSharedTask).toHaveBeenCalledTimes(1);
    expect(execute).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------
// output_path allowlist (TOOL-8)
// ---------------------------------------------------------------------------

describe('makeHandler — output_path allowlist (TOOL-8)', () => {
  it('output_path outside the allowlist → FILE_ACCESS_DENIED, no write, no upload', async () => {
    const { p } = writeFixture('in.pdf', 1024);
    const outside = path.join(tmpdir(), 'ilovepdf-escape-XYZ', 'evil.pdf');

    const handler = makeHandler(specFor('compress-pdf'));
    const res = await handler({ sources: [p], output_path: outside });

    expect(res.isError).toBe(true);
    expect(res.structuredContent.error_code).toBe('FILE_ACCESS_DENIED');
    // Fail-fast: nothing was uploaded, executed, or written.
    expect(uploadFiles).not.toHaveBeenCalled();
    expect(execute).not.toHaveBeenCalled();
    expect(buildResult).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Failure surface (TOOL-9 / ERR-8) + DEC-5
// ---------------------------------------------------------------------------

describe('makeHandler — failure surface (TOOL-9 / ERR-8, DEC-5)', () => {
  it('maps a ToolError to isError:true with a flat structured error surface', async () => {
    const { p } = writeFixture('in.pdf', 1024);
    vi.mocked(execute).mockRejectedValue(
      new ToolError('UPSTREAM_ERROR', 'internal diagnostic', 'Processing failed. Please try again.', true)
    );

    const handler = makeHandler(specFor('compress-pdf'));
    const res = await handler({ sources: [p] });

    expect(res.isError).toBe(true);
    expect(res.content).toEqual([
      { type: 'text', text: 'Processing failed. Please try again.' },
    ]);
    expect(res.structuredContent).toMatchObject({
      operation: 'compress-pdf',
      status: 'failed',
      success: false,
      error_code: 'UPSTREAM_ERROR',
      retryable: true,
      error: 'Processing failed. Please try again.',
    });
    // The failure surface still validates against the shared result contract.
    expect(() => RESULT_SCHEMA.parse(res.structuredContent)).not.toThrow();
  });

  it('wraps a non-ToolError throwable as INTERNAL', async () => {
    const { p } = writeFixture('in.pdf', 1024);
    vi.mocked(execute).mockRejectedValue(new Error('boom'));

    const handler = makeHandler(specFor('compress-pdf'));
    const res = await handler({ sources: [p] });

    expect(res.isError).toBe(true);
    expect(res.structuredContent.error_code).toBe('INTERNAL');
    expect(res.structuredContent.retryable).toBe(false);
    // The generic userMessage is surfaced, never the raw 'boom' diagnostic.
    expect(res.content[0].text).not.toContain('boom');
  });

  it('DEC-5: detail with an absolute path never leaks to the client; full toStructured goes to stderr', async () => {
    // A URL source keeps the returned surface free of any local absolute path,
    // isolating the DEC-5 assertion to the (fabricated) diagnostic path below.
    const secretAbs =
      process.platform === 'win32'
        ? 'C:\\Users\\svc\\workdir\\secret-output.pdf'
        : '/var/lib/ilovepdf/workdir/secret-output.pdf';
    const userMessage = 'Could not process the file. Please try again.';

    vi.mocked(execute).mockRejectedValue(
      new ToolError('UPSTREAM_ERROR', `Failed writing ${secretAbs}`, userMessage, true)
    );
    const auditSpy = vi.spyOn(log, 'error').mockImplementation(() => {});

    const handler = makeHandler(specFor('compress-pdf'));
    const res = await handler({ sources: ['https://example.com/doc.pdf'] });

    // Client-facing surface: no `detail`, no absolute diagnostic path anywhere.
    expect(res.structuredContent).not.toHaveProperty('detail');
    expect(JSON.stringify(res)).not.toContain(secretAbs);
    expect(res.content[0].text).toBe(userMessage);

    // The FULL toStructured() (incl. detail) is audited to stderr. Inspect the
    // actual argument object (not a JSON string — Windows paths escape their
    // backslashes under JSON.stringify).
    expect(auditSpy).toHaveBeenCalled();
    const auditedPayload = auditSpy.mock.calls[0][1] as { detail?: string };
    expect(auditedPayload.detail).toContain(secretAbs);
  });
});

// ---------------------------------------------------------------------------
// SSRF pre-check for URL inputs (SSRF-6)
// ---------------------------------------------------------------------------

describe('makeHandler — SSRF-6: URL input pre-check', () => {
  it('rejects an internal IP-literal URL source → VALIDATION_ERROR before any upload', async () => {
    // compress-pdf accepts exactly one source.
    const handler = makeHandler(specFor('compress-pdf'));
    const res = await handler({ sources: ['http://127.0.0.1:8080/x.pdf'] });

    expect(res.isError).toBe(true);
    expect(res.structuredContent.error_code).toBe('VALIDATION_ERROR');
    // The upload service must NOT have been called — rejection is pre-hand-off.
    expect(uploadFiles).not.toHaveBeenCalled();
    expect(uploadIntoSharedTask).not.toHaveBeenCalled();
    expect(execute).not.toHaveBeenCalled();
  });

  it('rejects a private-range URL source (10.x.x.x) → VALIDATION_ERROR', async () => {
    const handler = makeHandler(specFor('compress-pdf'));
    const res = await handler({ sources: ['http://10.0.0.5/secret.pdf'] });

    expect(res.isError).toBe(true);
    expect(res.structuredContent.error_code).toBe('VALIDATION_ERROR');
    expect(uploadFiles).not.toHaveBeenCalled();
  });

  it('rejects a non-http(s) scheme URL → VALIDATION_ERROR', async () => {
    const handler = makeHandler(specFor('compress-pdf'));
    const res = await handler({ sources: ['ftp://example.com/doc.pdf'] });

    expect(res.isError).toBe(true);
    expect(res.structuredContent.error_code).toBe('VALIDATION_ERROR');
    expect(uploadFiles).not.toHaveBeenCalled();
  });

  it('allows a public URL (hostname, not IP literal) to pass through to upload', async () => {
    // Public-looking hostname → passes the IP-literal pre-check (no DNS at this stage).
    // Provide a mock builder result so the happy path completes.
    vi.mocked(buildResult).mockResolvedValue({
      content: [{ type: 'text', text: 'Compressed 1 PDF.' }],
      structuredContent: {
        operation: 'compress-pdf',
        status: 'completed',
        input: { sources: ['https://example.com/doc.pdf'], count: 1, totalBytes: 0 },
        output: {
          path: '/tmp/out.pdf',
          download_url: 'https://api-mock.iloveimg.com/v1/download/task_mock',
          bytes: 10,
          fileCount: 1,
        },
        metrics: { inputBytes: 0, outputBytes: 10, ratio: 0, durationMs: 1 },
      },
    });

    const handler = makeHandler(specFor('compress-pdf'));
    const res = await handler({ sources: ['https://example.com/doc.pdf'] });

    // The URL passed the pre-check and was handed to the upload service.
    expect(uploadFiles).toHaveBeenCalledTimes(1);
    expect(res.isError).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Options validation (DEC-6) — must surface as structured VALIDATION_ERROR
// ---------------------------------------------------------------------------

describe('makeHandler — options validation (DEC-6)', () => {
  it('compress-pdf with compression_level="ultra" → VALIDATION_ERROR, no upload/execute', async () => {
    const { p } = writeFixture('in.pdf', 1024);
    const handler = makeHandler(specFor('compress-pdf'));
    const res = await handler({ sources: [p], options: { compression_level: 'ultra' } });

    expect(res.isError).toBe(true);
    expect(res.structuredContent.error_code).toBe('VALIDATION_ERROR');
    expect(res.structuredContent.success).toBe(false);
    // Validation must fire BEFORE any upload/execute work.
    expect(uploadFiles).not.toHaveBeenCalled();
    expect(uploadIntoSharedTask).not.toHaveBeenCalled();
    expect(execute).not.toHaveBeenCalled();
  });

  it('pdf-to-jpg with pdfjpg_mode="bogus" → VALIDATION_ERROR, no upload/execute', async () => {
    const { p } = writeFixture('in.pdf', 1024);
    const handler = makeHandler(specFor('pdf-to-jpg'));
    const res = await handler({ sources: [p], options: { pdfjpg_mode: 'bogus' } });

    expect(res.isError).toBe(true);
    expect(res.structuredContent.error_code).toBe('VALIDATION_ERROR');
    expect(uploadFiles).not.toHaveBeenCalled();
    expect(execute).not.toHaveBeenCalled();
  });

  it('valid compression_level="low" passes validation and reaches execute', async () => {
    const { p } = writeFixture('in.pdf', 1024);
    vi.mocked(buildResult).mockResolvedValue({
      content: [{ type: 'text', text: 'Compressed.' }],
      structuredContent: {
        operation: 'compress-pdf',
        status: 'completed',
        input: { sources: [p], count: 1, totalBytes: 1024 },
        output: { path: path.join(work, 'out.pdf'), download_url: 'https://x/y', bytes: 10, fileCount: 1 },
        metrics: { inputBytes: 1024, outputBytes: 10, ratio: 0.01, durationMs: 1 },
      },
    });

    const handler = makeHandler(specFor('compress-pdf'));
    const res = await handler({ sources: [p], options: { compression_level: 'low' } });

    // Valid options pass validation and the pipeline completes.
    expect(res.isError).toBeUndefined();
    expect(uploadFiles).toHaveBeenCalledTimes(1);
    expect(execute).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------
// Option normalization (DEC-2)
// ---------------------------------------------------------------------------

describe('makeHandler — option normalization (DEC-2)', () => {
  it('normalizes options after merging defaults and before execute, surfacing warnings', async () => {
    const { p } = writeFixture('in.pdf', 1024);
    vi.mocked(buildResult).mockResolvedValue({
      content: [{ type: 'text', text: 'Added a watermark to 1 PDF.' }],
      structuredContent: {
        operation: 'watermark',
        status: 'completed',
        input: { sources: [p], count: 1, totalBytes: 1024 },
        output: { path: path.join(work, 'o.pdf'), download_url: 'https://x/y', bytes: 10, fileCount: 1 },
        metrics: { inputBytes: 1024, outputBytes: 10, ratio: 0.01, durationMs: 1 },
      },
    });

    const handler = makeHandler(specFor('watermark'));
    const res = await handler({ sources: [p], options: { font_family: 'Wingdings' } });

    // normalizeOptions fuzzy-matched the unsupported font → Arial Unicode MS,
    // and that normalized value is what execute received (proves order).
    expect(execute).toHaveBeenCalledTimes(1);
    const passedOptions = vi.mocked(execute).mock.calls[0][2] as Record<string, unknown>;
    expect(passedOptions.font_family).toBe('Arial Unicode MS');
    // Default `mode: 'text'` from the registry survived the merge.
    expect(passedOptions.mode).toBe('text');

    // The warning is surfaced in the SINGLE content block (TOOL-7 preserved).
    expect(res.content).toHaveLength(1);
    expect(res.content[0].text).toContain('Arial Unicode MS');
  });
});
