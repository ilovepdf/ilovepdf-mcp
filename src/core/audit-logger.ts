/**
 * Audit Logger — core/audit-logger.ts
 *
 * Structured, token-redacted logging for MCP tool handlers.
 * Ported from services/audit-logger.ts (openai-app widget server).
 *
 * Design decisions:
 * - AD-8 (§7.2) — redact `token` / `?token=` / `download_url` / Bearer JWT
 *   before any log line is emitted so credentials and pre-signed URLs never
 *   appear in plaintext in server logs.
 * - LOG-3 — on the stdio transport, stdout is RESERVED for MCP protocol
 *   frames. This logger MUST emit via `console.error` (stderr) ONLY and MUST
 *   NEVER call `console.log`. The `log` facade below is the single stderr
 *   channel other modules import instead of touching `console` directly.
 */

// ---------------------------------------------------------------------------
// Token / URL redaction patterns
// ---------------------------------------------------------------------------

/** Matches `?token=<value>` or `&token=<value>` (query-string token params). */
const TOKEN_QUERY_RE = /([?&]token=)[^&\s#"']*/gi;

/**
 * Matches a JSON-style `"download_url":"<value>"` pair produced by
 * JSON.stringify so we can redact the URL value inside serialised objects.
 */
const DOWNLOAD_URL_JSON_RE = /("download_url"\s*:\s*)"[^"]*"/gi;

/**
 * Matches a Bearer JWT in an Authorization header value.
 * A JWT has three base64url segments separated by dots.
 */
const BEARER_JWT_RE =
  /Bearer\s+[A-Za-z0-9\-_]+\.[A-Za-z0-9\-_]+\.[A-Za-z0-9\-_]*/gi;

// ---------------------------------------------------------------------------
// Public: safeStringify
// ---------------------------------------------------------------------------

/**
 * JSON.stringify with a try/catch fallback.
 */
export function safeStringify(value: unknown): string {
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return '[unserializable]';
  }
}

// ---------------------------------------------------------------------------
// Public: redact (string-level)
// ---------------------------------------------------------------------------

/**
 * Redact sensitive values from a plain string:
 * - `?token=<value>` / `&token=<value>` query params → `?token=[REDACTED]`
 * - `"download_url": "<value>"` JSON pairs → `"download_url": "[REDACTED_URL]"`
 * - Bearer JWT tokens → `Bearer [REDACTED_JWT]`
 */
export function redact(input: string): string {
  return input
    .replace(TOKEN_QUERY_RE, '$1[REDACTED]')
    .replace(DOWNLOAD_URL_JSON_RE, '$1"[REDACTED_URL]"')
    .replace(BEARER_JWT_RE, 'Bearer [REDACTED_JWT]');
}

// ---------------------------------------------------------------------------
// Internal helpers for deep-clone + redaction
// ---------------------------------------------------------------------------

/** Returns true when a string looks like it contains a query-string token param. */
function containsTokenParam(s: string): boolean {
  return /[?&]token=/i.test(s);
}

/** Returns true when a string looks like a pre-signed download URL. */
function containsDownloadUrl(s: string): boolean {
  // Heuristic: the string itself IS a URL-like value that likely came from a
  // download_url field (checked by key name in the parent object), OR it
  // contains an inline download_url pattern.
  return /download_url/i.test(s) || /\/v1\/download\//i.test(s);
}

/**
 * Deep-clone `value` while:
 * - Setting any object key named `token` (case-insensitive) to `[REDACTED]`.
 * - Replacing any string value that contains `token=` or a download-URL
 *   pattern with a redacted placeholder.
 * - Replacing any string value assigned to a `download_url` key with
 *   `[REDACTED_URL]`.
 *
 * Arrays and plain objects are recursed; all other primitives are returned
 * as-is (or redacted if they are strings matching the above rules).
 */
export function redactObject(value: unknown): unknown {
  return redactValue(value, null);
}

function redactValue(value: unknown, parentKey: string | null): unknown {
  if (value === null || value === undefined) {
    return value;
  }

  if (typeof value === 'string') {
    // If the parent key signals a download URL field, always redact.
    if (parentKey !== null && /download_url/i.test(parentKey)) {
      return '[REDACTED_URL]';
    }
    // If the parent key signals a token field, redact completely.
    if (parentKey !== null && /^token$/i.test(parentKey)) {
      return '[REDACTED]';
    }
    // Redact inline token query params or download URL patterns embedded in
    // a string that came from some other key (e.g. a message string).
    if (containsTokenParam(value) || containsDownloadUrl(value)) {
      return redact(value);
    }
    return value;
  }

  if (Array.isArray(value)) {
    return value.map(item => redactValue(item, null));
  }

  if (typeof value === 'object') {
    const result: Record<string, unknown> = {};
    for (const [key, val] of Object.entries(value as Record<string, unknown>)) {
      // Key-level check: blank token fields regardless of their value type.
      if (/^token$/i.test(key)) {
        result[key] = '[REDACTED]';
      } else if (/download_url/i.test(key)) {
        // download_url keys always redact the value.
        result[key] = '[REDACTED_URL]';
      } else {
        result[key] = redactValue(val, key);
      }
    }
    return result;
  }

  // number, boolean, bigint, symbol — pass through as-is.
  return value;
}

// ---------------------------------------------------------------------------
// Public: stderr log facade (LOG-3)
// ---------------------------------------------------------------------------

/**
 * Emit a single redacted line to stderr.
 *
 * `console.error` writes to stderr, keeping stdout clean for MCP protocol
 * frames on the stdio transport. Every argument is redacted before emission:
 * strings via `redact`, everything else via `redactObject`.
 */
function emit(args: unknown[]): void {
  const redacted = args.map(arg =>
    typeof arg === 'string' ? redact(arg) : redactObject(arg)
  );
  // LOG-3: console.error (stderr) is the ONLY safe channel; stdout is reserved
  // for MCP protocol frames. The lint config permits console.error/warn.
  console.error(...redacted);
}

/**
 * Structured stderr logging facade. All levels route to `console.error` so no
 * log line can ever contaminate stdout (reserved for MCP protocol frames).
 * Other modules import this instead of touching `console` directly.
 */
export const log = {
  info(...args: unknown[]): void {
    emit(args);
  },
  warn(...args: unknown[]): void {
    emit(args);
  },
  error(...args: unknown[]): void {
    emit(args);
  },
};

// ---------------------------------------------------------------------------
// Public: auditLogger factory
// ---------------------------------------------------------------------------

export interface AuditEvent {
  /** Log a structured, redacted audit event. */
  event(name: string, fields: Record<string, unknown>): void;
}

/**
 * Create an audit logger scoped to a specific MCP tool.
 *
 * Usage:
 * ```ts
 * const audit = auditLogger('ilovepdf');
 * audit.event('handler.entry', { source: 'url', operation: 'compress-pdf', duration_ms: 42 });
 * ```
 *
 * Standard fields callers are expected to pass (all optional):
 * - `source`       — upload source: 'url' | 'attachment' | 'direct-upload' | ...
 * - `operation`    — operation name: 'compress-pdf' | 'pdf-ocr' | ...
 * - `branch`       — handler branch taken (for diagnostic tracing)
 * - `error_code`   — ErrorCode string when logging an error path
 * - `duration_ms`  — elapsed milliseconds for the operation
 */
export function auditLogger(tool: string): AuditEvent {
  return {
    event(name: string, fields: Record<string, unknown>): void {
      const payload = {
        ...(redactObject(fields) as Record<string, unknown>),
        tool,
        ts: Date.now(),
      };
      // Route through the stderr facade (LOG-3) — never console.log.
      log.info(`[${tool}] ${name}`, safeStringify(payload));
    },
  };
}
