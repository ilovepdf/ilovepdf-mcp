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
