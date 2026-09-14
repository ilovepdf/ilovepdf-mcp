/**
 * lib/env.ts
 *
 * Environment accessor for the headless MCP server (ENV-1..ENV-6).
 *
 * Ported from ../openai-app/mcp-server/src/lib/env.ts and adapted for the Node
 * stdio runtime: the legacy Cloudflare Workers globalThis branch and its type
 * are DROPPED — values are read from `process.env` only. The dead secret-key
 * variable is not carried over (public key only).
 *
 * `requireEnv` throws a typed ToolError('CONFIG_ERROR') that names the missing
 * variable without leaking `.env` / Cloudflare / Workers wording.
 */

import { ToolError } from '../domain/errors.js';

/** Reads a variable from process.env; returns undefined when unset or empty. */
export function getEnv(key: string): string | undefined {
  const value = process.env[key];
  return value ? value : undefined;
}

/**
 * Returns the value of a required env var, or throws ToolError('CONFIG_ERROR')
 * naming the variable. The message is safe to surface (no secret/path leaks).
 */
export function requireEnv(key: string): string {
  const value = getEnv(key);
  if (!value) {
    throw new ToolError(
      'CONFIG_ERROR',
      `Required environment variable ${key} is not set.`,
      `Configuration error: the ${key} environment variable is not set.`
    );
  }
  return value;
}

/** The single iLovePDF credential (ENV-1, ENV-4). */
export const getPublicKey = (): string | undefined => getEnv('ILOVEPDF_PUBLIC_KEY');

/** Optional file-io allowlist root; when unset the allowlist defaults to CWD (ENV-3). */
export const getWorkdir = (): string | undefined => getEnv('ILOVEPDF_MCP_WORKDIR');

/**
 * Maximum output file size (in MB) to embed as a base64 blob in the content
 * array returned to the MCP client. When 0, inline embedding is disabled
 * entirely and only a resource_link is emitted.
 *
 * Default: 10 MB. Larger values bloat the client's context window and may cause
 * performance issues. Cap conservatively; the local `output.path` is always the
 * authoritative result.
 */
export const getMaxInlineMb = (): number => {
  const raw = getEnv('ILOVEPDF_MCP_MAX_INLINE_MB');
  if (raw === undefined) return 10;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : 10;
};

/**
 * When `true`, the tool result `content` array includes an embedded `resource`
 * blob and a `resource_link` block in addition to the always-present text block.
 * Default: `false` — content is text-only, which is the maximally
 * client-compatible default (works in Claude Desktop, which rejects embedded
 * resources with non-text MIME types).
 *
 * Enable only for clients that support embedded resource blobs, such as MCP
 * Inspector. The `ILOVEPDF_MCP_MAX_INLINE_MB` size cap applies to the blob
 * when this flag is on.
 */
export const getEmbedResult = (): boolean => {
  const val = getEnv('ILOVEPDF_MCP_EMBED_RESULT');
  return val?.toLowerCase() === 'true' || val === '1';
};

/**
 * When `true`, the raw tokenized iLovePDF `download_url` (including the
 * `?token=<jwt>` credential) is returned in `structuredContent.output.download_url`.
 *
 * SECURITY TRADE-OFF: the task-scoped token grants temporary download access to
 * the produced file from any network location. Enable only when the MCP client
 * needs a directly-downloadable link AND you trust it to handle the credential
 * safely (e.g. a server-side agent that immediately fetches and discards it).
 *
 * Default: `false` (token is always stripped per DEC-4).
 * The audit-logger redacts `?token=` in all log lines regardless of this flag —
 * the flag controls only what is RETURNED to the client, never what is LOGGED.
 */
export const getReturnDownloadUrl = (): boolean => {
  const val = getEnv('ILOVEPDF_MCP_RETURN_DOWNLOAD_URL');
  return val?.toLowerCase() === 'true' || val === '1';
};
