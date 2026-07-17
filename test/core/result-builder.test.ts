/**
 * test/core/result-builder.test.ts
 *
 * Unit tests for the headless result builder (core/result-builder.ts).
 *
 * Coverage (TOOL-5, TOOL-7, TOOL-8, DEC-4, R1, R5 + new features):
 * - Download → write → metrics → LOCKED structuredContent (TOOL-5), validated
 *   against RESULT_OUTPUT_SHAPE.
 * - Content array layout: text block first, then optional embedded blob, then
 *   resource_link (always).
 * - Default-filename derivation when `output_path` is omitted (TOOL-8) and
 *   honoring an explicit `output_path`.
 * - Multi-file output → single `.zip` + `fileCount` (R5).
 * - Non-OK download → ToolError('UPSTREAM_ERROR', retryable:true) (R1).
 * - DEC-4: the returned `download_url` carries NO `token=` query param and no
 *   JWT — host + path only; the authoritative result is the local `output.path`.
 * - Overwrite protection: throws VALIDATION_ERROR when the resolved output path
 *   equals any resolved local input source path (data-safety).
 * - Embedded resource: blob is included for small outputs; omitted above the cap.
 * - Resource link: always present in the content array.
 * - Opt-in tokenized URL: ILOVEPDF_MCP_RETURN_DOWNLOAD_URL flag controls whether
 *   the raw token is returned in structuredContent.output.download_url.
 *
 * The shared mock fetch router serves the download endpoint so no network is
 * touched.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, existsSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
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
  vi.unstubAllEnvs();
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

describe('buildResult — markdown content + content layout (TOOL-7)', () => {
  it('text block is always first and contains the op summary with sizes and path', async () => {
    setDownloadSize(1153433);

    const result = await buildResult({
      op: specFor('compress-pdf'),
      exec: makeExec(),
      sources: [path.join(work, 'in.pdf')],
      inputBytes: 2516582,
      allow,
      startedAt: Date.now(),
    });

    // First block is always the text summary.
    expect(result.content[0].type).toBe('text');
    const text = (result.content[0] as { type: 'text'; text: string }).text;
    expect(text).toContain('2.4 MB → 1.1 MB (54% smaller)');
    expect(text).toMatch(/compress/i);
    expect(text).toContain(result.structuredContent.output.path);
  });

  it('content array contains at least the text block and a resource_link when embed is enabled', async () => {
    vi.stubEnv('ILOVEPDF_MCP_EMBED_RESULT', 'true');
    setDownloadSize(512);

    const result = await buildResult({
      op: specFor('compress-pdf'),
      exec: makeExec({ output_filename: '' }),
      sources: [path.join(work, 'in.pdf')],
      inputBytes: 1024,
      allow,
      startedAt: Date.now(),
    });

    // At least text + resource_link.
    expect(result.content.length).toBeGreaterThanOrEqual(2);
    // Last block is always the resource_link.
    const last = result.content[result.content.length - 1];
    expect(last.type).toBe('resource_link');
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

// ---------------------------------------------------------------------------
// Task 1 — Overwrite protection (data-safety)
// ---------------------------------------------------------------------------

describe('buildResult — overwrite protection (data-safety)', () => {
  it('default derived filename never equals the input path (fallback pattern differs)', async () => {
    setDownloadSize(512);
    // When upstream returns empty filename, the fallback <stem>-<apiTool>.<ext>
    // always differs from the source (document.pdf → document-compress.pdf).
    const inputPath = path.join(work, 'document.pdf');

    const result = await buildResult({
      op: specFor('compress-pdf'),
      exec: makeExec({ output_filename: '' }),
      sources: [inputPath],
      inputBytes: 1024,
      allow,
      startedAt: Date.now(),
      resolvedLocalPaths: [inputPath],
    });

    expect(result.structuredContent.output.path).not.toBe(inputPath);
    expect(path.basename(result.structuredContent.output.path)).toBe('document-compress.pdf');
  });

  it('upstream filename matching input basename → fallback derivation, no VALIDATION_ERROR', async () => {
    // When iLovePDF returns the SAME filename as the input (e.g. compress returns
    // "document.pdf"), deriveOutputFilename detects the collision and falls back
    // to "document-compress.pdf" so the overwrite guard never fires.
    setDownloadSize(512);
    const inputPath = path.join(work, 'document.pdf');

    const result = await buildResult({
      op: specFor('compress-pdf'),
      exec: makeExec({ output_filename: 'document.pdf' }), // same as input!
      sources: [inputPath],
      inputBytes: 1024,
      allow,
      startedAt: Date.now(),
      resolvedLocalPaths: [inputPath],
    });

    // Falls back to the safe pattern — does NOT throw.
    expect(path.basename(result.structuredContent.output.path)).toBe('document-compress.pdf');
    expect(result.structuredContent.output.path).not.toBe(inputPath);
  });

  it('explicit output_path equal to an input source → VALIDATION_ERROR, no write', async () => {
    setDownloadSize(512);
    const inputPath = path.join(work, 'in.pdf');
    // The explicit output_path resolves to the same canonical path as the input.

    const err = await catchToolErrorAsync(
      buildResult({
        op: specFor('compress-pdf'),
        exec: makeExec({ output_filename: 'other.pdf' }), // different derived name
        sources: [inputPath],
        inputBytes: 1024,
        output_path: inputPath, // explicit → same as input
        allow,
        startedAt: Date.now(),
        resolvedLocalPaths: [inputPath],
      })
    );

    expect(err.code).toBe('VALIDATION_ERROR');
    expect(err.userMessage).toContain('overwrite');
    // No file should be written.
    expect(readdirSync(work)).toHaveLength(0);
  });

  it('different output_path from input → succeeds without VALIDATION_ERROR', async () => {
    setDownloadSize(512);
    const inputPath = path.join(work, 'in.pdf');
    const outputPath = path.join(work, 'out.pdf');

    await expect(
      buildResult({
        op: specFor('compress-pdf'),
        exec: makeExec({ output_filename: 'other.pdf' }),
        sources: [inputPath],
        inputBytes: 1024,
        output_path: outputPath,
        allow,
        startedAt: Date.now(),
        resolvedLocalPaths: [inputPath],
      })
    ).resolves.toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// Task 2A — Embedded resource + resource_link in content
// ---------------------------------------------------------------------------

describe('buildResult — embedded resource + resource_link', () => {
  it('includes embedded resource blob for a small output (default 10 MB cap) when embed is enabled', async () => {
    // 2 KB is well under the 10 MB default cap — blob should be present when embed is on.
    vi.stubEnv('ILOVEPDF_MCP_EMBED_RESULT', 'true');
    setDownloadSize(2048);

    const result = await buildResult({
      op: specFor('compress-pdf'),
      exec: makeExec({ output_filename: '' }),
      sources: [path.join(work, 'in.pdf')],
      inputBytes: 4096,
      allow,
      startedAt: Date.now(),
    });

    const embedded = result.content.find(b => b.type === 'resource') as
      | { type: 'resource'; resource: { uri: string; mimeType: string; blob: string } }
      | undefined;
    expect(embedded).toBeDefined();
    expect(embedded!.resource.mimeType).toBe('application/pdf');
    // The URI must be a file:// URI pointing to the output path.
    const outputPath = result.structuredContent.output.path;
    expect(embedded!.resource.uri).toBe(pathToFileURL(outputPath).toString());
    // Base64 decodes to the exact bytes written.
    const decoded = Buffer.from(embedded!.resource.blob, 'base64');
    expect(decoded.byteLength).toBe(2048);
  });

  it('embedded resource uses application/zip for multi-file (zip) outputs when embed is enabled', async () => {
    vi.stubEnv('ILOVEPDF_MCP_EMBED_RESULT', 'true');
    setDownloadSize(4096);

    const result = await buildResult({
      op: specFor('pdf-to-jpg'),
      exec: makeExec({ file_count: 3, output_filename: 'output.pdf' }),
      sources: [path.join(work, 'scan.pdf')],
      inputBytes: 8192,
      allow,
      startedAt: Date.now(),
    });

    const embedded = result.content.find(b => b.type === 'resource') as
      | { type: 'resource'; resource: { mimeType: string } }
      | undefined;
    expect(embedded).toBeDefined();
    expect(embedded!.resource.mimeType).toBe('application/zip');
  });

  it('includes a resource_link pointing to the output file when embed is enabled', async () => {
    vi.stubEnv('ILOVEPDF_MCP_EMBED_RESULT', 'true');
    setDownloadSize(512);

    const result = await buildResult({
      op: specFor('compress-pdf'),
      exec: makeExec({ output_filename: '' }),
      sources: [path.join(work, 'in.pdf')],
      inputBytes: 1024,
      allow,
      startedAt: Date.now(),
    });

    const link = result.content.find(b => b.type === 'resource_link') as
      | { type: 'resource_link'; uri: string; name: string; mimeType: string }
      | undefined;
    expect(link).toBeDefined();
    const outputPath = result.structuredContent.output.path;
    expect(link!.uri).toBe(pathToFileURL(outputPath).toString());
    expect(link!.name).toBe(path.basename(outputPath));
    expect(link!.mimeType).toBe('application/pdf');
  });

  it('omits the blob but keeps resource_link when output exceeds the cap (embed enabled)', async () => {
    // Set cap to 1 MB; download 2 MB → blob omitted, resource_link still present.
    vi.stubEnv('ILOVEPDF_MCP_EMBED_RESULT', 'true');
    vi.stubEnv('ILOVEPDF_MCP_MAX_INLINE_MB', '1');
    setDownloadSize(2 * 1024 * 1024); // 2 MB

    const result = await buildResult({
      op: specFor('compress-pdf'),
      exec: makeExec({ output_filename: '' }),
      sources: [path.join(work, 'in.pdf')],
      inputBytes: 4 * 1024 * 1024,
      allow,
      startedAt: Date.now(),
    });

    // Blob must be absent.
    expect(result.content.find(b => b.type === 'resource')).toBeUndefined();
    // Resource link must still be present.
    expect(result.content.find(b => b.type === 'resource_link')).toBeDefined();
  });

  it('omits the blob when cap is 0 (inline embedding disabled) but resource_link is still present when embed is on', async () => {
    vi.stubEnv('ILOVEPDF_MCP_EMBED_RESULT', 'true');
    vi.stubEnv('ILOVEPDF_MCP_MAX_INLINE_MB', '0');
    setDownloadSize(512);

    const result = await buildResult({
      op: specFor('compress-pdf'),
      exec: makeExec({ output_filename: '' }),
      sources: [path.join(work, 'in.pdf')],
      inputBytes: 1024,
      allow,
      startedAt: Date.now(),
    });

    expect(result.content.find(b => b.type === 'resource')).toBeUndefined();
    // Even with embedding disabled, resource_link is present.
    expect(result.content.find(b => b.type === 'resource_link')).toBeDefined();
    // And text block is still first.
    expect(result.content[0].type).toBe('text');
  });

  it('text block is always the first content item regardless of cap', async () => {
    setDownloadSize(1024);

    const resultSmall = await buildResult({
      op: specFor('compress-pdf'),
      exec: makeExec({ output_filename: '' }),
      sources: [path.join(work, 'small.pdf')],
      inputBytes: 2048,
      allow,
      startedAt: Date.now(),
    });
    expect(resultSmall.content[0].type).toBe('text');

    vi.stubEnv('ILOVEPDF_MCP_MAX_INLINE_MB', '0');
    setDownloadSize(512);
    const resultCapDisabled = await buildResult({
      op: specFor('compress-pdf'),
      exec: makeExec({ output_filename: 'b.pdf' }),
      sources: [path.join(work, 'b.pdf')],
      inputBytes: 1024,
      allow,
      startedAt: Date.now(),
    });
    expect(resultCapDisabled.content[0].type).toBe('text');
  });
});

// ---------------------------------------------------------------------------
// ILOVEPDF_MCP_EMBED_RESULT — opt-in embedded resource (Claude Desktop safety)
// ---------------------------------------------------------------------------

describe('buildResult — ILOVEPDF_MCP_EMBED_RESULT opt-in flag', () => {
  it('DEFAULT (flag unset): content is text-only — no resource or resource_link (Claude Desktop safe)', async () => {
    // No vi.stubEnv — default is off.
    setDownloadSize(2048);

    const result = await buildResult({
      op: specFor('compress-pdf'),
      exec: makeExec({ output_filename: '' }),
      sources: [path.join(work, 'in.pdf')],
      inputBytes: 4096,
      allow,
      startedAt: Date.now(),
    });

    // Exactly one content item: the text block.
    expect(result.content).toHaveLength(1);
    expect(result.content[0].type).toBe('text');
    // No resource or resource_link — Claude Desktop guarantee.
    expect(result.content.find(b => b.type === 'resource')).toBeUndefined();
    expect(result.content.find(b => b.type === 'resource_link')).toBeUndefined();
  });

  it('EMBED_RESULT=true: appends resource blob AND resource_link after the text block', async () => {
    vi.stubEnv('ILOVEPDF_MCP_EMBED_RESULT', 'true');
    setDownloadSize(2048);

    const result = await buildResult({
      op: specFor('compress-pdf'),
      exec: makeExec({ output_filename: '' }),
      sources: [path.join(work, 'in.pdf')],
      inputBytes: 4096,
      allow,
      startedAt: Date.now(),
    });

    expect(result.content[0].type).toBe('text');

    const embedded = result.content.find(b => b.type === 'resource') as
      | { type: 'resource'; resource: { uri: string; mimeType: string; blob: string } }
      | undefined;
    expect(embedded).toBeDefined();
    expect(embedded!.resource.mimeType).toBe('application/pdf');
    // Base64 decodes to the exact bytes written.
    const decoded = Buffer.from(embedded!.resource.blob, 'base64');
    expect(decoded.byteLength).toBe(2048);

    expect(result.content.find(b => b.type === 'resource_link')).toBeDefined();
  });

  it('EMBED_RESULT=1: also enables embedded resource', async () => {
    vi.stubEnv('ILOVEPDF_MCP_EMBED_RESULT', '1');
    setDownloadSize(512);

    const result = await buildResult({
      op: specFor('compress-pdf'),
      exec: makeExec({ output_filename: '' }),
      sources: [path.join(work, 'in.pdf')],
      inputBytes: 1024,
      allow,
      startedAt: Date.now(),
    });

    expect(result.content.find(b => b.type === 'resource')).toBeDefined();
    expect(result.content.find(b => b.type === 'resource_link')).toBeDefined();
  });

  it('EMBED_RESULT=true + output above cap: blob omitted, resource_link still present', async () => {
    vi.stubEnv('ILOVEPDF_MCP_EMBED_RESULT', 'true');
    vi.stubEnv('ILOVEPDF_MCP_MAX_INLINE_MB', '1');
    setDownloadSize(2 * 1024 * 1024); // 2 MB — above the 1 MB cap

    const result = await buildResult({
      op: specFor('compress-pdf'),
      exec: makeExec({ output_filename: '' }),
      sources: [path.join(work, 'in.pdf')],
      inputBytes: 4 * 1024 * 1024,
      allow,
      startedAt: Date.now(),
    });

    // Blob is omitted (exceeds cap).
    expect(result.content.find(b => b.type === 'resource')).toBeUndefined();
    // Resource link is still present when embed is enabled, even above the cap.
    expect(result.content.find(b => b.type === 'resource_link')).toBeDefined();
  });

  it('EMBED_RESULT=true + cap=0: blob omitted, resource_link still present, text first', async () => {
    vi.stubEnv('ILOVEPDF_MCP_EMBED_RESULT', 'true');
    vi.stubEnv('ILOVEPDF_MCP_MAX_INLINE_MB', '0');
    setDownloadSize(512);

    const result = await buildResult({
      op: specFor('compress-pdf'),
      exec: makeExec({ output_filename: '' }),
      sources: [path.join(work, 'in.pdf')],
      inputBytes: 1024,
      allow,
      startedAt: Date.now(),
    });

    // Blob is omitted when cap is 0.
    expect(result.content.find(b => b.type === 'resource')).toBeUndefined();
    // Resource link is still present (cap=0 only disables the blob, not the link).
    expect(result.content.find(b => b.type === 'resource_link')).toBeDefined();
    expect(result.content[0].type).toBe('text');
  });

  it('DEFAULT (flag unset) + large output: still text-only (cap applies only when embed is on)', async () => {
    // Even if output is small (under any cap), the default strips resource and resource_link.
    vi.stubEnv('ILOVEPDF_MCP_MAX_INLINE_MB', '100');
    setDownloadSize(512);

    const result = await buildResult({
      op: specFor('compress-pdf'),
      exec: makeExec({ output_filename: '' }),
      sources: [path.join(work, 'in.pdf')],
      inputBytes: 1024,
      allow,
      startedAt: Date.now(),
    });

    expect(result.content).toHaveLength(1);
    expect(result.content[0].type).toBe('text');
    expect(result.content.find(b => b.type === 'resource')).toBeUndefined();
    expect(result.content.find(b => b.type === 'resource_link')).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Task 3B — Opt-in tokenized download URL
// ---------------------------------------------------------------------------

describe('buildResult — opt-in tokenized download URL (DEC-4 / Task 3)', () => {
  it('default (flag unset): strips token from download_url (DEC-4 unchanged)', async () => {
    // Ensure flag is not set.
    vi.stubEnv('ILOVEPDF_MCP_RETURN_DOWNLOAD_URL', '');
    setDownloadSize(512);

    const result = await buildResult({
      op: specFor('compress-pdf'),
      exec: makeExec(),
      sources: [path.join(work, 'in.pdf')],
      inputBytes: 1024,
      allow,
      startedAt: Date.now(),
    });

    const url = result.structuredContent.output.download_url;
    expect(url).not.toContain('token=');
    expect(url).not.toContain(TEST_TOKEN);
    expect(url).not.toContain('?');
  });

  it('flag true: returns the raw tokenized URL in structuredContent.output.download_url', async () => {
    vi.stubEnv('ILOVEPDF_MCP_RETURN_DOWNLOAD_URL', 'true');
    setDownloadSize(512);

    const result = await buildResult({
      op: specFor('compress-pdf'),
      exec: makeExec(),
      sources: [path.join(work, 'in.pdf')],
      inputBytes: 1024,
      allow,
      startedAt: Date.now(),
    });

    const url = result.structuredContent.output.download_url;
    // Token is present when the flag is on.
    expect(url).toContain(`token=${TEST_TOKEN}`);
    // Full raw URL preserved.
    expect(url).toBe(RAW_DOWNLOAD_URL);
  });

  it('flag "1": also enables the tokenized URL', async () => {
    vi.stubEnv('ILOVEPDF_MCP_RETURN_DOWNLOAD_URL', '1');
    setDownloadSize(512);

    const result = await buildResult({
      op: specFor('compress-pdf'),
      exec: makeExec(),
      sources: [path.join(work, 'in.pdf')],
      inputBytes: 1024,
      allow,
      startedAt: Date.now(),
    });

    expect(result.structuredContent.output.download_url).toContain(TEST_TOKEN);
  });

  it('resource_link and embedded blob still use the local file:// URI regardless of flag', async () => {
    // The flag affects only structuredContent.output.download_url; content blocks
    // always point to the local output file (when embed is enabled).
    vi.stubEnv('ILOVEPDF_MCP_RETURN_DOWNLOAD_URL', 'true');
    vi.stubEnv('ILOVEPDF_MCP_EMBED_RESULT', 'true');
    setDownloadSize(512);

    const result = await buildResult({
      op: specFor('compress-pdf'),
      exec: makeExec({ output_filename: '' }),
      sources: [path.join(work, 'in.pdf')],
      inputBytes: 1024,
      allow,
      startedAt: Date.now(),
    });

    const link = result.content.find(b => b.type === 'resource_link') as
      | { type: 'resource_link'; uri: string }
      | undefined;
    expect(link!.uri).toMatch(/^file:\/\//);

    const embedded = result.content.find(b => b.type === 'resource') as
      | { type: 'resource'; resource: { uri: string } }
      | undefined;
    if (embedded) {
      expect(embedded.resource.uri).toMatch(/^file:\/\//);
    }
  });
});

// ---------------------------------------------------------------------------
// Download line in markdown text block
// ---------------------------------------------------------------------------

describe('buildResult — Download line in text block', () => {
  it('flag true: text block includes a Download line with the tokenized URL', async () => {
    vi.stubEnv('ILOVEPDF_MCP_RETURN_DOWNLOAD_URL', 'true');
    setDownloadSize(512);

    const result = await buildResult({
      op: specFor('compress-pdf'),
      exec: makeExec(),
      sources: [path.join(work, 'in.pdf')],
      inputBytes: 1024,
      allow,
      startedAt: Date.now(),
    });

    const text = (result.content[0] as { type: 'text'; text: string }).text;
    // Must contain the Download line with the full tokenized URL.
    expect(text).toContain('Download:');
    expect(text).toContain(RAW_DOWNLOAD_URL);
    expect(text).toContain(`token=${TEST_TOKEN}`);
    // The Download line must appear after the summary line (separated by two newlines).
    expect(text).toContain(`\n\nDownload: ${RAW_DOWNLOAD_URL}`);
  });

  it('flag false (default): text block has no Download line and no token (DEC-4 preserved)', async () => {
    // Do not stub the flag — default is off.
    setDownloadSize(512);

    const result = await buildResult({
      op: specFor('compress-pdf'),
      exec: makeExec(),
      sources: [path.join(work, 'in.pdf')],
      inputBytes: 1024,
      allow,
      startedAt: Date.now(),
    });

    const text = (result.content[0] as { type: 'text'; text: string }).text;
    expect(text).not.toContain('Download:');
    expect(text).not.toContain('token=');
    expect(text).not.toContain(TEST_TOKEN);
  });

  it('flag explicitly empty string: no Download line (DEC-4 preserved)', async () => {
    vi.stubEnv('ILOVEPDF_MCP_RETURN_DOWNLOAD_URL', '');
    setDownloadSize(512);

    const result = await buildResult({
      op: specFor('compress-pdf'),
      exec: makeExec(),
      sources: [path.join(work, 'in.pdf')],
      inputBytes: 1024,
      allow,
      startedAt: Date.now(),
    });

    const text = (result.content[0] as { type: 'text'; text: string }).text;
    expect(text).not.toContain('Download:');
    expect(text).not.toContain(TEST_TOKEN);
  });

  it('flag true: summary line is preserved and Download line is appended, not replacing it', async () => {
    vi.stubEnv('ILOVEPDF_MCP_RETURN_DOWNLOAD_URL', 'true');
    setDownloadSize(1153433);

    const result = await buildResult({
      op: specFor('compress-pdf'),
      exec: makeExec(),
      sources: [path.join(work, 'in.pdf')],
      inputBytes: 2516582,
      allow,
      startedAt: Date.now(),
    });

    const text = (result.content[0] as { type: 'text'; text: string }).text;
    // The original summary content is still there.
    expect(text).toContain('2.4 MB → 1.1 MB');
    expect(text).toContain('Saved to');
    // The Download line is appended after.
    expect(text).toContain(`\n\nDownload: ${RAW_DOWNLOAD_URL}`);
  });
});
