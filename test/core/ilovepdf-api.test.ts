/**
 * test/core/ilovepdf-api.test.ts
 *
 * Unit tests for the fetch-based iLovePDF v1 REST client (core/ilovepdf-api.ts).
 * Exercised against the shared mock fetch router (test/helpers/mock-ilovepdf-fetch.ts)
 * so no network / real API keys are needed.
 *
 * Coverage (ERR-3):
 * - happy paths: authenticate / start / uploadCloud / uploadBinary /
 *   uploadFromDownloadUrl (download + upload) / process
 * - extractErrorMessage: nested `error.message`, `error` as a bare string
 * - /process error branch: WrongPassword op-aware special-casing (unlock vs. other)
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  installMockILovePDFFetch,
  TEST_CONNECTED_TASK,
  TEST_DOWNLOAD_FILENAME,
  TEST_FILENAME,
  TEST_SERVER,
  TEST_SERVER_FILENAME,
  TEST_TASK,
  TEST_TOKEN,
  type MockILovePDFHandle,
} from '../helpers/mock-ilovepdf-fetch.js';
import {
  authenticateILovePDF,
  createConnectedTask,
  processILovePDFTask,
  startILovePDFTask,
  uploadBinaryFile,
  uploadCloudFile,
} from '../../src/core/ilovepdf-api.js';

let mock: MockILovePDFHandle;

beforeEach(() => {
  mock = installMockILovePDFFetch();
});

afterEach(() => {
  mock.restore();
});

describe('authenticateILovePDF', () => {
  it('returns the JWT token on success', async () => {
    const token = await authenticateILovePDF('public-key');
    expect(token).toBe(TEST_TOKEN);
  });

  it('throws with an extracted message on failure', async () => {
    mock.forceError('auth', 401);
    await expect(authenticateILovePDF('bad-key')).rejects.toThrow(
      /Mocked iLovePDF error/
    );
  });
});

describe('startILovePDFTask', () => {
  it('returns the server + task on success', async () => {
    const result = await startILovePDFTask('compress', TEST_TOKEN);
    expect(result.server).toBe(TEST_SERVER);
    expect(result.task).toBe(TEST_TASK);
  });

  it('throws when the API rejects the request', async () => {
    mock.forceError('start', 403);
    await expect(startILovePDFTask('compress', TEST_TOKEN)).rejects.toThrow();
  });
});

describe('uploadCloudFile', () => {
  it('returns the uploaded file descriptor', async () => {
    const file = await uploadCloudFile(
      TEST_SERVER,
      TEST_TASK,
      'https://example.com/file.pdf',
      'file.pdf',
      TEST_TOKEN
    );
    expect(file.server_filename).toBe(TEST_SERVER_FILENAME);
    expect(file.filename).toBe(TEST_FILENAME);
  });

  it('throws on upload failure', async () => {
    mock.forceError('upload', 500);
    await expect(
      uploadCloudFile(TEST_SERVER, TEST_TASK, 'https://x/f.pdf', 'f.pdf', TEST_TOKEN)
    ).rejects.toThrow();
  });
});

describe('uploadBinaryFile', () => {
  it('uploads binary bytes and returns the file descriptor', async () => {
    const bytes = new Uint8Array([0x25, 0x50, 0x44, 0x46]).buffer;
    const file = await uploadBinaryFile(
      TEST_SERVER,
      TEST_TASK,
      'file.pdf',
      TEST_TOKEN,
      bytes
    );
    expect(file.server_filename).toBe(TEST_SERVER_FILENAME);
  });

  it('sends a multipart FormData body', async () => {
    const bytes = new Uint8Array([1, 2, 3]).buffer;
    await uploadBinaryFile(TEST_SERVER, TEST_TASK, 'file.pdf', TEST_TOKEN, bytes);
    const [, init] = mock.fetchMock.mock.calls.at(-1)!;
    expect(init?.body).toBeInstanceOf(FormData);
  });
});

describe('processILovePDFTask', () => {
  it('returns the process response on success', async () => {
    const result = await processILovePDFTask(
      TEST_SERVER,
      TEST_TASK,
      TEST_TOKEN,
      'compress',
      { files: [{ server_filename: TEST_SERVER_FILENAME, filename: TEST_FILENAME }] }
    );
    expect(result.download_filename).toBe(TEST_DOWNLOAD_FILENAME);
  });

  it('extracts a nested error.message on failure', async () => {
    mock.forceError('process', 400, {
      error: { message: 'Something specific went wrong' },
    });
    await expect(
      processILovePDFTask(TEST_SERVER, TEST_TASK, TEST_TOKEN, 'compress', {
        files: [],
      })
    ).rejects.toThrow(/Something specific went wrong/);
  });

  it('uses a bare string error value (error.message || error)', async () => {
    mock.forceError('process', 400, { error: 'PlainStringError' });
    await expect(
      processILovePDFTask(TEST_SERVER, TEST_TASK, TEST_TOKEN, 'compress', {
        files: [],
      })
    ).rejects.toThrow(/PlainStringError/);
  });

  it('gives an op-aware message for WrongPassword on the unlock tool', async () => {
    mock.forceError('process', 400, {
      error: {
        type: 'ProcessError',
        message: 'process error',
        param: [{ error: 'WrongPassword' }],
        code: 400,
      },
    });
    await expect(
      processILovePDFTask(TEST_SERVER, TEST_TASK, TEST_TOKEN, 'unlock', {
        files: [],
      })
    ).rejects.toThrow(/Incorrect password/i);
  });

  it('gives a generic message for WrongPassword on non-unlock tools', async () => {
    mock.forceError('process', 400, {
      error: {
        type: 'ProcessError',
        message: 'process error',
        param: [{ error: 'WrongPassword' }],
        code: 400,
      },
    });
    await expect(
      processILovePDFTask(TEST_SERVER, TEST_TASK, TEST_TOKEN, 'compress', {
        files: [],
      })
    ).rejects.toThrow(/could not be processed/i);
  });
});

describe('createConnectedTask', () => {
  it('resolves to the chained task from /v1/task/next on success', async () => {
    const next = await createConnectedTask(
      TEST_SERVER,
      TEST_TASK,
      'pdfjpg',
      TEST_TOKEN
    );
    expect(next).toEqual({ server: TEST_SERVER, task: TEST_CONNECTED_TASK });
  });

  it('throws with an extracted message when the API rejects the request', async () => {
    mock.forceError('taskNext', 400);
    await expect(
      createConnectedTask(TEST_SERVER, TEST_TASK, 'pdfjpg', TEST_TOKEN)
    ).rejects.toThrow(/Mocked iLovePDF error/);
  });
});
