/**
 * core/upload-service.ts
 *
 * Upload helpers that create iLovePDF tasks with the CORRECT apiTool from the
 * start (DIRECT-path default, AD-2) and wrap upload calls in a 401/403
 * re-auth-once retry (ERR-4) plus a fresh-task retry that works around
 * intermittently bad regional nodes (ERR-5).
 *
 * Ported from ../openai-app/mcp-server/src/services/upload-service.ts and
 * DECOUPLED from the widget flow: the old url/attachment-specific entry points
 * (`uploadUrls`, `uploadAttachments`) collapse into a single `uploadFiles`
 * driven by a normalized `UploadFileInput` union. Callers hand us either a
 * cloud URL or raw bytes; the service picks `uploadCloudFile` vs.
 * `uploadBinaryFile` accordingly (TOOL-4).
 *
 * Two entry points:
 *
 *   uploadFiles(op, files, env)
 *     - Creates a task for op.apiTool, then uploads every source into it.
 *     - Used by non-shared-task operations.
 *
 *   uploadIntoSharedTask(op, files, env)
 *     - Same as uploadFiles but names the shared-task intent explicitly: every
 *       source lands in ONE task (merge-pdf, image-to-pdf: requiresSharedTask).
 *
 * The `withAuthRetry` (re-auth once on 401) and `retryOnBadNode`
 * (MAX_NODE_RETRIES = 2, delays [500, 1000]) helpers are preserved VERBATIM
 * from the source; only `console.log` is routed through the stderr `log` facade
 * (LOG-3) so it can never contaminate stdout on the stdio transport.
 *
 * Returns `TaskCreds` — the task credentials needed by `operation-executor`.
 */

import {
  authenticateILovePDF,
  startILovePDFTask,
  uploadBinaryFile,
  uploadCloudFile,
} from './ilovepdf-api.js';
import { requireEnv } from '../lib/env.js';
import { ToolError } from '../domain/errors.js';
import type { OperationSpec } from '../domain/operation-types.js';
import type { ILovePDFFile } from '../types.js';
import { isAuthError } from './auth-utils.js';
import { log } from './audit-logger.js';

// ---------------------------------------------------------------------------
// Exported types
// ---------------------------------------------------------------------------

/**
 * Task credentials returned after uploading files.
 * Consumed by `operation-executor.execute` to call /process.
 */
export interface TaskCreds {
  /** iLovePDF task server hostname (e.g. "api4.ilovepdf.com") */
  server: string;
  /** iLovePDF task ID */
  task: string;
  /** Bearer token scoped to this task */
  token: string;
  /**
   * The API tool slug the task was created with.
   * Should equal op.apiTool for DIRECT-path tasks.
   */
  task_tool: string;
  /** Files uploaded into this task (needed for the /process payload). */
  files: ILovePDFFile[];
}

/**
 * A normalized file source. The headless server hands the upload service either
 * a cloud URL (fetched by iLovePDF itself) or raw bytes read from a local file.
 *
 * - kind 'url'   → uploaded via `uploadCloudFile`. `filename` is optional and
 *   derived from the URL when omitted.
 * - kind 'bytes' → uploaded via `uploadBinaryFile` (multipart). `filename` is
 *   required so the API and downstream contract have a stable name.
 */
export type UploadFileInput =
  | { kind: 'url'; url: string; filename?: string }
  | { kind: 'bytes'; bytes: ArrayBuffer; filename: string };

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Re-authenticate once and retry an upload operation.
 * Throws `ToolError('AUTH_FAILED', ...)` if the retry also fails.
 */
async function withAuthRetry<T>(
  publicKey: string,
  fn: (freshToken: string) => Promise<T>,
  originalToken: string,
  firstAttempt: () => Promise<T>
): Promise<{ result: T; token: string }> {
  try {
    const result = await firstAttempt();
    return { result, token: originalToken };
  } catch (err) {
    if (!isAuthError(err)) throw err;

    let freshToken: string;
    try {
      freshToken = await authenticateILovePDF(publicKey);
    } catch (authErr) {
      throw new ToolError(
        'AUTH_FAILED',
        `Re-authentication failed: ${authErr instanceof Error ? authErr.message : String(authErr)}`,
        'Authentication failed. Please try again.',
        true
      );
    }

    try {
      const result = await fn(freshToken);
      return { result, token: freshToken };
    } catch (retryErr) {
      throw new ToolError(
        'AUTH_FAILED',
        `Upload failed after re-auth: ${retryErr instanceof Error ? retryErr.message : String(retryErr)}`,
        'Authentication failed after retry. Please try again.',
        true
      );
    }
  }
}

/**
 * Upload a single normalized source into an existing task, with auth-retry.
 * Returns the (possibly refreshed) token alongside the uploaded file entry.
 */
async function uploadFileIntoTask(
  publicKey: string,
  server: string,
  task: string,
  token: string,
  file: UploadFileInput,
  op: OperationSpec
): Promise<{ uploaded: ILovePDFFile; token: string }> {
  if (file.kind === 'bytes') {
    const filename = file.filename;
    const { result, token: newToken } = await withAuthRetry(
      publicKey,
      freshToken =>
        uploadBinaryFile(server, task, filename, freshToken, file.bytes),
      token,
      () => uploadBinaryFile(server, task, filename, token, file.bytes)
    );
    return {
      uploaded: {
        server_filename: result.server_filename,
        filename: result.filename || filename,
      },
      token: newToken,
    };
  }

  const filename = file.filename || deriveFilename(file.url, op);
  const { result, token: newToken } = await withAuthRetry(
    publicKey,
    freshToken => uploadCloudFile(server, task, file.url, filename, freshToken),
    token,
    () => uploadCloudFile(server, task, file.url, filename, token)
  );
  return {
    uploaded: {
      server_filename: result.server_filename,
      filename: result.filename || filename,
    },
    token: newToken,
  };
}

// ---------------------------------------------------------------------------
// Internal: bad regional node retry
// ---------------------------------------------------------------------------

/**
 * Retry the FULL auth→start→upload flow up to MAX_NODE_RETRIES times when it
 * fails with AUTH_FAILED.
 *
 * Probe-confirmed (2026-06-10): some iLovePDF regional servers intermittently
 * reject freshly issued, valid tokens with 401 "Signature verification failed"
 * (~1 in 12 /v1/start assignments). The per-file re-auth retry (ERR-4) cannot
 * recover because it re-targets the SAME bad node. A fresh /v1/start lands on
 * a different (almost certainly healthy) node.
 *
 * With 2 retries (3 total attempts) and ~8% bad-node rate per attempt,
 * compound failure drops from ~0.64% (1 retry) to ~0.05%.
 */
const MAX_NODE_RETRIES = 2;
const NODE_RETRY_DELAYS_MS = [500, 1000];

async function retryOnBadNode<T>(fn: () => Promise<T>): Promise<T> {
  for (let attempt = 0; attempt <= MAX_NODE_RETRIES; attempt++) {
    try {
      return await fn();
    } catch (err) {
      const isLastAttempt = attempt === MAX_NODE_RETRIES;
      if (
        isLastAttempt ||
        !(err instanceof ToolError) ||
        err.code !== 'AUTH_FAILED'
      ) {
        throw err;
      }
      const delay = NODE_RETRY_DELAYS_MS[attempt] ?? 1000;
      log.info(
        `[upload-service] AUTH_FAILED on attempt ${attempt + 1} — likely bad regional node; retrying in ${delay}ms (attempt ${attempt + 2}/${MAX_NODE_RETRIES + 1})`
      );
      await new Promise(resolve => setTimeout(resolve, delay));
    }
  }
  // Unreachable — loop always returns or throws
  throw new ToolError(
    'AUTH_FAILED',
    'Exhausted node retries',
    'Authentication failed after multiple retries. Please try again.',
    true
  );
}

// ---------------------------------------------------------------------------
// Public: uploadFiles / uploadIntoSharedTask
// ---------------------------------------------------------------------------

/**
 * Create an iLovePDF task for `op.apiTool` (DIRECT path, AD-2) and upload every
 * normalized source into it. Bytes go through `uploadBinaryFile`, URLs through
 * `uploadCloudFile`.
 *
 * Wraps each upload in a 401/403 re-auth-once retry (ERR-4), and the whole flow
 * in a fresh-task retry for bad-regional-node mitigation (ERR-5).
 *
 * @throws ToolError('AUTH_FAILED')   on persistent auth failure
 * @throws ToolError('UPLOAD_FAILED') on non-auth task-start errors
 */
export async function uploadFiles(
  op: OperationSpec,
  files: UploadFileInput[],
  env: { ILOVEPDF_PUBLIC_KEY: string }
): Promise<TaskCreds> {
  return retryOnBadNode(() => uploadFilesOnce(op, files, env));
}

/**
 * Create a SINGLE iLovePDF task for `op.apiTool` and upload EVERY source into
 * that one task. This is the correct path for shared-task operations
 * (merge-pdf, image-to-pdf) where files spread across separate tasks would be
 * silently dropped by iLovePDF.
 *
 * Behaviourally identical to `uploadFiles` (which already uses a single task);
 * exposed separately to make the shared-task intent explicit at call sites.
 *
 * @throws ToolError('AUTH_FAILED')   on persistent auth failure
 * @throws ToolError('UPLOAD_FAILED') on non-auth task-start errors
 */
export async function uploadIntoSharedTask(
  op: OperationSpec,
  files: UploadFileInput[],
  env: { ILOVEPDF_PUBLIC_KEY: string }
): Promise<TaskCreds> {
  return retryOnBadNode(() => uploadFilesOnce(op, files, env));
}

async function uploadFilesOnce(
  op: OperationSpec,
  files: UploadFileInput[],
  env: { ILOVEPDF_PUBLIC_KEY: string }
): Promise<TaskCreds> {
  const publicKey =
    env.ILOVEPDF_PUBLIC_KEY || requireEnv('ILOVEPDF_PUBLIC_KEY');

  let token: string;
  try {
    token = await authenticateILovePDF(publicKey);
  } catch (err) {
    throw new ToolError(
      'AUTH_FAILED',
      `Authentication failed: ${err instanceof Error ? err.message : String(err)}`,
      'Authentication failed. Please try again.',
      true
    );
  }

  let taskData: { server: string; task: string };
  try {
    taskData = await startILovePDFTask(op.apiTool, token);
  } catch (err) {
    throw new ToolError(
      'UPLOAD_FAILED',
      `Failed to start task for ${op.apiTool}: ${err instanceof Error ? err.message : String(err)}`,
      'Failed to start processing task. Please try again.',
      true
    );
  }

  const uploadResults = await Promise.all(
    files.map(f =>
      uploadFileIntoTask(publicKey, taskData.server, taskData.task, token, f, op)
    )
  );

  const uploadedFiles: ILovePDFFile[] = uploadResults.map(r => r.uploaded);
  const refreshedToken = uploadResults.find(r => r.token !== token)?.token;
  if (refreshedToken) {
    token = refreshedToken;
  }

  return {
    server: taskData.server,
    task: taskData.task,
    token,
    task_tool: op.apiTool,
    files: uploadedFiles,
  };
}

// ---------------------------------------------------------------------------
// Internal: filename helpers
// ---------------------------------------------------------------------------

/**
 * Derive a sensible filename from a URL when the caller does not supply one.
 * Falls back to 'file.<first-accepted-extension>' for the operation.
 */
function deriveFilename(url: string, op: OperationSpec): string {
  try {
    const pathname = new URL(url).pathname;
    const last = pathname.split('/').filter(Boolean).pop();
    if (last && last.includes('.')) {
      return decodeURIComponent(last);
    }
  } catch {
    // Malformed URL — fall through to default
  }

  const ext = op.acceptedExtensions[0] ?? '.pdf';
  return `file${ext}`;
}
