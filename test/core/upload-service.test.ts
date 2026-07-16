/**
 * test/core/upload-service.test.ts
 *
 * Unit tests for the headless upload service (core/upload-service.ts), exercised
 * against the shared mock fetch router (test/helpers/mock-ilovepdf-fetch.ts).
 *
 * Coverage:
 * - ERR-4: withAuthRetry re-authenticates once on a 401 upload and then succeeds.
 * - ERR-5: retryOnBadNode recovers when an early attempt raises AUTH_FAILED and
 *   still lands within 3 attempts; it raises AUTH_FAILED once the retries are
 *   exhausted; a NON-auth upload error is NOT node-retried.
 * - TOOL-4: both a { kind: 'url' } and a { kind: 'bytes' } source upload work,
 *   and the shared-task path uploads multiple sources into ONE task.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  installMockILovePDFFetch,
  TEST_SERVER,
  TEST_SERVER_FILENAME,
  TEST_TASK,
  TEST_TOKEN,
  type MockILovePDFHandle,
} from '../helpers/mock-ilovepdf-fetch.js';
import { specFor } from '../../src/domain/operations.js';
import {
  uploadFiles,
  uploadIntoSharedTask,
  type UploadFileInput,
} from '../../src/core/upload-service.js';

const ENV = { ILOVEPDF_PUBLIC_KEY: 'test-public-key' };

let mock: MockILovePDFHandle;

beforeEach(() => {
  mock = installMockILovePDFFetch();
});

afterEach(() => {
  mock.restore();
});

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

/** Resolve the URL string from a recorded fetch call argument. */
function urlOf(input: unknown): string {
  if (typeof input === 'string') return input;
  if (input instanceof URL) return input.toString();
  return (input as Request).url;
}

/** Count recorded fetch calls whose URL ends with the given path suffix. */
function callsEndingWith(suffix: string): number {
  return mock.fetchMock.mock.calls.filter(([input]) =>
    urlOf(input).endsWith(suffix)
  ).length;
}

/** An iLovePDF-shaped 401 whose message trips `isAuthError`. */
function auth401(): Response {
  return new Response(
    JSON.stringify({
      error: { message: '401 Unauthorized — Signature verification failed' },
    }),
    { status: 401, headers: { 'Content-Type': 'application/json' } }
  );
}

/**
 * Make the FIRST `n` calls to /v1/upload fail with a 401, delegating every
 * other request (including later uploads) to the default mock router. This lets
 * us reproduce fail-then-succeed sequences the flat config overrides cannot.
 */
function failFirstUploads(n: number): void {
  const original = mock.fetchMock.getMockImplementation()!;
  let uploadCalls = 0;
  mock.fetchMock.mockImplementation(
    async (input: RequestInfo | URL, init?: RequestInit) => {
      if (urlOf(input).endsWith('/v1/upload')) {
        uploadCalls += 1;
        if (uploadCalls <= n) return auth401();
      }
      return original(input, init);
    }
  );
}

const URL_FILE: UploadFileInput = {
  kind: 'url',
  url: 'https://example.com/doc.pdf',
  filename: 'doc.pdf',
};

const BYTES_FILE: UploadFileInput = {
  kind: 'bytes',
  bytes: new Uint8Array([0x25, 0x50, 0x44, 0x46]).buffer,
  filename: 'scan.pdf',
};

// ---------------------------------------------------------------------------
// TOOL-4: normalized sources
// ---------------------------------------------------------------------------

describe('uploadFiles — normalized sources (TOOL-4)', () => {
  it('uploads a { kind: "url" } source via the cloud-file endpoint', async () => {
    const creds = await uploadFiles(specFor('compress-pdf'), [URL_FILE], ENV);

    expect(creds.server).toBe(TEST_SERVER);
    expect(creds.task).toBe(TEST_TASK);
    expect(creds.token).toBe(TEST_TOKEN);
    expect(creds.task_tool).toBe('compress');
    expect(creds.files).toHaveLength(1);
    expect(creds.files[0].server_filename).toBe(TEST_SERVER_FILENAME);

    // A URL source sends a JSON cloud_file body (not multipart FormData).
    const uploadCall = mock.fetchMock.mock.calls.find(([input]) =>
      urlOf(input).endsWith('/v1/upload')
    )!;
    const body = uploadCall[1]?.body;
    expect(typeof body).toBe('string');
    expect(String(body)).toContain('cloud_file');
  });

  it('uploads a { kind: "bytes" } source via a multipart FormData body', async () => {
    const creds = await uploadFiles(specFor('compress-pdf'), [BYTES_FILE], ENV);

    expect(creds.files).toHaveLength(1);
    expect(creds.files[0].server_filename).toBe(TEST_SERVER_FILENAME);

    const uploadCall = mock.fetchMock.mock.calls.find(([input]) =>
      urlOf(input).endsWith('/v1/upload')
    )!;
    expect(uploadCall[1]?.body).toBeInstanceOf(FormData);
  });
});

describe('uploadIntoSharedTask — one task for many sources (TOOL-4)', () => {
  it('uploads a mix of url + bytes sources into a SINGLE task', async () => {
    const creds = await uploadIntoSharedTask(
      specFor('merge-pdf'),
      [URL_FILE, BYTES_FILE],
      ENV
    );

    expect(creds.task_tool).toBe('merge');
    expect(creds.files).toHaveLength(2);

    // Exactly one /v1/start (single shared task) and two /v1/upload calls.
    expect(callsEndingWith('/v1/upload')).toBe(2);
    expect(
      mock.fetchMock.mock.calls.filter(([input]) =>
        urlOf(input).includes('/v1/start/')
      )
    ).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// ERR-4: re-auth once on 401 then success
// ---------------------------------------------------------------------------

describe('withAuthRetry — re-auth once on 401 (ERR-4)', () => {
  it('re-authenticates after a 401 upload and then succeeds', async () => {
    failFirstUploads(1);

    const creds = await uploadFiles(specFor('compress-pdf'), [URL_FILE], ENV);

    expect(creds.files).toHaveLength(1);
    // First upload 401 → re-auth → second upload succeeds.
    expect(callsEndingWith('/v1/upload')).toBe(2);
    // /v1/auth is hit twice: initial auth + one re-auth.
    expect(callsEndingWith('/v1/auth')).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// ERR-5: bad-node retry semantics
// ---------------------------------------------------------------------------

describe('retryOnBadNode — bad regional node recovery (ERR-5)', () => {
  it('recovers from an AUTH_FAILED attempt within 3 attempts', async () => {
    // Attempt 1: upload#1 401 → re-auth → upload#2 401 → AUTH_FAILED.
    // Attempt 2: upload#3 succeeds.
    failFirstUploads(2);

    const creds = await uploadFiles(specFor('compress-pdf'), [URL_FILE], ENV);

    expect(creds.files).toHaveLength(1);
    // 2 failing uploads (attempt 1) + 1 succeeding upload (attempt 2).
    expect(callsEndingWith('/v1/upload')).toBe(3);
  });

  it('raises AUTH_FAILED once the node retries are exhausted', async () => {
    // Every upload 401 forever → each of the 3 attempts fails with AUTH_FAILED.
    mock.forceError('upload', 401);

    await expect(
      uploadFiles(specFor('compress-pdf'), [URL_FILE], ENV)
    ).rejects.toMatchObject({ code: 'AUTH_FAILED' });

    // 3 attempts × (first upload + post-reauth upload) = 6 upload calls.
    expect(callsEndingWith('/v1/upload')).toBe(6);
  });

  it('does NOT node-retry a non-auth upload error', async () => {
    mock.forceError('upload', 500);

    await expect(
      uploadFiles(specFor('compress-pdf'), [URL_FILE], ENV)
    ).rejects.toThrow();

    // A 500 is not an auth error → no re-auth, no node retry: a single upload.
    expect(callsEndingWith('/v1/upload')).toBe(1);
  });
});
