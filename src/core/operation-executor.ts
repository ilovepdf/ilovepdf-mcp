/**
 * core/operation-executor.ts
 *
 * Headless operation executor (AD-2, AD-3, ERR-3, ERR-6, ERR-7).
 *
 * Ported ~verbatim from ../openai-app/mcp-server/src/services/operation-executor.ts.
 * The orchestration logic (auth → upload → process → download) is unchanged; the
 * only headless adaptations are:
 *   - relative imports moved into `src/core/*` and updated to the NodeNext `.js`
 *     convention (including inline dynamic `import('../types.js')` type refs).
 *   - `console.log` routed through the stderr `log` facade (LOG-3) so no log line
 *     can contaminate stdout on the stdio transport.
 *
 * ## Strategies (design §4.1)
 *
 *   DIRECT (default, AD-2):
 *     task.task_tool === op.apiTool OR op.mustBeDirect
 *     → call processILovePDFTask with the correct tool, once.
 *     → 401/403: re-auth once (P8).
 *     → on success: add task to processedTasks set.
 *
 *   RE-UPLOAD FALLBACK (AD-2):
 *     tool mismatch AND (pdfocr, watermark, or mustBeDirect)
 *     → download the source file, upload to a fresh correct-tool task, process.
 *     → Never use connected-task for pdf-ocr (server returns 500) or
 *       watermark (server returns ProcessingError).
 *
 *   CONNECTED-TASK FALLBACK (constrained):
 *     chain-safe tools only (not pdfocr, not mustBeDirect), tool mismatch,
 *     parent task already processed.
 *     → createConnectedTask → process connected task.
 *
 * ## Idempotency guard (AD-3, ERR-7)
 *   A request-scoped `Set<string>` tracks processed task IDs.
 *   If a task is already in the set → throw ToolError('TASK_ALREADY_PROCESSED').
 *   Callers that manage their own set can pass it in; otherwise a fresh set is used.
 *
 * ## Error handling
 *   A genuine 500 from iLovePDF → throw ToolError('UPSTREAM_ERROR') (ERR-3).
 *   The error-string heuristic (matching "already processed" in the message) is
 *   intentionally ABSENT — iLovePDF returns generic 500 for both replay and real
 *   errors, so string matching is unreliable (AD-3).
 */

import {
  authenticateILovePDF,
  processILovePDFTask,
  createConnectedTask,
  uploadCloudFile,
} from './ilovepdf-api.js';
import { safeFetch } from '../lib/url-guard.js';
import { requireEnv } from '../lib/env.js';
import { ToolError } from '../domain/errors.js';
import type { OperationSpec } from '../domain/operation-types.js';
import type { ILovePDFFile, ILovePDFProcessOptions } from '../types.js';
import type { TaskCreds } from './upload-service.js';
import { isAuthError, isTransientError } from './auth-utils.js';
import { log } from './audit-logger.js';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/**
 * Result returned by `execute` on success.
 * Shape mirrors the transformed result produced by server.ts /api/process.
 */
export interface ExecuteResult {
  download_url: string;
  output_filename: string;
  /** Elapsed time reported by iLovePDF (raw timer string, e.g. "0.532") */
  processing_time: string;
  /** Original file size in KB (from iLovePDF filesize field) */
  original_size_kb?: number;
  /** Output file size in KB (from iLovePDF output_filesize or HEAD fallback) */
  output_size_kb?: number;
  /** Number of output files (1 for most tools, >1 for split / pdf-to-jpg) */
  file_count: number;
  /** Raw output extensions from iLovePDF (e.g. ["jpg"]) */
  output_extensions?: string[];
  /** Raw status string from iLovePDF */
  status?: string;
  /** Human-readable status message from iLovePDF */
  status_message?: string;
}

/**
 * Options forwarded from the caller's process request body.
 * Anything that is not a core task field is a process option.
 */
export type ProcessOptions = Record<string, unknown>;

/**
 * Configuration for `execute`.
 *
 * `processedTasks`: optional request-scoped set for idempotency tracking.
 * Pass a shared set when multiple tasks are being orchestrated in one request
 * (e.g. multi-file merge). When absent a fresh Set is created per call.
 */
export interface ExecuteConfig {
  processedTasks?: Set<string>;
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/** Re-authenticate once, replacing the token stored in `state`. */
async function refreshToken(state: { token: string }): Promise<void> {
  const publicKey = requireEnv('ILOVEPDF_PUBLIC_KEY');
  try {
    state.token = await authenticateILovePDF(publicKey);
  } catch (authErr) {
    throw new ToolError(
      'AUTH_FAILED',
      `Re-authentication failed: ${authErr instanceof Error ? authErr.message : String(authErr)}`,
      'Authentication failed. Please try again.',
      true
    );
  }
}

/**
 * Call processILovePDFTask with automatic retries:
 *   - On 401/403 (auth error): re-authenticate once and retry.
 *   - On 502/503/504 (transient error): wait 500ms and retry once.
 * Mutates `tokenState.token` if a refresh occurred.
 */
async function processWithAuthRetry(
  server: string,
  task: string,
  tokenState: { token: string },
  tool: string,
  opts: ILovePDFProcessOptions
): Promise<import('../types.js').ILovePDFProcessResponse> {
  try {
    return await processILovePDFTask(
      server,
      task,
      tokenState.token,
      tool,
      opts
    );
  } catch (err) {
    // Auth error → re-authenticate and retry
    if (isAuthError(err)) {
      await refreshToken(tokenState);
      return await processILovePDFTask(
        server,
        task,
        tokenState.token,
        tool,
        opts
      );
    }
    // Transient 5xx → wait and retry once (same token, server may recover)
    if (isTransientError(err)) {
      log.warn(
        `[operation-executor] Transient error during process (${err instanceof Error ? err.message : String(err)}); retrying in 500ms`
      );
      await new Promise(resolve => setTimeout(resolve, 500));
      return await processILovePDFTask(
        server,
        task,
        tokenState.token,
        tool,
        opts
      );
    }
    throw err;
  }
}

/**
 * Build the ILovePDFProcessOptions from the files array and caller-supplied options.
 * Strips reserved keys that must not be forwarded to iLovePDF.
 *
 * Passes through all user options (orientation, margin, pagesize, merge_after, etc.)
 * to the iLovePDF API without filtering.
 */
function buildProcessOptions(
  files: ILovePDFFile[],
  callerOptions: ProcessOptions
): ILovePDFProcessOptions {
  const cleaned: Record<string, unknown> = { ...callerOptions };
  // password is a file-level attribute per the iLovePDF API; move it onto each file
  const filePassword = typeof cleaned.password === 'string' ? cleaned.password : undefined;
  delete cleaned.password;
  // Remove fields that are internal to our API surface
  for (const key of [
    'tool',
    'server',
    'task',
    'token',
    'task_tool',
    'files',
    'upload_source',
  ]) {
    delete cleaned[key];
  }
  const resolvedFiles = filePassword
    ? files.map(f => ({ ...f, password: filePassword }))
    : files;
  return { files: resolvedFiles, ...(cleaned as Omit<ILovePDFProcessOptions, 'files'>) };
}

/**
 * Construct a download URL from task creds.
 */
function buildDownloadUrl(server: string, task: string, token: string): string {
  return `https://${server}/v1/download/${task}?token=${token}`;
}

/**
 * Build an ExecuteResult from the raw iLovePDF process response + download URL.
 * Mirrors the transform logic in server.ts /api/process.
 */
async function buildResult(
  rawResult: import('../types.js').ILovePDFProcessResponse,
  downloadUrl: string,
  filesArray: ILovePDFFile[]
): Promise<ExecuteResult> {
  const result: ExecuteResult = {
    download_url: downloadUrl,
    output_filename: rawResult.download_filename || 'output.pdf',
    processing_time: rawResult.timer,
    file_count: 1,
  };

  // File count
  if (filesArray.length > 1) {
    result.file_count = filesArray.length;
  } else if (typeof rawResult.output_filenumber === 'number') {
    result.file_count = rawResult.output_filenumber;
  }

  // Original size
  if (typeof rawResult.filesize === 'number' && rawResult.filesize > 0) {
    result.original_size_kb = Math.round(rawResult.filesize / 1024);
  }

  // Output size — prefer the API value; fall back to a HEAD request
  if (
    typeof rawResult.output_filesize === 'number' &&
    rawResult.output_filesize > 0
  ) {
    result.output_size_kb = Math.round(rawResult.output_filesize / 1024);
  } else {
    try {
      // Route the HEAD probe through safeFetch (egress guard + iLovePDF host
      // allow-list) so raw fetch is never used for outbound requests (LOW fix).
      // Failures are non-critical — size info is best-effort only.
      const headRes = await safeFetch(downloadUrl, { method: 'HEAD' }, {
        allowHost: host => host.toLowerCase().endsWith('.ilovepdf.com'),
      });
      const cl = headRes.headers.get('Content-Length');
      if (cl) {
        result.output_size_kb = Math.round(parseInt(cl, 10) / 1024);
      }
    } catch {
      // Non-critical — size info is optional; guard errors are silently ignored.
    }
  }

  if (rawResult.output_extensions) {
    result.output_extensions = rawResult.output_extensions;
  }
  if (rawResult.status) {
    result.status = rawResult.status;
  }
  if (rawResult.status_message) {
    result.status_message = rawResult.status_message;
  }

  return result;
}

// ---------------------------------------------------------------------------
// Public: execute
// ---------------------------------------------------------------------------

/**
 * Execute a PDF operation against an already-uploaded iLovePDF task.
 *
 * Implements:
 *   - Idempotency guard (AD-3, ERR-7): processedTasks set prevents double-processing
 *   - DIRECT path (AD-2 default): task.task_tool === op.apiTool → process once
 *   - Re-upload fallback: tool mismatch + pdfocr or mustBeDirect → re-upload
 *   - Connected-task fallback: chain-safe tools with processed parent
 *
 * @param op          The operation spec from the OPERATIONS registry
 * @param task        Task credentials from upload-service (server, task, token, task_tool, files)
 * @param options     Process options forwarded from the caller's process body
 * @param config      Optional: pass a shared processedTasks Set for multi-task orchestration
 *
 * @returns           ExecuteResult with download_url and metadata
 *
 * @throws ToolError('TASK_ALREADY_PROCESSED')  Idempotency guard
 * @throws ToolError('AUTH_FAILED')             Auth retry exhausted
 * @throws ToolError('UPSTREAM_ERROR')          iLovePDF returned an unexpected error
 */
export async function execute(
  op: OperationSpec,
  task: TaskCreds,
  options: ProcessOptions,
  config: ExecuteConfig = {}
): Promise<ExecuteResult> {
  const processedTasks = config.processedTasks ?? new Set<string>();

  // AD-3 / ERR-7: idempotency guard
  if (processedTasks.has(task.task)) {
    throw new ToolError(
      'TASK_ALREADY_PROCESSED',
      `Task ${task.task} was already processed in this request.`,
      'This task was already processed. Start a new upload to process the file again.',
      false
    );
  }

  const tokenState = { token: task.token };
  const isDirectMatch = task.task_tool === op.apiTool;
  const isForced = op.mustBeDirect;

  // ------------------------------------------------------------------
  // DIRECT path (default, AD-2)
  // ------------------------------------------------------------------
  if (isDirectMatch || isForced) {
    const processOpts = buildProcessOptions(task.files, options);

    let rawResult: import('../types.js').ILovePDFProcessResponse;
    try {
      rawResult = await processWithAuthRetry(
        task.server,
        task.task,
        tokenState,
        op.apiTool,
        processOpts
      );
    } catch (err) {
      if (err instanceof ToolError) throw err;
      throw new ToolError(
        'UPSTREAM_ERROR',
        `Direct process failed for task ${task.task}: ${err instanceof Error ? err.message : String(err)}`,
        'Processing failed. Please try again.',
        false
      );
    }

    processedTasks.add(task.task);

    const downloadUrl = buildDownloadUrl(
      task.server,
      task.task,
      tokenState.token
    );
    return buildResult(rawResult, downloadUrl, task.files);
  }

  // ------------------------------------------------------------------
  // RE-UPLOAD FALLBACK
  // Tool mismatch AND (pdfocr cannot be chained, or op requires direct)
  // Download the already-processed/compressed source and re-upload into
  // a fresh correct-tool task.
  // ------------------------------------------------------------------
  if (op.apiTool === 'pdfocr' || !canChain(op)) {
    return reUploadFallback(op, task, tokenState, options, processedTasks);
  }

  // ------------------------------------------------------------------
  // CONNECTED-TASK FALLBACK
  // Chain-safe tool + tool mismatch. Requires the parent task to be
  // processed first (so the output is available for chaining).
  // ------------------------------------------------------------------
  return connectedTaskFallback(op, task, tokenState, options, processedTasks);
}

// ---------------------------------------------------------------------------
// Strategy: re-upload fallback
// ---------------------------------------------------------------------------

/**
 * Re-upload fallback strategy.
 *
 * 1. Process the source task with its current tool (or skip if already processed).
 * 2. Download the output from the source task.
 * 3. Start a fresh task with op.apiTool.
 * 4. Upload the downloaded file into the fresh task.
 * 5. Process the fresh task.
 *
 * Used for pdf-ocr (connected-task returns 500) and mustBeDirect tools where
 * the upload task tool differs (edge case — normally mustBeDirect tasks are
 * uploaded with the correct tool via DIRECT path in the upload service).
 */
async function reUploadFallback(
  op: OperationSpec,
  task: TaskCreds,
  tokenState: { token: string },
  options: ProcessOptions,
  processedTasks: Set<string>
): Promise<ExecuteResult> {
  const publicKey = requireEnv('ILOVEPDF_PUBLIC_KEY');

  // Step 1: process the source task if not yet processed
  if (!processedTasks.has(task.task)) {
    const sourceOpts = buildProcessOptions(task.files, {
      compression_level: 'recommended',
    });
    try {
      await processWithAuthRetry(
        task.server,
        task.task,
        tokenState,
        task.task_tool,
        sourceOpts
      );
    } catch (err) {
      if (err instanceof ToolError) throw err;
      throw new ToolError(
        'UPSTREAM_ERROR',
        `Re-upload fallback: source task processing failed: ${err instanceof Error ? err.message : String(err)}`,
        'Processing failed during re-upload. Please try again.',
        false
      );
    }
    processedTasks.add(task.task);
  }

  // Step 2: download URL for the source output
  const sourceDownloadUrl = buildDownloadUrl(
    task.server,
    task.task,
    tokenState.token
  );

  // Step 3: fresh task with the correct tool
  let freshToken: string;
  try {
    freshToken = await authenticateILovePDF(publicKey);
  } catch (err) {
    throw new ToolError(
      'AUTH_FAILED',
      `Re-upload fallback: auth failed: ${err instanceof Error ? err.message : String(err)}`,
      'Authentication failed during re-upload. Please try again.',
      true
    );
  }

  let freshTaskData: { server: string; task: string };
  try {
    const { startILovePDFTask } = await import('./ilovepdf-api.js');
    freshTaskData = await startILovePDFTask(op.apiTool, freshToken);
  } catch (err) {
    throw new ToolError(
      'UPLOAD_FAILED',
      `Re-upload fallback: failed to start fresh task: ${err instanceof Error ? err.message : String(err)}`,
      'Failed to start new processing task. Please try again.',
      true
    );
  }

  // Step 4: upload the source output into the fresh task
  const originalFilename = task.files[0]?.filename || 'file.pdf';
  let uploaded: import('../types.js').ILovePDFFile;
  try {
    uploaded = await uploadCloudFile(
      freshTaskData.server,
      freshTaskData.task,
      sourceDownloadUrl,
      originalFilename,
      freshToken
    );
  } catch (err) {
    throw new ToolError(
      'UPLOAD_FAILED',
      `Re-upload fallback: upload to fresh task failed: ${err instanceof Error ? err.message : String(err)}`,
      'Upload failed during re-upload fallback. Please try again.',
      true
    );
  }

  const freshFiles: ILovePDFFile[] = [
    { server_filename: uploaded.server_filename, filename: originalFilename },
  ];
  const freshTokenState = { token: freshToken };
  const freshOpts = buildProcessOptions(freshFiles, options);

  // Step 5: process the fresh task
  let rawResult: import('../types.js').ILovePDFProcessResponse;
  try {
    rawResult = await processWithAuthRetry(
      freshTaskData.server,
      freshTaskData.task,
      freshTokenState,
      op.apiTool,
      freshOpts
    );
  } catch (err) {
    if (err instanceof ToolError) throw err;
    throw new ToolError(
      'UPSTREAM_ERROR',
      `Re-upload fallback: fresh task processing failed: ${err instanceof Error ? err.message : String(err)}`,
      'Processing failed on fresh task. Please try again.',
      false
    );
  }

  processedTasks.add(freshTaskData.task);

  const downloadUrl = buildDownloadUrl(
    freshTaskData.server,
    freshTaskData.task,
    freshTokenState.token
  );
  return buildResult(rawResult, downloadUrl, freshFiles);
}

// ---------------------------------------------------------------------------
// Strategy: connected-task fallback
// ---------------------------------------------------------------------------

/**
 * Connected-task fallback strategy (chain-safe tools only).
 *
 * 1. Process the parent task (skip if already processed).
 * 2. Create a connected task with op.apiTool.
 * 3. Process the connected task.
 */
async function connectedTaskFallback(
  op: OperationSpec,
  task: TaskCreds,
  tokenState: { token: string },
  options: ProcessOptions,
  processedTasks: Set<string>
): Promise<ExecuteResult> {
  // Step 1: process parent task if not yet done
  if (!processedTasks.has(task.task)) {
    const parentOpts = buildProcessOptions(task.files, {
      compression_level: 'recommended',
    });
    try {
      await processWithAuthRetry(
        task.server,
        task.task,
        tokenState,
        task.task_tool,
        parentOpts
      );
    } catch (err) {
      if (err instanceof ToolError) throw err;
      throw new ToolError(
        'UPSTREAM_ERROR',
        `Connected-task fallback: parent task failed: ${err instanceof Error ? err.message : String(err)}`,
        'Processing failed. Please try again.',
        false
      );
    }
    processedTasks.add(task.task);
  }

  // Step 2: create connected task
  let connectedTaskData: import('../types.js').ILovePDFTask;
  try {
    connectedTaskData = await createConnectedTask(
      task.server,
      task.task,
      op.apiTool,
      tokenState.token
    );
  } catch (err) {
    if (err instanceof ToolError) throw err;
    throw new ToolError(
      'UPSTREAM_ERROR',
      `Connected-task creation failed for ${op.apiTool}: ${err instanceof Error ? err.message : String(err)}`,
      'Failed to create connected task. Please try again.',
      false
    );
  }

  const connectedServer = connectedTaskData.server || task.server;
  const connectedTask = connectedTaskData.task;

  // The connected task response maps new server_filenames → original filenames
  const connectedFilesMap = connectedTaskData.files || {};
  const newServerFilenames = Object.keys(connectedFilesMap);

  const connectedFiles: ILovePDFFile[] =
    newServerFilenames.length > 0
      ? newServerFilenames.map(sf => ({
          server_filename: sf,
          filename:
            connectedFilesMap[sf] || task.files[0]?.filename || 'file.pdf',
        }))
      : task.files;

  const connectedOpts = buildProcessOptions(connectedFiles, options);

  // Step 3: process connected task
  let rawResult: import('../types.js').ILovePDFProcessResponse;
  try {
    rawResult = await processWithAuthRetry(
      connectedServer,
      connectedTask,
      tokenState,
      op.apiTool,
      connectedOpts
    );
  } catch (err) {
    if (err instanceof ToolError) throw err;
    throw new ToolError(
      'UPSTREAM_ERROR',
      `Connected-task processing failed: ${err instanceof Error ? err.message : String(err)}`,
      'Processing failed on connected task. Please try again.',
      false
    );
  }

  processedTasks.add(connectedTask);

  const downloadUrl = buildDownloadUrl(
    connectedServer,
    connectedTask,
    tokenState.token
  );
  return buildResult(rawResult, downloadUrl, connectedFiles);
}

// ---------------------------------------------------------------------------
// Helper: canChain
// ---------------------------------------------------------------------------

/**
 * Returns true if the operation can safely use the connected-task path.
 * Excluded:
 *   - pdf-ocr (connected-task returns 500 — empirically confirmed)
 *   - watermark (connected-task returns ProcessingError — iLovePDF rejects it)
 *   - mustBeDirect operations (unlock etc.)
 */
function canChain(op: OperationSpec): boolean {
  return (
    op.apiTool !== 'pdfocr' && op.apiTool !== 'watermark' && !op.mustBeDirect
  );
}
