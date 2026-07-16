/**
 * tools/handler.ts (design §3.3)
 *
 * The thin transport edge that composes the transport-agnostic core into a
 * single MCP tool callback. `makeHandler(op)` binds an operation from the
 * OPERATIONS registry and returns the async callback the SDK invokes with the
 * parsed tool input.
 *
 * Pipeline (per design §3.3):
 *   1. assertCardinality  — enforces per-operation source cardinality using
 *                           op.minSources / op.maxSources from the registry
 *                           (TOOL-4). A violation is a VALIDATION_ERROR.
 *   2. loadAllowlist      — resolve the deny-by-default file-io allowlist (§5).
 *   3. requireEnv (LAZY)  — resolve ILOVEPDF_PUBLIC_KEY inside the handler, not at
 *                           module load, so a missing key surfaces as a typed
 *                           error at call time instead of crashing tools/list.
 *   4. resolveSources     — classify each source: http(s) URL → cloud upload
 *                           input; local path → allowlisted read → bytes input.
 *   5. validateInputs     — extension (all) + size (local files) via
 *                           lib/file-validation (TOOL-4).
 *   6. pre-validate output_path — when supplied, resolve it against the allowlist
 *                           BEFORE any network work so an out-of-root destination
 *                           fails fast (FILE_ACCESS_DENIED) with no upload/write
 *                           (TOOL-8). The builder re-validates on write.
 *   7. merge defaults + normalizeOptions (DEC-2) — merge op.defaultOptions with
 *                           the caller options, THEN normalize (after merge,
 *                           before execute); warnings are surfaced in the result.
 *   8. upload             — shared-task vs. per-file (core/upload-service).
 *   9. execute            — auth→process→download orchestration (core/operation-executor).
 *  10. buildResult        — download→write→metrics→LOCKED result (core/result-builder).
 *
 * On ANY error the pipeline does NOT throw out of the handler (throwing is
 * reserved for protocol-level faults). `toErrorResult` returns an
 * `isError:true` tool result with the FLAT typed error surface.
 *
 * ## DEC-5 (CRITICAL) — credential/path hygiene on the failure surface
 * The client-facing failure `structuredContent` carries ONLY `success:false`,
 * `error_code`, `retryable` and `error` (= `ToolError.userMessage`, audited-safe).
 * The raw `detail` (= `ToolError.message`, which may embed absolute workdir
 * paths) is NEVER returned to the client. The FULL `toStructured()` (incl.
 * `detail`) is emitted to STDERR via the audit-logger only.
 */

import { ToolError, isToolError } from '../domain/errors.js';
import type { ErrorCode } from '../domain/errors.js';
import type { OperationSpec } from '../domain/operation-types.js';
import { requireEnv } from '../lib/env.js';
import { validateOptions } from '../contract/options-schema.js';
import {
  isUrl,
  loadAllowlist,
  readInputFile,
  resolveOutputPath,
  type Allowlist,
} from '../lib/file-io.js';
import { assertUrlPrecheck } from '../lib/url-guard.js';
import { validateExtension, validateSize } from '../lib/file-validation.js';
import { normalizeOptions } from './../core/option-normalizer.js';
import {
  uploadFiles,
  uploadIntoSharedTask,
  type UploadFileInput,
} from '../core/upload-service.js';
import { execute } from '../core/operation-executor.js';
import { buildResult, type ToolCallResult } from '../core/result-builder.js';
import { log } from '../core/audit-logger.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/**
 * Maximum accepted input file size in megabytes. Bounded default guard so a
 * single oversized local file is rejected before any upload work (TOOL-4). URL
 * sources are not size-checked here (bytes are unknown until iLovePDF fetches).
 */
const MAX_INPUT_FILE_MB = 100;

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/** Parsed tool input (shape defined in tools/input-shape.ts, §3.2). */
export interface HandlerArgs {
  sources: string[];
  output_path?: string;
  options?: Record<string, unknown>;
}

/** Flat failure `structuredContent` (ERR-8 / DEC-5 — no `detail`). */
interface FailureStructuredContent {
  operation: string;
  status: 'failed';
  input: { sources: string[]; count: number; totalBytes: number };
  success: false;
  error_code: ErrorCode;
  retryable: boolean;
  error: string;
}

/** MCP tool result returned by the handler (success or failure). */
export type HandlerResult =
  | (ToolCallResult & { isError?: false })
  | {
      isError: true;
      content: Array<{ type: 'text'; text: string }>;
      structuredContent: FailureStructuredContent;
    };

// ---------------------------------------------------------------------------
// Internal: a resolved source pairs an upload input with validation metadata.
// ---------------------------------------------------------------------------

interface ResolvedInput {
  /** The normalized input handed to the upload service. */
  upload: UploadFileInput;
  /** Filename used for extension validation + filename derivation. */
  filename: string;
  /** Byte size for size validation + inputBytes; 0 for URL sources. */
  size: number;
}

// ---------------------------------------------------------------------------
// Cardinality (TOOL-4)
// ---------------------------------------------------------------------------

/**
 * Enforce per-operation source cardinality using the registry's `minSources` and
 * `maxSources` fields (TOOL-4). A count outside the valid range is a
 * `VALIDATION_ERROR`; violations are rejected before any upload work.
 *
 * Convention (mirrors operation-types.ts documentation):
 *   min = op.minSources ?? 1
 *   max = op.maxSources ?? (op.minSources !== undefined ? Infinity : 1)
 *
 * - Both fields omitted (single-file ops): min=1, max=1 — exactly 1 source.
 * - minSources=1, maxSources omitted (image-to-pdf): min=1, max=Infinity.
 * - minSources=2, maxSources omitted (merge-pdf): min=2, max=Infinity.
 *
 * Note: `requiresSharedTask` is an UPLOAD-STRATEGY flag (used at §3.3 step 8 to
 * choose `uploadIntoSharedTask` vs `uploadFiles`). It is NOT used here for
 * cardinality — the two concerns are decoupled.
 */
function assertCardinality(op: OperationSpec, sources: string[]): void {
  const n = sources.length;
  const min = op.minSources ?? 1;
  const max = op.maxSources ?? (op.minSources !== undefined ? Infinity : 1);

  if (n < min) {
    throw new ToolError(
      'VALIDATION_ERROR',
      `${op.name} requires at least ${min} source${min === 1 ? '' : 's'}; received ${n}.`,
      `This operation needs at least ${min} input file${min === 1 ? '' : 's'}.`,
      false
    );
  }
  if (n > max) {
    throw new ToolError(
      'VALIDATION_ERROR',
      `${op.name} accepts at most ${max} source${max === 1 ? '' : 's'}; received ${n}.`,
      `This operation accepts at most ${max} input file${max === 1 ? '' : 's'}.`,
      false
    );
  }
}

// ---------------------------------------------------------------------------
// Source resolution (§3.3, FIO-6)
// ---------------------------------------------------------------------------

/** Derive a filename from a URL for extension validation + naming. */
function urlFilename(url: string, op: OperationSpec): string {
  try {
    const last = new URL(url).pathname.split('/').filter(Boolean).pop();
    if (last && last.includes('.')) return decodeURIComponent(last);
  } catch {
    // Fall through to the extension-based default.
  }
  return `file${op.acceptedExtensions[0] ?? '.pdf'}`;
}

/**
 * Classify each source. `http(s)` URLs bypass the path allowlist and become
 * cloud-upload inputs (FIO-6). Before delegation, the SSRF pre-check
 * (`assertUrlPrecheck`) validates scheme + IP-literal host (SSRF-6). Everything
 * else is read through the allowlisted `readInputFile` and becomes a bytes input.
 */
async function resolveSources(
  sources: string[],
  op: OperationSpec,
  allow: Allowlist
): Promise<ResolvedInput[]> {
  return Promise.all(
    sources.map(async src => {
      // SSRF-6: if the source string has a URL scheme (contains `://`), apply
      // the pre-check BEFORE determining whether to delegate or read locally.
      // This catches non-http(s) schemes (ftp://, file://) as well as blocked
      // IP-literal http(s) inputs. Full DNS resolution is iLovePDF's
      // responsibility for delegated uploads; this early check gives clear typed
      // errors and provides defence in depth.
      if (/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//i.test(src)) {
        assertUrlPrecheck(src); // throws VALIDATION_ERROR for bad scheme/IP
      }

      if (isUrl(src)) {
        const filename = urlFilename(src, op);
        return {
          upload: { kind: 'url', url: src, filename } as UploadFileInput,
          filename,
          size: 0,
        };
      }
      const local = await readInputFile(src, allow);
      return {
        upload: {
          kind: 'bytes',
          bytes: local.bytes,
          filename: local.filename,
        } as UploadFileInput,
        filename: local.filename,
        size: local.size,
      };
    })
  );
}

/** Validate extension (all inputs) and size (local files only). */
function validateInputs(inputs: ResolvedInput[], op: OperationSpec): void {
  for (const input of inputs) {
    validateExtension(input.filename, op.acceptedExtensions);
    if (input.size > 0) validateSize(input.size, MAX_INPUT_FILE_MB);
  }
}

// ---------------------------------------------------------------------------
// Failure surface (§7, ERR-8, DEC-5)
// ---------------------------------------------------------------------------

/**
 * Map any thrown value to the client-facing failure result. Non-`ToolError`
 * throwables are wrapped as `INTERNAL`. The FULL structured payload (incl. the
 * raw `detail`, which may embed absolute paths) is emitted to stderr via the
 * audit-logger ONLY; the returned `structuredContent` omits `detail` entirely
 * (DEC-5).
 */
function toErrorResult(
  op: OperationSpec,
  sources: string[],
  err: unknown
): HandlerResult {
  const toolErr = isToolError(err)
    ? err
    : new ToolError(
        'INTERNAL',
        err instanceof Error ? err.message : String(err),
        'An unexpected error occurred. Please try again.',
        false
      );

  // DEC-5: audit the FULL toStructured() (incl. detail) to stderr only.
  log.error(`[handler] ${op.name} failed`, toolErr.toStructured());

  return {
    isError: true,
    content: [{ type: 'text', text: toolErr.userMessage }],
    structuredContent: {
      operation: op.name,
      status: 'failed',
      input: { sources, count: sources.length, totalBytes: 0 },
      success: false,
      error_code: toolErr.code,
      retryable: toolErr.retryable,
      error: toolErr.userMessage,
      // DEC-5: `detail` is intentionally ABSENT from the client-facing surface.
    },
  };
}

// ---------------------------------------------------------------------------
// Public: makeHandler
// ---------------------------------------------------------------------------

/**
 * Bind an operation and return the SDK tool callback. See the file header for
 * the full pipeline. Errors are returned (isError:true), never thrown.
 */
export function makeHandler(op: OperationSpec) {
  return async function handler(args: HandlerArgs): Promise<HandlerResult> {
    const startedAt = Date.now();
    const sources = args.sources ?? [];

    try {
      assertCardinality(op, sources);

      const allow = loadAllowlist();
      // Lazy env resolution (design §6): missing key → typed error at call time.
      const env = { ILOVEPDF_PUBLIC_KEY: requireEnv('ILOVEPDF_PUBLIC_KEY') };

      const inputs = await resolveSources(sources, op, allow);
      validateInputs(inputs, op);

      // Fail-fast: validate an explicit output destination against the
      // allowlist BEFORE any upload/process work (TOOL-8). The builder resolves
      // it again on write; this pre-check avoids a wasted round-trip.
      if (args.output_path && args.output_path.trim().length > 0) {
        resolveOutputPath(args.output_path, 'output', allow);
      }

      // DEC-6: validate options against the strict per-op schema BEFORE merging
      // defaults or normalizing. The SDK-level options schema is loosened (see
      // input-shape.ts) so bad values reach here; validateOptions throws a typed
      // ToolError('VALIDATION_ERROR') which surfaces via the structured error path
      // (ERR-8/DEC-5). No-op when options is undefined or the op has no schema.
      validateOptions(op.name, args.options);

      // DEC-2: merge defaults, THEN normalize (after merge, before execute).
      const merged = { ...op.defaultOptions, ...(args.options ?? {}) };
      const { options: normalized, warnings } = normalizeOptions(op.name, merged);

      const uploads = inputs.map(input => input.upload);
      const creds = op.requiresSharedTask
        ? await uploadIntoSharedTask(op, uploads, env)
        : await uploadFiles(op, uploads, env);

      const exec = await execute(op, creds, normalized);

      const inputBytes = inputs.reduce((sum, input) => sum + input.size, 0);
      const result = await buildResult({
        op,
        exec,
        sources,
        inputBytes,
        output_path: args.output_path,
        allow,
        startedAt,
      });

      // DEC-2: surface normalization warnings inside the SINGLE content block
      // (TOOL-7 mandates exactly one content item).
      if (warnings.length > 0 && result.content[0]) {
        const note = `\n\nNotes:\n${warnings.map(w => `- ${w}`).join('\n')}`;
        result.content[0].text += note;
      }

      return result;
    } catch (err) {
      return toErrorResult(op, sources, err);
    }
  };
}
