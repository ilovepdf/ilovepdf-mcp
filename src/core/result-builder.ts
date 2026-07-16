/**
 * core/result-builder.ts (NEW — design §4, §8 row 15)
 *
 * Headless result builder. Replaces the widget `services/response-builder.ts`.
 * Given an `ExecuteResult` from the operation-executor, it:
 *   1. Downloads the produced file from `exec.download_url` (fetch → arrayBuffer).
 *   2. Derives the output filename (or honors an explicit `output_path`).
 *   3. Resolves + writes the destination through the allowlisted `lib/file-io`.
 *   4. Computes metrics (input/output bytes, ratio, wall-clock duration).
 *   5. Assembles the LOCKED `structuredContent` (TOOL-5) plus one concise,
 *      per-op-family markdown `content` block (TOOL-7).
 *
 * It composes `lib/file-io.ts` and takes NO transport dependency.
 *
 * ## DEC-4 — strip the credential from the returned download_url
 * iLovePDF download URLs embed a task-scoped bearer token in the query string
 * (`?token=<jwt>`). Before the URL is placed in `structuredContent.output`, the
 * ENTIRE query string is dropped, leaving host + path only. The authoritative
 * result is always the local `output.path`; the URL is informational and must
 * never carry the credential. The raw (tokenized) URL is used ONLY for the
 * download fetch and is never logged (the audit logger redacts it regardless).
 *
 * ## R1 — non-OK download → typed error
 * A network failure or non-2xx download response throws
 * `ToolError('UPSTREAM_ERROR', …, retryable:true)` — the caller can retry.
 *
 * NOTE: T061 wired `safeFetch` + the `.ilovepdf.com` host allow-list into
 * `downloadOutput`. See `assertAllowedDownloadHost` and the inline comments
 * for the SSRF-5/4/3/2/1 defence chain.
 */

import { ToolError } from '../domain/errors.js';
import type { OperationSpec } from '../domain/operation-types.js';
import type { ExecuteResult } from './operation-executor.js';
import {
  deriveOutputFilename,
  resolveOutputPath,
  writeOutputFile,
  type Allowlist,
} from '../lib/file-io.js';
import { safeFetch, type SafeFetchOptions } from '../lib/url-guard.js';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/** Everything the builder needs to turn an ExecuteResult into a tool result. */
export interface BuildResultInput {
  /** The operation spec from the OPERATIONS registry. */
  op: OperationSpec;
  /** The successful result returned by the operation-executor. */
  exec: ExecuteResult;
  /** Local source paths the tool acted on (for `input.sources` + derivation). */
  sources: string[];
  /**
   * Total input bytes (Σ local file sizes read by the handler). When 0 (e.g. a
   * URL source), falls back to `exec.original_size_kb * 1024`.
   */
  inputBytes: number;
  /** Explicit caller output path; omitted → default workdir + derived name. */
  output_path?: string;
  /** Allowlist used to resolve + validate the write destination. */
  allow: Allowlist;
  /** Wall-clock start time (`Date.now()`) used to compute `durationMs`. */
  startedAt: number;
}

/** The LOCKED success `structuredContent` (validates against RESULT_OUTPUT_SHAPE). */
export interface ResultStructuredContent {
  operation: string;
  status: 'completed';
  input: { sources: string[]; count: number; totalBytes: number };
  output: { path: string; download_url: string; bytes: number; fileCount: number };
  metrics: { inputBytes: number; outputBytes: number; ratio: number; durationMs: number };
}

/** An MCP tool result: one markdown `content` block + `structuredContent`. */
export interface ToolCallResult {
  content: Array<{ type: 'text'; text: string }>;
  structuredContent: ResultStructuredContent;
}

// ---------------------------------------------------------------------------
// Download (SSRF-5 — host allow-list + safeFetch, T061)
// ---------------------------------------------------------------------------

/**
 * The iLovePDF download host is a dynamically-assigned regional server whose
 * name is returned by the `start` API call (e.g. `api7.ilovepdf.com`). The
 * allow-list is a **suffix check**: the hostname must end in `.ilovepdf.com`
 * (case-insensitive). This constrains the download to the iLovePDF domain
 * family while accommodating any regional server (SSRF-5).
 */
function assertAllowedDownloadHost(rawUrl: string): void {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    throw new ToolError(
      'VALIDATION_ERROR',
      `Invalid download URL: "${rawUrl}".`,
      'The produced file download URL is invalid.',
      false
    );
  }
  const host = parsed.hostname.toLowerCase();
  if (!host.endsWith('.ilovepdf.com')) {
    throw new ToolError(
      'VALIDATION_ERROR',
      `Download URL host "${parsed.hostname}" is not an allowed iLovePDF host.`,
      'The produced file download URL is not on an expected server.',
      false
    );
  }
}

/**
 * True when `host` belongs to the iLovePDF domain family (suffix check).
 * Used as the `allowHost` predicate for `safeFetch` so that the `.ilovepdf.com`
 * constraint is enforced on EVERY URL in the redirect chain, not just the
 * initial download URL (SSRF-5 / SSRF-4 gap fix).
 */
function isIlovePdfHost(host: string): boolean {
  return host.toLowerCase().endsWith('.ilovepdf.com');
}

/** safeFetch options passed to every download request (SSRF-5 across redirects). */
const DOWNLOAD_FETCH_OPTS: SafeFetchOptions = { allowHost: isIlovePdfHost };

/**
 * Download the produced file via `safeFetch` (SSRF-5 + SSRF-4).
 *
 * 1. Validates the host is within the `.ilovepdf.com` domain (SSRF-5).
 * 2. Uses `safeFetch` with `allowHost: isIlovePdfHost`, which applies the full
 *    SSRF guard (SSRF-1/2/3), re-validates any redirect Location before
 *    following (SSRF-4), AND enforces the `.ilovepdf.com` host constraint on
 *    EVERY hop in the redirect chain so a malicious 3xx cannot escape to an
 *    arbitrary host (redirect-host-allow-list gap fix).
 * 3. A network failure or non-2xx status throws
 *    `ToolError('UPSTREAM_ERROR', …, retryable:true)` (R1).
 *
 * The raw tokenized URL is used ONLY for the download and is never returned
 * or logged; the credential is stripped before the URL enters structuredContent
 * (DEC-4).
 */
async function downloadOutput(url: string): Promise<ArrayBuffer> {
  // SSRF-5: reject non-iLovePDF hosts before any network activity.
  assertAllowedDownloadHost(url);

  let res: Response;
  try {
    // safeFetch validates the SSRF guard + re-checks every redirect target
    // (SSRF-4) and enforces the iLovePDF host allow-list on every hop (SSRF-5).
    res = await safeFetch(url, undefined, DOWNLOAD_FETCH_OPTS);
  } catch (err) {
    // Re-throw ToolErrors (VALIDATION_ERROR from the guard, etc.) unchanged.
    if (err instanceof ToolError) throw err;
    throw new ToolError(
      'UPSTREAM_ERROR',
      `Failed to download produced file: ${err instanceof Error ? err.message : String(err)}`,
      'Could not download the produced file. Please try again.',
      true
    );
  }
  if (!res.ok) {
    throw new ToolError(
      'UPSTREAM_ERROR',
      `Download returned HTTP ${res.status} for the produced file.`,
      'Could not download the produced file. Please try again.',
      true
    );
  }
  return res.arrayBuffer();
}

// ---------------------------------------------------------------------------
// DEC-4 — strip the credential from the download URL
// ---------------------------------------------------------------------------

/**
 * Return host + path only, dropping the entire query string (which carries the
 * task-scoped `?token=<jwt>` credential). On any parse failure, return an empty
 * string rather than risk leaking a tokenized URL.
 */
function stripCredential(rawUrl: string): string {
  try {
    const u = new URL(rawUrl);
    return `${u.origin}${u.pathname}`;
  } catch {
    return '';
  }
}

// ---------------------------------------------------------------------------
// Metrics + formatting
// ---------------------------------------------------------------------------

/** Human-readable byte size, e.g. `2.4 MB`. */
function formatBytes(bytes: number): string {
  const KB = 1024;
  const MB = KB * 1024;
  const GB = MB * 1024;
  if (bytes >= GB) return `${(bytes / GB).toFixed(1)} GB`;
  if (bytes >= MB) return `${(bytes / MB).toFixed(1)} MB`;
  if (bytes >= KB) return `${(bytes / KB).toFixed(1)} KB`;
  return `${bytes} B`;
}

const plural = (n: number): string => (n === 1 ? '' : 's');

/**
 * One concise, factual markdown summary keyed by operation family:
 * size-reduction ops report before→after; converters report the produced file
 * count; the rest use an operation-specific verb. Every line ends by naming the
 * produced file's absolute path (TOOL-7).
 */
function summarize(
  op: OperationSpec,
  inputCount: number,
  metrics: ResultStructuredContent['metrics'],
  output: ResultStructuredContent['output']
): string {
  const at = `Saved to \`${output.path}\`.`;
  const before = formatBytes(metrics.inputBytes);
  const after = formatBytes(metrics.outputBytes);
  const pctSmaller = Math.round((1 - metrics.ratio) * 100);

  switch (op.name) {
    case 'compress-pdf':
      return `Compressed ${inputCount} PDF${plural(inputCount)}: ${before} → ${after} (${pctSmaller}% smaller). ${at}`;
    case 'pdf-to-jpg':
      return `Converted PDF to ${output.fileCount} JPG image${plural(output.fileCount)}. ${at}`;
    case 'image-to-pdf':
      return `Converted ${inputCount} image${plural(inputCount)} to PDF. ${at}`;
    case 'office-to-pdf':
      return `Converted ${inputCount} document${plural(inputCount)} to PDF. ${at}`;
    case 'merge-pdf':
      return `Merged ${inputCount} PDFs into one. ${at}`;
    case 'split-pdf':
      return `Split PDF into ${output.fileCount} file${plural(output.fileCount)}. ${at}`;
    case 'unlock':
      return `Unlocked ${inputCount} PDF${plural(inputCount)}. ${at}`;
    case 'watermark':
      return `Added a watermark to ${inputCount} PDF${plural(inputCount)}. ${at}`;
    case 'pagenumber':
      return `Added page numbers to ${inputCount} PDF${plural(inputCount)}. ${at}`;
    case 'pdf-ocr':
      return `Applied OCR to ${inputCount} PDF${plural(inputCount)}. ${at}`;
    default:
      return `${op.label} completed. ${at}`;
  }
}

// ---------------------------------------------------------------------------
// Public: buildResult
// ---------------------------------------------------------------------------

/**
 * Download the produced file, persist it inside the allowlist, and assemble the
 * LOCKED success result (structuredContent + one markdown block).
 *
 * @throws ToolError('UPSTREAM_ERROR', retryable:true)  non-OK download (R1)
 * @throws ToolError('FILE_ACCESS_DENIED' | 'INTERNAL') from file-io on write
 */
export async function buildResult(params: BuildResultInput): Promise<ToolCallResult> {
  const { op, exec, sources, allow, startedAt } = params;

  // 1. Download the produced file (raw tokenized URL — never returned/logged).
  const buffer = await downloadOutput(exec.download_url);
  const outputBytes = buffer.byteLength;

  // 2. Derive the filename. Multi-file operations return a single ZIP archive
  //    from iLovePDF (R5); ignore the upstream filename so the derivation picks
  //    the correct `.zip` extension for split / pdf-to-jpg.
  const isMultiFile = exec.file_count > 1;
  const upstreamFilename = isMultiFile ? '' : exec.output_filename;
  const derivedName = deriveOutputFilename(op, sources, upstreamFilename);

  // 3. Resolve (allowlist-validated) + write.
  const absPath = resolveOutputPath(params.output_path, derivedName, allow);
  const written = await writeOutputFile(absPath, buffer);

  // 4. Metrics. Prefer the caller's measured input bytes; fall back to the
  //    upstream KB figure for URL sources. Guard divide-by-zero on ratio.
  const inputBytes =
    params.inputBytes > 0
      ? params.inputBytes
      : exec.original_size_kb
        ? exec.original_size_kb * 1024
        : 0;
  const ratio = inputBytes > 0 ? outputBytes / inputBytes : 0;
  const metrics = {
    inputBytes,
    outputBytes,
    ratio,
    durationMs: Date.now() - startedAt,
  };

  // 5. Assemble. DEC-4: the returned download_url is host+path only.
  const output = {
    path: written.path,
    download_url: stripCredential(exec.download_url),
    bytes: written.bytes,
    fileCount: exec.file_count,
  };

  const structuredContent: ResultStructuredContent = {
    operation: op.name,
    status: 'completed',
    input: {
      sources,
      count: sources.length,
      totalBytes: inputBytes,
    },
    output,
    metrics,
  };

  return {
    content: [{ type: 'text', text: summarize(op, sources.length, metrics, output) }],
    structuredContent,
  };
}
