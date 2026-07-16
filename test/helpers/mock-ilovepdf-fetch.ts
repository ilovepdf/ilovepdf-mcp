/**
 * Mock iLovePDF fetch router — test/helpers/mock-ilovepdf-fetch.ts
 *
 * A credential-agnostic `fetch` stub for the iLovePDF v1 REST API. It routes
 * requests by URL path to canned, spec-accurate responses so unit tests for
 * auth-utils, ilovepdf-api, upload-service and the operation-executor can run
 * without touching the network or needing real API keys.
 *
 * Design decisions:
 * - This is a TEST HELPER, not production code and not a test suite. It exports
 *   an installer that calls `vi.stubGlobal('fetch', …)` and returns a handle
 *   used to inspect calls and to force error statuses (401 / 403 / 5xx) per
 *   endpoint.
 * - Responses are real `Response` objects (`new Response(...)`) so `.ok`,
 *   `.status`, `.json()`, `.text()` and `.arrayBuffer()` behave like the
 *   platform fetch. The download endpoint returns binary backed by a small
 *   `Uint8Array`.
 * - Field names match the real iLovePDF v1 API EXACTLY (confirmed against the
 *   reference client in ../openai-app/mcp-server/src/lib/ilovepdf-api.ts and
 *   src/types.ts): auth → { token }, start → { server, task },
 *   upload → { server_filename, filename },
 *   process → { download_filename, filesize, output_filesize, timer }.
 * - Endpoints handled (host-agnostic; matched on path only):
 *     POST /v1/auth
 *     GET  /v1/start/:tool
 *     POST /v1/upload
 *     POST /v1/process
 *     GET  /v1/download/:task
 *     POST /v1/task/next   (connected/chained task — createConnectedTask)
 */

import { vi } from 'vitest';

// ---------------------------------------------------------------------------
// Canned default values (exported so tests can assert against them)
// ---------------------------------------------------------------------------

/** JWT returned by the mocked /v1/auth endpoint. */
export const TEST_TOKEN = 'test.jwt.token';

/** Processing server returned by /v1/start/:tool and used for later calls. */
export const TEST_SERVER = 'api1g.ilovepdf.com';

/** Task id returned by /v1/start/:tool. */
export const TEST_TASK = 'test-task-id';

/**
 * Task id returned by /v1/task/next (the chained/connected task). Distinct from
 * {@link TEST_TASK} so connected-task tests can assert the executor switched to
 * the new task id.
 */
export const TEST_CONNECTED_TASK = 'test-connected-task-id';

/** Server-side filename returned by /v1/upload. */
export const TEST_SERVER_FILENAME = 'test-server-filename.pdf';

/** Original filename echoed back by /v1/upload. */
export const TEST_FILENAME = 'file.pdf';

/** Output filename returned by /v1/process. */
export const TEST_DOWNLOAD_FILENAME = 'output.pdf';

/** Small binary payload returned by /v1/download/:task. */
export const TEST_DOWNLOAD_BYTES = new Uint8Array([
  0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x34, // "%PDF-1.4"
]);

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** One of the routable iLovePDF endpoints. */
export type MockEndpoint =
  | 'auth'
  | 'start'
  | 'upload'
  | 'process'
  | 'download'
  | 'taskNext';

/**
 * Per-endpoint override. Set `status` to force an error (401 / 403 / 5xx);
 * optionally supply a `body` to replace the default JSON payload. When only a
 * non-2xx `status` is given, an iLovePDF-shaped error body is generated so the
 * client's error-extraction logic has something to parse.
 *
 * Set `headers` to include additional response headers (e.g. `location` for
 * 3xx redirect responses). When `headers` is non-empty the response is built
 * from scratch using the given status + headers (body defaults to null).
 */
export interface EndpointOverride {
  /** HTTP status to respond with. Defaults to 200. */
  status?: number;
  /**
   * Response body override. Objects are JSON-serialised; a `Uint8Array` is
   * returned as raw binary (useful for the download endpoint).
   */
  body?: unknown;
  /**
   * Additional response headers. When set the response is constructed with
   * these headers (useful for `Location` on redirect responses).
   */
  headers?: Record<string, string>;
}

/** Mutable configuration: reassign entries to change behaviour mid-test. */
export type MockILovePDFConfig = Partial<Record<MockEndpoint, EndpointOverride>>;

/** Handle returned by {@link installMockILovePDFFetch}. */
export interface MockILovePDFHandle {
  /** The `vi.fn()` used as the global `fetch`; inspect `.mock.calls` etc. */
  readonly fetchMock: ReturnType<typeof vi.fn>;
  /** Mutable overrides. Mutate to change canned responses / force errors. */
  readonly config: MockILovePDFConfig;
  /** Force an error status on a single endpoint (e.g. 401, 403, 500). */
  forceError(endpoint: MockEndpoint, status: number, body?: unknown): void;
  /** Clear all overrides so every endpoint returns its default response. */
  reset(): void;
  /** Restore the original global `fetch` (calls `vi.unstubAllGlobals`). */
  restore(): void;
}

// ---------------------------------------------------------------------------
// Default response builders
// ---------------------------------------------------------------------------

const JSON_HEADERS = { 'Content-Type': 'application/json' } as const;

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: JSON_HEADERS });
}

function binaryResponse(bytes: Uint8Array, status = 200): Response {
  // Copy into a fresh ArrayBuffer-backed view so the Response body is a clean
  // BodyInit and every consumer gets its own readable stream.
  return new Response(bytes.slice(), {
    status,
    headers: { 'Content-Type': 'application/octet-stream' },
  });
}

/** iLovePDF-style error envelope, so client error extraction has a message. */
function defaultErrorBody(status: number): unknown {
  return {
    error: {
      type: status === 401 || status === 403 ? 'Unauthorized' : 'ServerError',
      message: `Mocked iLovePDF error (status ${status})`,
      code: status,
    },
  };
}

type EndpointResponder = () => Response;

const DEFAULT_RESPONDERS: Record<MockEndpoint, EndpointResponder> = {
  auth: () => jsonResponse({ token: TEST_TOKEN }),
  start: () => jsonResponse({ server: TEST_SERVER, task: TEST_TASK }),
  upload: () =>
    jsonResponse({
      server_filename: TEST_SERVER_FILENAME,
      filename: TEST_FILENAME,
    }),
  process: () =>
    jsonResponse({
      download_filename: TEST_DOWNLOAD_FILENAME,
      filesize: 12345,
      output_filesize: 6789,
      timer: '0.42',
    }),
  download: () => binaryResponse(TEST_DOWNLOAD_BYTES),
  taskNext: () =>
    jsonResponse({ server: TEST_SERVER, task: TEST_CONNECTED_TASK }),
};

// ---------------------------------------------------------------------------
// Routing
// ---------------------------------------------------------------------------

/** Resolve the request URL string from the fetch `input` argument. */
function urlOf(input: RequestInfo | URL): string {
  if (typeof input === 'string') return input;
  if (input instanceof URL) return input.toString();
  return input.url;
}

/** Map a request path to its endpoint key, or `null` if unrecognised. */
function endpointForPath(path: string): MockEndpoint | null {
  if (path.endsWith('/v1/auth')) return 'auth';
  if (path.includes('/v1/start/')) return 'start';
  if (path.endsWith('/v1/task/next')) return 'taskNext';
  if (path.endsWith('/v1/upload')) return 'upload';
  if (path.endsWith('/v1/process')) return 'process';
  if (path.includes('/v1/download/')) return 'download';
  return null;
}

function buildResponse(
  endpoint: MockEndpoint,
  override: EndpointOverride | undefined
): Response {
  if (!override) return DEFAULT_RESPONDERS[endpoint]();

  const status = override.status ?? 200;
  const hasError = status < 200 || status >= 300;

  // When custom headers are provided (e.g. Location for redirect tests) build
  // the response from scratch so the headers are included verbatim.
  if (override.headers && Object.keys(override.headers).length > 0) {
    let body: BodyInit | null = null;
    if (override.body instanceof Uint8Array) {
      body = override.body;
    } else if (override.body !== undefined) {
      body = JSON.stringify(override.body);
    }
    return new Response(body, { status, headers: override.headers });
  }

  if (override.body !== undefined) {
    if (override.body instanceof Uint8Array) {
      return binaryResponse(override.body, status);
    }
    return jsonResponse(override.body, status);
  }

  if (hasError) return jsonResponse(defaultErrorBody(status), status);

  // Success status with no body override → use the canned default payload.
  return DEFAULT_RESPONDERS[endpoint]();
}

// ---------------------------------------------------------------------------
// Installer
// ---------------------------------------------------------------------------

/**
 * Install the mock router as the global `fetch` and return a handle for
 * inspection and error injection.
 *
 * @param initialConfig Optional starting overrides.
 *
 * @example
 *   const mock = installMockILovePDFFetch();
 *   // ...exercise code under test...
 *   mock.forceError('auth', 401);
 *   mock.restore();
 */
export function installMockILovePDFFetch(
  initialConfig: MockILovePDFConfig = {}
): MockILovePDFHandle {
  const config: MockILovePDFConfig = { ...initialConfig };

  const fetchMock = vi.fn(
    async (input: RequestInfo | URL, _init?: RequestInit): Promise<Response> => {
      const path = urlOf(input);
      const endpoint = endpointForPath(path);

      if (!endpoint) {
        return jsonResponse(
          { error: { message: `Unmocked iLovePDF endpoint: ${path}` } },
          404
        );
      }

      return buildResponse(endpoint, config[endpoint]);
    }
  );

  vi.stubGlobal('fetch', fetchMock);

  return {
    fetchMock,
    config,
    forceError(endpoint, status, body) {
      config[endpoint] = { status, body };
    },
    reset() {
      for (const key of Object.keys(config) as MockEndpoint[]) {
        delete config[key];
      }
      fetchMock.mockClear();
    },
    restore() {
      vi.unstubAllGlobals();
    },
  };
}
