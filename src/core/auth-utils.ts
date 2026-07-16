/**
 * core/auth-utils.ts
 *
 * Shared error-classification helpers for the retry logic in upload-service and
 * operation-executor.
 *
 * Ported as-is from ../openai-app/mcp-server/src/services/auth-utils.ts
 * (ERR-4, ERR-5, ERR-6). Originally extracted from upload-service.ts and
 * operation-executor.ts, which carried identical predicates.
 */

/**
 * Returns true when an unknown error looks like a 401/403 from iLovePDF.
 * Matches HTTP status codes in message strings and common auth-failure phrases.
 */
export function isAuthError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  return (
    msg.includes('401') ||
    msg.includes('403') ||
    msg.includes('Unauthorized') ||
    msg.includes('Signature verification')
  );
}

/**
 * Returns true when an error looks like a transient server-side failure
 * (502 Bad Gateway, 503 Service Unavailable, 504 Gateway Timeout).
 * These are safe to retry once with a short delay.
 */
export function isTransientError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  return (
    msg.includes('502') ||
    msg.includes('503') ||
    msg.includes('504') ||
    msg.includes('Bad Gateway') ||
    msg.includes('Service Unavailable') ||
    msg.includes('Gateway Timeout')
  );
}
