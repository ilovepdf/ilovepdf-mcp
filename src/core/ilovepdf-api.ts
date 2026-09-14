/**
 * core/ilovepdf-api.ts
 *
 * fetch-based iLovePDF v1 REST client (auth / start / upload / process /
 * download / connected tasks).
 *
 * Ported ~verbatim from ../openai-app/mcp-server/src/lib/ilovepdf-api.ts. The
 * client is already Node-friendly (global fetch / FormData / Blob) so the port
 * only updates relative imports to the NodeNext `.js` convention. The error
 * handling — nested `error.message` / `error.param` extraction and the
 * WrongPassword op-aware special-casing in the `/process` branch — is preserved
 * as-is (ERR-3).
 */

import type {
  ILovePDFAuth,
  ILovePDFTask,
  ILovePDFFile,
  ILovePDFProcessResponse,
  ILovePDFProcessOptions,
} from '../types.js';

/**
 * Extract error message from iLovePDF API response
 */
async function extractErrorMessage(
  response: Response,
  defaultMessage: string
): Promise<string> {
  let errorMessage = `${defaultMessage}: ${response.statusText}`;
  try {
    const errorData = await response.json();
    if (errorData.error) {
      errorMessage = errorData.error.message || errorData.error;
    } else if (errorData.message) {
      errorMessage = errorData.message;
    }
  } catch {
    const errorText = await response.text();
    if (errorText) errorMessage = `${defaultMessage}: ${errorText}`;
  }
  return errorMessage;
}

export async function authenticateILovePDF(publicKey: string): Promise<string> {
  const response = await fetch('https://api.ilovepdf.com/v1/auth', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      public_key: publicKey,
    }),
  });

  if (!response.ok) {
    const errorMessage = await extractErrorMessage(
      response,
      'Authentication failed'
    );
    throw new Error(errorMessage);
  }

  const authData: ILovePDFAuth = await response.json();
  return authData.token;
}

export async function startILovePDFTask(
  tool: string,
  token: string
): Promise<ILovePDFTask> {
  const response = await fetch(`https://api.ilovepdf.com/v1/start/${tool}`, {
    method: 'GET',
    headers: {
      'Authorization': `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
  });

  if (!response.ok) {
    const errorMessage = await extractErrorMessage(
      response,
      `Failed to start ${tool} task`
    );
    throw new Error(errorMessage);
  }

  return await response.json();
}

export async function uploadCloudFile(
  server: string,
  task: string,
  fileUrl: string,
  filename: string = 'file.pdf',
  token: string
): Promise<ILovePDFFile> {
  const response = await fetch(`https://${server}/v1/upload`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      task,
      cloud_file: fileUrl,
      filename,
    }),
  });

  if (!response.ok) {
    const errorMessage = await extractErrorMessage(
      response,
      'Failed to upload cloud file'
    );
    throw new Error(errorMessage);
  }

  return await response.json();
}

const MIME_BY_EXTENSION: Record<string, string> = {
  '.pdf': 'application/pdf',
  '.doc': 'application/msword',
  '.docx':
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.xls': 'application/vnd.ms-excel',
  '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  '.ppt': 'application/vnd.ms-powerpoint',
  '.pptx':
    'application/vnd.openxmlformats-officedocument.presentationml.presentation',
};

function guessMimeType(filename: string): string {
  const lower = filename.toLowerCase();
  for (const [ext, mime] of Object.entries(MIME_BY_EXTENSION)) {
    if (lower.endsWith(ext)) {
      return mime;
    }
  }
  return 'application/octet-stream';
}

export async function uploadBinaryFile(
  server: string,
  task: string,
  filename: string,
  token: string,
  fileBytes: ArrayBuffer,
  contentType?: string
): Promise<ILovePDFFile> {
  const uploadUrl = `https://${server}/v1/upload`;
  const form = new FormData();
  form.append('task', task);

  const blob = new Blob([fileBytes], {
    type: contentType || guessMimeType(filename),
  });

  form.append('file', blob, filename);

  const response = await fetch(uploadUrl, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
    },
    body: form,
  });

  if (!response.ok) {
    const errorMessage = await extractErrorMessage(
      response,
      'Failed to upload file'
    );
    throw new Error(errorMessage);
  }

  return await response.json();
}

export async function processILovePDFTask(
  server: string,
  task: string,
  token: string,
  tool: string,
  options: ILovePDFProcessOptions
): Promise<ILovePDFProcessResponse> {
  const payload = {
    task,
    tool,
    ...options,
  };

  const response = await fetch(`https://${server}/v1/process`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(payload),
  });

  if (!response.ok) {
    let errorMessage = `Failed to process task: ${response.statusText}`;
    try {
      const errorData = await response.json();
      // Handle nested error structure from iLovePDF
      if (errorData.error) {
        const apiError = errorData.error;
        let detailedMessage = '';

        if (apiError.files) {
          detailedMessage =
            `${apiError.message || ''} ${apiError.files}`.trim();
        } else if (apiError.param) {
          if (Array.isArray(apiError.param)) {
            interface ParamError {
              error?: string;
              [key: string]: unknown;
            }
            const fileErrors = (apiError.param as ParamError[])
              .filter(p => p.error)
              .map(p => p.error as string);

            if (fileErrors.length > 0) {
              const errorType = fileErrors[0];
              if (errorType === 'WrongPassword') {
                // TEMPORARILY DISABLED — unlock tool commented out; re-enable to
                // publish and restore the op-aware "Incorrect password" branch.
                // if (tool === 'unlock') {
                //   detailedMessage = 'Incorrect password. Please try again.';
                // } else {
                detailedMessage =
                  'The file could not be processed. It may be password-protected, encrypted, or corrupted. Please check the file and try again.';
                // }
              } else if (errorType.toLowerCase().includes('password')) {
                detailedMessage = `Password error: ${errorType}`;
              } else {
                detailedMessage = fileErrors.join(', ');
              }
            }
          } else if (typeof apiError.param === 'string') {
            detailedMessage =
              `${apiError.message || ''} (${apiError.param})`.trim();
          }
        }

        if (detailedMessage) {
          errorMessage = detailedMessage;
        } else if (apiError.message) {
          errorMessage = apiError.message;
        } else if (typeof apiError === 'string') {
          errorMessage = apiError;
        }

        if (apiError.type && !errorMessage.includes(apiError.type)) {
          errorMessage = `${apiError.type}: ${errorMessage}`;
        }
        if (apiError.code && apiError.code !== 400) {
          errorMessage = `[${apiError.code}] ${errorMessage}`;
        }
      } else if (errorData.message) {
        errorMessage = errorData.message;
      }
    } catch {
      const errorText = await response.text();
      if (errorText) {
        errorMessage = `Failed to process task: ${errorText}`;
      }
    }
    throw new Error(errorMessage);
  }

  const responseData: ILovePDFProcessResponse = await response.json();
  return responseData;
}

/**
 * Create a connected task from an existing task.
 * This allows processing files from a previous task with a different tool
 * WITHOUT re-uploading the files.
 *
 * @param server - The server where the original task exists
 * @param parentTask - The task ID of the parent task
 * @param newTool - The tool for the new task (e.g., 'pdfjpg', 'merge', etc.)
 * @param token - The JWT token for authentication
 * @returns The new task data (server and task ID)
 */
export async function createConnectedTask(
  server: string,
  parentTask: string,
  newTool: string,
  token: string
): Promise<ILovePDFTask> {
  const response = await fetch(`https://${server}/v1/task/next`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      task: parentTask,
      tool: newTool,
    }),
  });

  if (!response.ok) {
    const errorMessage = await extractErrorMessage(
      response,
      `Failed to create connected task for tool: ${newTool}`
    );
    throw new Error(errorMessage);
  }

  return await response.json();
}
