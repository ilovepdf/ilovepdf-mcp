/**
 * core/result-builder.ts (NEW — design §4, §8 row 15)
 *
 * Headless result builder. Replaces the widget `services/response-builder.ts`.
 * Given an `ExecuteResult` from the operation-executor, it:
 *   1. Downloads the produced file from `exec.download_url` (fetch → arrayBuffer).
 *   2. Derives the output filename (or honors an explicit `output_path`).
 *   3. Checks the resolved output path does NOT equal any input source path
 *      (data-safety: never overwrite an input by default). Throws VALIDATION_ERROR
 *      if a collision is detected — no bytes are written.
 *   4. Resolves + writes the destination through the allowlisted `lib/file-io`.
 *   5. Computes metrics (input/output bytes, ratio, wall-clock duration).
 *   6. Assembles the LOCKED `structuredContent` (TOOL-5) plus a content array:
 *      - Always: one concise per-op-family markdown text block (TOOL-7).
 *      - Always: one `resource_link` block pointing to the local output file.
 *      - When output size ≤ ILOVEPDF_MCP_MAX_INLINE_MB: one `resource` block
 *        embedding the output bytes as a base64 blob so the client can read the
 *        file without a separate filesystem access.
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
 * When `ILOVEPDF_MCP_RETURN_DOWNLOAD_URL=true`, the raw tokenized URL IS
 * returned in `structuredContent.output.download_url`. The audit-logger redacts
 * `?token=` in log lines regardless of this flag — only the client-facing
 * structuredContent carries the token when the flag is on.
 *
 * ## R1 — non-OK download → typed error
 * A network failure or non-2xx download response throws
 * `ToolError('UPSTREAM_ERROR', …, retryable:true)` — the caller can retry.
 *
 * NOTE: T061 wired `safeFetch` + the `.ilovepdf.com` host allow-list into
 * `downloadOutput`. See `assertAllowedDownloadHost` and the inline comments
 * for the SSRF-5/4/3/2/1 defence chain.
 */

import path from 'node:path';
import { pathToFileURL } from 'node:url';
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
import { getEmbedResult, getMaxInlineMb, getReturnDownloadUrl } from '../lib/env.js';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/** Text content block — always present as the first content item. */
type TextResultBlock = { type: 'text'; text: string };

/**
 * Embedded resource block — the output file bytes as a base64 blob.
 * Structurally compatible with the MCP SDK's `EmbeddedResource` (BlobResourceContents).
 * Only included when the output size is within the configured cap.
 */
type EmbeddedResourceBlock = {
  type: 'resource';
  resource: {
    /** file:// URI of the local output path. */
    uri: string;
    /** MIME type: application/pdf, application/zip, image/jpeg, etc. */
    mimeType: string;
    /** Base64-encoded output bytes. */
    blob: string;
  };
};

/**
 * Resource link block — file URI + metadata without bytes.
 * Structurally compatible with the MCP SDK's `ResourceLink`.
 * Always included so clients that do not render embedded blobs still get a
 * clickable / addressable reference to the local output file.
 */
type ResourceLinkBlock = {
  type: 'resource_link';
  /** file:// URI of the local output path. */
  uri: string;
  /** Output filename (basename only). */
  name: string;
  /** MIME type matching the embedded resource block. */
  mimeType: string;
};

/** Union of all content block types that buildResult may emit. */
export type ResultContentBlock = TextResultBlock | EmbeddedResourceBlock | ResourceLinkBlock;

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
  /**
   * Canonical absolute paths of local input source files. Used for the
   * overwrite-protection guard: if the resolved output path equals any of
   * these, `buildResult` throws VALIDATION_ERROR before writing anything.
   * URL sources have no local path and must be omitted from this list.
   */
  resolvedLocalPaths?: string[];
}

/** The LOCKED success `structuredContent` (validates against RESULT_OUTPUT_SHAPE). */
export interface ResultStructuredContent {
  operation: string;
  status: 'completed';
  input: { sources: string[]; count: number; totalBytes: number };
  output: { path: string; download_url: string; bytes: number; fileCount: number };
  metrics: { inputBytes: number; outputBytes: number; ratio: number; durationMs: number };
}

/** An MCP tool result: content blocks + `structuredContent`. */
export interface ToolCallResult {
  /**
   * Content blocks returned to the client:
   *   [0] Always: text/markdown operation summary (TOOL-7).
   *   [1]? Embedded resource blob — only when ILOVEPDF_MCP_EMBED_RESULT=true AND
   *        output ≤ ILOVEPDF_MCP_MAX_INLINE_MB (and cap > 0).
   *   [last]? resource_link — only when ILOVEPDF_MCP_EMBED_RESULT=true.
   *
   * By default (flag off) the content array is text-only — maximally client-compatible
   * (Claude Desktop rejects embedded non-text resources). Set ILOVEPDF_MCP_EMBED_RESULT=true
   * for clients that support embedded blobs, such as MCP Inspector.
   */
  content: ResultContentBlock[];
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
// Overwrite protection (data-safety)
// ---------------------------------------------------------------------------

/**
 * Case-fold on Windows (NTFS) and macOS (APFS/HFS+, case-insensitive by
 * default). Linux remains case-sensitive to match genuinely case-sensitive mounts.
 * Mirrors the same constant used in lib/file-io.ts for consistency.
 */
const isCaseInsensitivePlatform = process.platform === 'win32' || process.platform === 'darwin';

/**
 * True when two absolute paths refer to the same filesystem location,
 * accounting for case-insensitive filesystems (Windows / macOS).
 */
function pathsAreEquivalent(a: string, b: string): boolean {
  const n = (p: string): string => {
    const normalized = path.normalize(p);
    return isCaseInsensitivePlatform ? normalized.toLowerCase() : normalized;
  };
  return n(a) === n(b);
}

// ---------------------------------------------------------------------------
// Content helpers
// ---------------------------------------------------------------------------

/**
 * Derive the MIME type from the output file extension.
 * Covers the three output shapes this server produces:
 *   • .pdf  → application/pdf
 *   • .zip  → application/zip (multi-file archive from split-pdf / pdf-to-jpg)
 *   • .jpg  → image/jpeg (single-image output, edge case)
 */
function mimeTypeFor(filePath: string): string {
  switch (path.extname(filePath).toLowerCase()) {
    case '.pdf':
      return 'application/pdf';
    case '.zip':
      return 'application/zip';
    case '.jpg':
    case '.jpeg':
      return 'image/jpeg';
    case '.png':
      return 'image/png';
    default:
      return 'application/octet-stream';
  }
}

/** Convert an absolute local path to a `file://` URI (handles Windows drive letters). */
function toFileUri(absPath: string): string {
  return pathToFileURL(absPath).toString();
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
 * LOCKED success result (structuredContent + content blocks).
 *
 * Content array layout:
 *   [0]     Text block — op summary (TOOL-7). Always present and always first.
 *   [1]?    EmbeddedResource blob — only when ILOVEPDF_MCP_EMBED_RESULT=true AND
 *           outputBytes ≤ ILOVEPDF_MCP_MAX_INLINE_MB (and cap > 0).
 *   [last]? ResourceLink — only when ILOVEPDF_MCP_EMBED_RESULT=true (always present
 *           within that mode, even when the blob is omitted due to the cap).
 *
 * Default (ILOVEPDF_MCP_EMBED_RESULT unset / false): content is TEXT-ONLY.
 * This is the maximally client-compatible default — Claude Desktop rejects tool
 * results that contain embedded resources with non-text MIME types. Enable
 * ILOVEPDF_MCP_EMBED_RESULT=true only for clients that support them (e.g. MCP Inspector).
 *
 * @throws ToolError('UPSTREAM_ERROR', retryable:true)  non-OK download (R1)
 * @throws ToolError('VALIDATION_ERROR', retryable:false) output would overwrite an input
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

  // 3. Resolve (allowlist-validated) output path.
  const absPath = resolveOutputPath(params.output_path, derivedName, allow);

  // 4. DATA SAFETY — overwrite guard. Reject before any write if the resolved
  //    output path would clobber a local input source. Applies to both explicit
  //    output_path and default derivation.
  for (const srcPath of (params.resolvedLocalPaths ?? [])) {
    if (pathsAreEquivalent(absPath, srcPath)) {
      throw new ToolError(
        'VALIDATION_ERROR',
        `Resolved output path "${absPath}" equals input source "${srcPath}" — would overwrite the input.`,
        'output_path would overwrite an input file; choose a different destination',
        false
      );
    }
  }

  // 5. Write the bytes to disk.
  const written = await writeOutputFile(absPath, buffer);

  // 6. Metrics. Prefer the caller's measured input bytes; fall back to the
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

  // 7. Assemble structuredContent. DEC-4: by default the returned download_url
  //    is host+path only (token stripped). When ILOVEPDF_MCP_RETURN_DOWNLOAD_URL
  //    is true, the raw tokenized URL is returned so the client can download the
  //    file directly. The audit-logger always redacts ?token= in logs.
  const returnRawUrl = getReturnDownloadUrl();
  const download_url = returnRawUrl ? exec.download_url : stripCredential(exec.download_url);

  const output = {
    path: written.path,
    download_url,
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

  // 8. Build content array:
  //    [0]     Text/markdown summary (TOOL-7) — always first.
  //    [1]?    Embedded blob resource — only when ILOVEPDF_MCP_EMBED_RESULT=true
  //            AND output is within the size cap (cap > 0 and bytes ≤ cap).
  //    [last]? Resource link — only when ILOVEPDF_MCP_EMBED_RESULT=true. Within
  //            that mode it is always appended, even when the blob is omitted.
  //
  // Default (flag off): text-only content — maximally client-compatible. Claude
  // Desktop rejects tool results that include embedded non-text resources. Enable
  // ILOVEPDF_MCP_EMBED_RESULT=true only for clients that support them (e.g. MCP Inspector).
  //
  // When ILOVEPDF_MCP_RETURN_DOWNLOAD_URL is true, append the tokenized URL to
  // the text block so MCP clients that surface text (e.g. Claude Desktop) show a
  // clickable download link. The URL used here is the SAME tokenized URL already
  // placed in structuredContent.output.download_url (DEC-4: only when flag is on).
  const summaryText = summarize(op, sources.length, metrics, output);
  const textBlock: TextResultBlock = {
    type: 'text',
    text: returnRawUrl ? `${summaryText}\n\nDownload: ${download_url}` : summaryText,
  };

  const content: ResultContentBlock[] = [textBlock];

  // Only add the embedded resource and resource_link when ILOVEPDF_MCP_EMBED_RESULT is on.
  if (getEmbedResult()) {
    const fileUri = toFileUri(written.path);
    const mimeType = mimeTypeFor(written.path);

    // Cap in bytes (0 → blob disabled, but resource_link is still added).
    const maxInlineMb = getMaxInlineMb();
    const maxInlineBytes = maxInlineMb * 1024 * 1024;

    // Include the embedded blob only when within the cap (cap > 0 and size fits).
    if (maxInlineBytes > 0 && outputBytes <= maxInlineBytes) {
      const blob = Buffer.from(buffer).toString('base64');
      const embeddedBlock: EmbeddedResourceBlock = {
        type: 'resource',
        resource: { uri: fileUri, mimeType, blob },
      };
      content.push(embeddedBlock);
    }

    // Resource link is always added last within embed mode so clients that do not
    // render blobs still have an addressable reference to the local output file.
    const linkBlock: ResourceLinkBlock = {
      type: 'resource_link',
      uri: fileUri,
      name: path.basename(written.path),
      mimeType,
    };
    content.push(linkBlock);
  }

  return { content, structuredContent };
}
