/**
 * test/core/operation-executor.test.ts
 *
 * Unit tests for the headless operation executor (core/operation-executor.ts).
 * Exercised against the shared mock fetch router
 * (test/helpers/mock-ilovepdf-fetch.ts) so no network / real API keys are
 * needed.
 *
 * Coverage (ERR-3, ERR-6, ERR-7):
 * - DIRECT happy path: task_tool === op.apiTool → process once, download URL +
 *   metadata returned.
 * - CONNECTED-TASK fallback: chain-safe tool + tool mismatch → parent processed,
 *   connected task created and processed (switches to TEST_CONNECTED_TASK).
 * - RE-UPLOAD fallback: pdf-ocr (never chained) + tool mismatch → source
 *   processed, fresh task started, re-uploaded and processed.
 * - Transient 503 during /process retried ONCE after ~500ms (ERR-6).
 * - Idempotency guard (ERR-7): re-processing a task already in the request-scoped
 *   set raises TASK_ALREADY_PROCESSED (non-retryable).
 * - Generic upstream failure → UPSTREAM_ERROR (ERR-3).
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  installMockILovePDFFetch,
  TEST_CONNECTED_TASK,
  TEST_DOWNLOAD_FILENAME,
  TEST_SERVER,
  TEST_SERVER_FILENAME,
  TEST_TASK,
  TEST_TOKEN,
  type MockILovePDFHandle,
} from '../helpers/mock-ilovepdf-fetch.js';
import { execute } from '../../src/core/operation-executor.js';
import { specFor } from '../../src/domain/operations.js';
import { ToolError } from '../../src/domain/errors.js';
import type { TaskCreds } from '../../src/core/upload-service.js';

let mock: MockILovePDFHandle;

/** Build a TaskCreds with a given upload tool. */
function makeTask(taskTool: string, task = TEST_TASK): TaskCreds {
  return {
    server: TEST_SERVER,
    task,
    token: TEST_TOKEN,
    task_tool: taskTool,
    files: [{ server_filename: TEST_SERVER_FILENAME, filename: 'file.pdf' }],
  };
}

beforeEach(() => {
  mock = installMockILovePDFFetch();
  process.env.ILOVEPDF_PUBLIC_KEY = 'test-public-key';
});

afterEach(() => {
  mock.restore();
  delete process.env.ILOVEPDF_PUBLIC_KEY;
});

describe('execute — DIRECT path', () => {
  it('processes a matching task once and returns the download URL + metadata', async () => {
    const op = specFor('compress-pdf'); // apiTool 'compress'
    const task = makeTask('compress');

    const result = await execute(op, task, {});

    expect(result.download_url).toBe(
      `https://${TEST_SERVER}/v1/download/${TEST_TASK}?token=${TEST_TOKEN}`
    );
    expect(result.output_filename).toBe(TEST_DOWNLOAD_FILENAME);
    expect(result.file_count).toBe(1);
    // filesize 12345 / 1024 ≈ 12, output_filesize 6789 / 1024 ≈ 7
    expect(result.original_size_kb).toBe(12);
    expect(result.output_size_kb).toBe(7);
  });

  it('adds the processed task to the shared processedTasks set', async () => {
    const op = specFor('compress-pdf');
    const task = makeTask('compress');
    const processedTasks = new Set<string>();

    await execute(op, task, {}, { processedTasks });

    expect(processedTasks.has(TEST_TASK)).toBe(true);
  });
});

describe('execute — CONNECTED-TASK fallback', () => {
  it('processes the parent then the connected task on a chain-safe mismatch', async () => {
    const op = specFor('pdf-to-jpg'); // apiTool 'pdfjpg', chain-safe
    const task = makeTask('compress'); // mismatch → connected-task path

    const result = await execute(op, task, {});

    // download URL should point at the CONNECTED task, not the parent.
    expect(result.download_url).toBe(
      `https://${TEST_SERVER}/v1/download/${TEST_CONNECTED_TASK}?token=${TEST_TOKEN}`
    );
    expect(result.output_filename).toBe(TEST_DOWNLOAD_FILENAME);
  });
});

describe('execute — RE-UPLOAD fallback', () => {
  it('re-uploads into a fresh task for pdf-ocr on a tool mismatch', async () => {
    const op = specFor('pdf-ocr'); // apiTool 'pdfocr', never chained
    const task = makeTask('compress'); // mismatch → re-upload path

    const result = await execute(op, task, {});

    // Fresh task is started via /v1/start → TEST_TASK, so the download URL
    // targets the fresh task id.
    expect(result.download_url).toBe(
      `https://${TEST_SERVER}/v1/download/${TEST_TASK}?token=${TEST_TOKEN}`
    );
    expect(result.output_filename).toBe(TEST_DOWNLOAD_FILENAME);
  });
});

describe('execute — transient retry (ERR-6)', () => {
  it('retries a transient 503 during /process once after ~500ms', async () => {
    vi.useFakeTimers();
    try {
      const op = specFor('compress-pdf');
      const task = makeTask('compress');

      // First /process attempt fails with a transient 503.
      mock.forceError('process', 503);

      const resultPromise = execute(op, task, {});

      // Flush the first (failing) process attempt so the 500ms retry timer is
      // scheduled.
      await vi.advanceTimersByTimeAsync(0);

      // Recover the endpoint so the retry succeeds.
      delete mock.config.process;

      // Advance past the ~500ms retry delay.
      await vi.advanceTimersByTimeAsync(500);

      const result = await resultPromise;
      expect(result.download_url).toContain(`/v1/download/${TEST_TASK}`);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('execute — idempotency guard (ERR-7)', () => {
  it('throws a non-retryable TASK_ALREADY_PROCESSED when the task is in the set', async () => {
    const op = specFor('compress-pdf');
    const task = makeTask('compress');
    const processedTasks = new Set<string>([TEST_TASK]);

    await expect(execute(op, task, {}, { processedTasks })).rejects.toMatchObject(
      {
        code: 'TASK_ALREADY_PROCESSED',
        retryable: false,
      }
    );
  });

  it('the raised error is a ToolError', async () => {
    const op = specFor('compress-pdf');
    const task = makeTask('compress');
    const processedTasks = new Set<string>([TEST_TASK]);

    await expect(
      execute(op, task, {}, { processedTasks })
    ).rejects.toBeInstanceOf(ToolError);
  });
});

describe('execute — upstream failure (ERR-3)', () => {
  it('maps a generic 500 during /process to UPSTREAM_ERROR', async () => {
    const op = specFor('compress-pdf');
    const task = makeTask('compress');
    mock.forceError('process', 500);

    await expect(execute(op, task, {})).rejects.toMatchObject({
      code: 'UPSTREAM_ERROR',
    });
  });
});

describe('execute — password routing', () => {
  function getProcessBody(fetchMock: ReturnType<typeof vi.fn>): Record<string, unknown> {
    const call = fetchMock.mock.calls.find(
      ([url]: [unknown]) => String(url).includes('/v1/process')
    );
    return JSON.parse((call![1] as RequestInit).body as string) as Record<string, unknown>;
  }

  // TEMPORARILY DISABLED — unlock tool commented out; re-enable to publish.
  // it('sets password on each file object, not top-level, for unlock', async () => {
  //   const op = specFor('unlock');
  //   const task = makeTask('unlock');
  //
  //   await execute(op, task, { password: 'secret' });
  //
  //   const body = getProcessBody(mock.fetchMock);
  //   const files = body.files as Array<Record<string, unknown>>;
  //   expect(files[0].password).toBe('secret');
  //   expect(body.password).toBeUndefined();
  // });

  it('sets password on file objects for any tool (general file-level routing)', async () => {
    const op = specFor('compress-pdf');
    const task = makeTask('compress');

    await execute(op, task, { password: 'pw', compression_level: 'low' });

    const body = getProcessBody(mock.fetchMock);
    const files = body.files as Array<Record<string, unknown>>;
    expect(files[0].password).toBe('pw');
    expect(body.password).toBeUndefined();
    expect(body.compression_level).toBe('low');
  });

  it('omits password from files when not provided', async () => {
    const op = specFor('compress-pdf');
    const task = makeTask('compress');

    await execute(op, task, {});

    const body = getProcessBody(mock.fetchMock);
    const files = body.files as Array<Record<string, unknown>>;
    expect(files[0].password).toBeUndefined();
    expect(body.password).toBeUndefined();
  });
});
