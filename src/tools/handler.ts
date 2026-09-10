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
import { validateOptions, applyPdfjpgQuality } from '../contract/options-schema.js';
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
  /**
   * Canonical absolute path for local (non-URL) sources — used for the
   * overwrite-protection guard passed to buildResult. Absent for URL sources.
   */
  absPath?: string;
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
        absPath: local.absPath,
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

      // pdf-to-jpg: normalize quality/pdfjpg_mode, then map quality → dpi.
      // Runs in handler (not normalizer) because pdf-to-jpg is in NO_OP_TOOLS.
      if (op.name === 'pdf-to-jpg') {
        if (normalized.quality !== undefined) {
          const q = String(normalized.quality).trim().toLowerCase();
          if (q === 'normal') {
            normalized.quality = 'Normal';
          } else if (['high', 'alta', 'alto'].includes(q)) {
            normalized.quality = 'High';
          } else if (normalized.quality !== 'Normal' && normalized.quality !== 'High') {
            warnings.push(`pdf-to-jpg quality '${normalized.quality}' is not valid. Ignoring.`);
            delete normalized.quality;
          }
        }
        if (normalized.pdfjpg_mode !== undefined) {
          const m = String(normalized.pdfjpg_mode).trim().toLowerCase();
          if (['page', 'pagina', 'paginas'].includes(m)) {
            normalized.pdfjpg_mode = 'pages';
          } else if (m === 'pages') {
            normalized.pdfjpg_mode = 'pages';
          } else if (['extract', 'extraer', 'extracted', 'extrae'].includes(m)) {
            normalized.pdfjpg_mode = 'extract';
          } else if (normalized.pdfjpg_mode !== 'pages' && normalized.pdfjpg_mode !== 'extract') {
            warnings.push(`pdf-to-jpg pdfjpg_mode '${normalized.pdfjpg_mode}' is not valid. Using 'pages'.`);
            normalized.pdfjpg_mode = 'pages';
          }
        }
        applyPdfjpgQuality(normalized);
      }

      // compress-pdf: normalize compression_level synonyms.
      // Runs in handler (not normalizer) because compress-pdf is in NO_OP_TOOLS.
      if (op.name === 'compress-pdf' && normalized.compression_level !== undefined) {
        const cl = String(normalized.compression_level).trim().toLowerCase();
        if (['recommended', 'recomendado', 'normal', 'default'].includes(cl)) {
          normalized.compression_level = 'recommended';
        } else if (['extreme', 'extremo', 'high', 'alta', 'alto', 'maximum', 'max', 'highest', 'maximum'].includes(cl)) {
          normalized.compression_level = 'extreme';
        } else if (['low', 'bajo', 'baja', 'light', 'minimal', 'minimum', 'min', 'none', 'ninguno', 'ninguna'].includes(cl)) {
          normalized.compression_level = 'low';
        } else if (!['recommended', 'extreme', 'low'].includes(String(normalized.compression_level))) {
          warnings.push(`compress-pdf compression_level '${normalized.compression_level}' is not valid. Using 'recommended'.`);
          normalized.compression_level = 'recommended';
        }
      }

      // pdf-ocr: normalize language names → ISO codes, filter invalid entries.
      // Runs in handler (not normalizer) because pdf-ocr is in NO_OP_TOOLS.
      if (op.name === 'pdf-ocr' && normalized.ocr_languages !== undefined) {
        const raw = normalized.ocr_languages as unknown[];
        const LANG_MAP: Record<string, string> = {
          english: 'eng', inglés: 'eng', ingles: 'eng',
          spanish: 'spa', español: 'spa', espanol: 'spa',
          french: 'fra', francés: 'fra', frances: 'fra',
          german: 'deu', deutsch: 'deu', alemán: 'deu', aleman: 'deu',
          portuguese: 'por', portugués: 'por', portugues: 'por',
          italian: 'ita', italiano: 'ita',
          japanese: 'jpn', japonés: 'jpn', japones: 'jpn',
          korean: 'kor', coreano: 'kor',
          arabic: 'ara', árabe: 'ara', arabe: 'ara',
          russian: 'rus', ruso: 'rus',
          'chinese simplified': 'chi_sim', 'chino simplificado': 'chi_sim',
          'chinese traditional': 'chi_tra', 'chino tradicional': 'chi_tra',
        };
        const VALID_OCR_CODES = new Set([
          'eng', 'afr', 'amh', 'ara', 'asm', 'aze', 'bel', 'ben', 'bod', 'bos', 'bul', 'cat', 'ces',
          'chi_sim', 'chi_tra', 'dan', 'deu', 'ell', 'epo', 'est', 'eus', 'fas', 'fil', 'fin', 'fra',
          'gla', 'gle', 'glg', 'guj', 'heb', 'hin', 'hrv', 'hun', 'hye', 'ind', 'isl', 'ita', 'jpn',
          'kan', 'kat', 'kaz', 'khm', 'kor', 'lao', 'lat', 'lav', 'lit', 'mal', 'mar', 'mkd', 'mlt',
          'mon', 'msa', 'mya', 'nep', 'nld', 'nor', 'pan', 'pol', 'por', 'ron', 'rus', 'sin', 'slk',
          'slv', 'spa', 'sqi', 'srp', 'swa', 'swe', 'tam', 'tel', 'tgl', 'tha', 'tur', 'ukr', 'urd',
          'vie', 'yid',
        ]);
        const langs: string[] = [];
        for (const lang of raw) {
          const s = String(lang).trim().toLowerCase();
          if (VALID_OCR_CODES.has(s)) {
            langs.push(s);
          } else if (LANG_MAP[s]) {
            warnings.push(`pdf-ocr: '${lang}' was interpreted as language code '${LANG_MAP[s]}'.`);
            langs.push(LANG_MAP[s]);
          } else {
            warnings.push(`pdf-ocr: '${lang}' is not a valid OCR language code and was removed.`);
          }
        }
        if (langs.length === 0) {
          warnings.push(`pdf-ocr: no valid language codes remain; defaulting to ['eng'].`);
          normalized.ocr_languages = ['eng'];
        } else {
          normalized.ocr_languages = langs;
        }
      }

      // unlock: password is required. Without it, iLovePDF returns a cryptic error.
      // Surface a clear message so the LLM can ask the user for the password.
      // TEMPORARILY DISABLED — unlock tool commented out; re-enable alongside
      // the 'unlock' OperationName / OPERATIONS entry to re-publish.
      // if (op.name === 'unlock' && !normalized.password) {
      //   throw new ToolError(
      //     'VALIDATION_ERROR',
      //     'unlock requires a password but none was provided.',
      //     'Please provide the PDF password via the "password" option.',
      //     false
      //   );
      // }

      // watermark image mode: validate image_source is present, resolve it
      // separately (bypassing the .pdf extension check), and upload it alongside
      // the PDF into a shared task. iLovePDF identifies the watermark image via
      // the `image` field in the process body (its server_filename).
      if (op.name === 'watermark' && normalized.mode === 'image' && !normalized.image_source) {
        throw new ToolError(
          'VALIDATION_ERROR',
          'Invalid options for "watermark": "image_source" is required when mode is "image".',
          'Please provide the watermark image path or URL via the "image_source" option.',
          false
        );
      }

      const uploads = inputs.map(input => input.upload);

      if (op.name === 'watermark' && normalized.mode === 'image' && normalized.image_source) {
        const imgSrc = normalized.image_source as string;
        const imageExts = ['.png', '.jpg', '.jpeg'];
        const imgOp = { ...op, acceptedExtensions: imageExts };
        const imgResolved = await resolveSources([imgSrc], imgOp, allow);
        validateExtension(imgResolved[0].filename, imageExts);
        if (imgResolved[0].size > 0) validateSize(imgResolved[0].size, MAX_INPUT_FILE_MB);
        uploads.push(imgResolved[0].upload);
        delete normalized.image_source;
      }

      const useSharedTask =
        op.requiresSharedTask || (op.name === 'watermark' && normalized.mode === 'image');
      const creds = useSharedTask
        ? await uploadIntoSharedTask(op, uploads, env)
        : await uploadFiles(op, uploads, env);

      // unlock: password must live inside each file entry, not as a top-level
      // process param. The iLovePDF API reads it from ILovePDFFile.password.
      // TEMPORARILY DISABLED — unlock tool commented out; re-enable alongside
      // the 'unlock' OperationName / OPERATIONS entry to re-publish.
      // if (op.name === 'unlock' && normalized.password) {
      //   const pw = normalized.password as string;
      //   creds.files = creds.files.map(f => ({ ...f, password: pw }));
      //   delete normalized.password;
      // }

      // watermark image mode: inject the uploaded image's server_filename into
      // the process options so iLovePDF knows which file is the watermark image.
      if (op.name === 'watermark' && normalized.mode === 'image') {
        const imageFile = creds.files[creds.files.length - 1];
        if (imageFile) normalized.image = imageFile.server_filename;
      }

      const exec = await execute(op, creds, normalized);

      const inputBytes = inputs.reduce((sum, input) => sum + input.size, 0);

      // Collect canonical absolute paths of local input sources for the
      // overwrite-protection guard inside buildResult. URL sources have no
      // local path and are excluded from this list.
      const resolvedLocalPaths = inputs
        .map(i => i.absPath)
        .filter((p): p is string => p !== undefined);

      const result = await buildResult({
        op,
        exec,
        sources,
        inputBytes,
        output_path: args.output_path,
        allow,
        startedAt,
        resolvedLocalPaths,
      });

      // DEC-2: surface normalization warnings inside the first content block
      // (the text summary block, always at index 0). Type-narrow before mutating
      // since content blocks are a discriminated union.
      if (warnings.length > 0) {
        const firstBlock = result.content[0];
        if (firstBlock && firstBlock.type === 'text') {
          const note = `\n\nNotes:\n${warnings.map(w => `- ${w}`).join('\n')}`;
          firstBlock.text += note;
        }
      }

      return result;
    } catch (err) {
      return toErrorResult(op, sources, err);
    }
  };
}
