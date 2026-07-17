/**
 * lib/file-io.ts — allowlisted local read/write + output filename derivation.
 *
 * NEW module (no source to port). Replaces the URL/attachment upload flow of
 * the widget server: an MCP tool a model can drive must not read or write
 * arbitrary paths. This is the highest-risk surface of the headless server, so
 * it is DENY-BY-DEFAULT with path canonicalization and symlink resolution
 * (design §5, spec FIO-1..FIO-8).
 *
 * Security model:
 *   1. Resolve the requested path against the workdir (relative → workdir;
 *      absolute passes through). `path.resolve` collapses `.`/`..` segments.
 *   2. Lexical containment pre-check on the resolved path — cheap deny for
 *      obvious escapes (`../` out of root, absolute-outside) with NO filesystem
 *      access, so a denied input is never opened (FIO-2/FIO-5).
 *   3. Canonicalize via `realpathSync` (reads) or the nearest existing ancestor
 *      (writes) so symlinks are followed to their real target, then re-check
 *      containment. A symlink placed inside a root that points outside resolves
 *      to an out-of-root target and is denied (FIO-4).
 *
 * Denials throw `ToolError('FILE_ACCESS_DENIED', …)` naming ONLY the allowed
 * root (never the attempted path — no info leak). Missing/unreadable inputs
 * throw `ToolError('FILE_NOT_FOUND', …)` (FIO-8). URL inputs bypass the path
 * allowlist entirely (FIO-6) — they are handed to cloud upload, not read here.
 */

import { existsSync, lstatSync, mkdirSync, realpathSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { ToolError } from '../domain/errors.js';
import type { OperationSpec } from '../domain/operation-types.js';

// ---------------------------------------------------------------------------
// Allowlist model (§5.1 / FIO-1)
// ---------------------------------------------------------------------------

export interface Allowlist {
  /** Canonical absolute roots (deduped). */
  roots: string[];
  /** roots[0]; where outputs land when output_path is omitted. */
  defaultWorkdir: string;
}

// Case-fold on Windows (NTFS) and macOS (APFS/HFS+, case-insensitive by
// default). Linux remains case-sensitive to match genuinely case-sensitive mounts.
// Case-folding is strictly tighter than the FS (can never grant an escape).
const isCaseInsensitivePlatform = process.platform === 'win32' || process.platform === 'darwin';

/** Normalize a path for containment comparison (case-insensitive on Windows and macOS). */
function normalizeForCompare(p: string): string {
  const n = path.normalize(p);
  return isCaseInsensitivePlatform ? n.toLowerCase() : n;
}

/** True when `candidate` is exactly a root or nested beneath it. */
function isWithinRoot(candidate: string, root: string): boolean {
  const c = normalizeForCompare(candidate);
  const r = normalizeForCompare(root);
  if (c === r) return true;
  const prefix = r.endsWith(path.sep) ? r : r + path.sep;
  return c.startsWith(prefix);
}

/** True when `candidate` is contained in ANY allowlisted root. */
function isContainedInAny(candidate: string, roots: string[]): boolean {
  return roots.some(root => isWithinRoot(candidate, root));
}

/** Denial error — names only the allowed root, never the attempted path. */
function accessDenied(allow: Allowlist): ToolError {
  return new ToolError(
    'FILE_ACCESS_DENIED',
    `Path is outside the allowed working directory (${allow.defaultWorkdir}).`,
    'Path is outside the allowed working directory.',
    false
  );
}

/**
 * Load the allowlist from the environment (§5.1 / FIO-1).
 *
 * - `ILOVEPDF_MCP_WORKDIR` → primary root and default output dir. Unset →
 *   `process.cwd()`. Created if missing (a workable default must exist).
 * - `ILOVEPDF_MCP_ALLOWED_DIRS` → extra roots split on `path.delimiter`. A
 *   non-existent extra dir is dropped with a stderr warning (never trusted).
 * - All roots are resolved to absolute canonical paths and deduped.
 */
export function loadAllowlist(env: NodeJS.ProcessEnv = process.env): Allowlist {
  const configured: Array<{ raw: string; isWorkdir: boolean }> = [];

  const workdir = env.ILOVEPDF_MCP_WORKDIR?.trim();
  configured.push({ raw: workdir && workdir.length > 0 ? workdir : process.cwd(), isWorkdir: true });

  const extra = env.ILOVEPDF_MCP_ALLOWED_DIRS;
  if (extra) {
    for (const dir of extra.split(path.delimiter)) {
      const trimmed = dir.trim();
      if (trimmed.length > 0) configured.push({ raw: trimmed, isWorkdir: false });
    }
  }

  const roots: string[] = [];
  for (const { raw, isWorkdir } of configured) {
    const absRoot = path.resolve(raw);
    let canonical: string;
    try {
      canonical = realpathSync(absRoot);
    } catch {
      if (isWorkdir) {
        mkdirSync(absRoot, { recursive: true });
        canonical = realpathSync(absRoot);
      } else {
        // stderr warning (stdout is reserved for MCP frames); console.error is stderr-safe.
        console.error(`[file-io] configured allowed dir does not exist, dropping: ${absRoot}`);
        continue;
      }
    }
    if (!roots.some(existing => normalizeForCompare(existing) === normalizeForCompare(canonical))) {
      roots.push(canonical);
    }
  }

  return { roots, defaultWorkdir: roots[0] };
}

// ---------------------------------------------------------------------------
// Resolution algorithm (§5.2)
// ---------------------------------------------------------------------------

/**
 * Canonicalize a write target whose file (and possibly some parent dirs) may
 * not exist yet: walk up to the nearest existing ancestor, resolve its
 * symlinks, then re-append the not-yet-existing tail. This keeps mkdir-p under
 * the root working (FIO-3) while still defeating symlinked ancestors (FIO-4).
 *
 * When the target ALREADY exists, canonicalize the FULL path (leaf included),
 * exactly like the read path. Otherwise a symlinked LEAF (e.g. `out.pdf` →
 * `../../outside/secret.pdf`) would slip through — the ancestor-walk only
 * resolves the directory portion and re-appends `basename` literally, so the
 * later containment check sees an in-root lexical path while the subsequent
 * `writeFile` (O_CREAT|O_TRUNC) follows the link and clobbers the out-of-root
 * target. `lstatSync` detects the symlink and `realpathSync` resolves it so the
 * caller's containment re-check can reject it (FIO-4, write path).
 */
function canonicalizeForWrite(abs: string): string {
  try {
    // lstat (not stat) so a symlinked leaf is seen as a link, not its target.
    lstatSync(abs);
    // The leaf exists; resolve the whole path so any symlinked leaf/ancestor is
    // followed to its real target and can be containment-checked by the caller.
    return realpathSync(abs);
  } catch {
    // Leaf does not exist yet — fall through to nearest-existing-ancestor walk.
  }

  const tail: string[] = [path.basename(abs)];
  let dir = path.dirname(abs);

  while (!existsSync(dir)) {
    const parent = path.dirname(dir);
    if (parent === dir) break; // reached filesystem root
    tail.unshift(path.basename(dir));
    dir = parent;
  }

  return path.join(realpathSync(dir), ...tail);
}

/**
 * Resolve `input` to a canonical absolute path confined to the allowlist, or
 * throw. `mode` selects the canonicalization strategy (existing file for reads,
 * nearest-existing-ancestor for writes).
 */
function resolveWithin(input: string, allow: Allowlist, mode: 'read' | 'write'): string {
  if (!input || input.includes('\0')) {
    throw accessDenied(allow);
  }

  const abs = path.resolve(allow.defaultWorkdir, input);

  // Cheap lexical deny — catches `..` escapes and absolute-outside with no fs
  // access, so a denied input is never opened.
  if (!isContainedInAny(abs, allow.roots)) {
    throw accessDenied(allow);
  }

  let real: string;
  if (mode === 'read') {
    try {
      real = realpathSync(abs);
    } catch {
      throw new ToolError(
        'FILE_NOT_FOUND',
        `Input file not found or unreadable: ${abs}`,
        'The input file was not found.',
        false
      );
    }
  } else {
    real = canonicalizeForWrite(abs);
  }

  // Symlink defense: the canonical target must still be inside a root.
  if (!isContainedInAny(real, allow.roots)) {
    throw accessDenied(allow);
  }

  return real;
}

// ---------------------------------------------------------------------------
// URL detection (§5.3 / FIO-6)
// ---------------------------------------------------------------------------

/** True for http(s) sources, which bypass the path allowlist (FIO-6). */
export function isUrl(source: string): boolean {
  return /^https?:\/\//i.test(source);
}

// ---------------------------------------------------------------------------
// Read (§5.3 / FIO-2, FIO-8)
// ---------------------------------------------------------------------------

export interface LocalFile {
  bytes: ArrayBuffer;
  filename: string;
  size: number;
  absPath: string;
}

/**
 * Read a local input file confined to the allowlist. Denials throw
 * `FILE_ACCESS_DENIED`; missing/unreadable files throw `FILE_NOT_FOUND`.
 */
export async function readInputFile(input: string, allow: Allowlist): Promise<LocalFile> {
  const absPath = resolveWithin(input, allow, 'read');

  let buffer: Buffer;
  try {
    buffer = await readFile(absPath);
  } catch {
    throw new ToolError(
      'FILE_NOT_FOUND',
      `Input file not found or unreadable: ${absPath}`,
      'The input file was not found.',
      false
    );
  }

  // Copy into a fresh ArrayBuffer (Buffer.buffer is ArrayBufferLike and may be
  // pooled/shared; a private copy gives callers a clean, owned ArrayBuffer).
  const copy = new Uint8Array(buffer.byteLength);
  copy.set(buffer);
  return { bytes: copy.buffer, filename: path.basename(absPath), size: buffer.byteLength, absPath };
}

// ---------------------------------------------------------------------------
// Output (§5.3 / FIO-3)
// ---------------------------------------------------------------------------

/**
 * Resolve the output destination, validating it against the allowlist BEFORE
 * any write occurs (FIO-3). When `output_path` is omitted the file lands in the
 * default workdir under `derivedName` (still validated).
 */
export function resolveOutputPath(
  output_path: string | undefined,
  derivedName: string,
  allow: Allowlist
): string {
  if (output_path && output_path.trim().length > 0) {
    return resolveWithin(output_path, allow, 'write');
  }
  return resolveWithin(path.join(allow.defaultWorkdir, derivedName), allow, 'write');
}

/**
 * Persist bytes to a pre-validated in-root path, creating any missing parent
 * directories (mkdir -p). Callers MUST pass a path from `resolveOutputPath`.
 */
export async function writeOutputFile(
  absPath: string,
  data: ArrayBuffer | Uint8Array
): Promise<{ path: string; bytes: number }> {
  const view = data instanceof Uint8Array ? data : new Uint8Array(data);
  try {
    await mkdir(path.dirname(absPath), { recursive: true });
    await writeFile(absPath, view);
  } catch (err) {
    throw new ToolError(
      'INTERNAL',
      `Failed to write output file ${absPath}: ${(err as Error).message}`,
      'Failed to write the output file.',
      false
    );
  }
  return { path: absPath, bytes: view.byteLength };
}

// ---------------------------------------------------------------------------
// Output filename derivation (§5.3)
// ---------------------------------------------------------------------------

/** Reduce any name to a safe basename (no separators / control / reserved chars). */
function sanitizeBasename(name: string): string {
  const base = path.basename(name.replace(/\\/g, '/'));
  const cleaned = base
    .replace(/[/\\\0<>:"|?*]/g, '_')
    .replace(/^\.+/, '')
    .trim();
  return cleaned.length > 0 ? cleaned : 'output';
}

/** Extract the filename stem from a local path or a URL. */
function stemOf(source: string): string {
  let base: string;
  if (isUrl(source)) {
    try {
      base = path.basename(new URL(source).pathname);
    } catch {
      base = 'output';
    }
  } else {
    base = path.basename(source.replace(/\\/g, '/'));
  }
  return path.parse(base).name || 'output';
}

/**
 * Choose the output filename. Prefer iLovePDF's `download_filename`; otherwise
 * build `<firstSourceStem>-<apiTool>.<ext>` where multi-file operations (split,
 * pdf-to-jpg) yield a `.zip`. Result is always a sanitized basename.
 */
export function deriveOutputFilename(
  op: OperationSpec,
  sources: string[],
  upstreamFilename: string
): string {
  if (upstreamFilename && upstreamFilename.trim().length > 0) {
    return sanitizeBasename(upstreamFilename);
  }
  const stem = stemOf(sources[0] ?? 'output');
  // Derive extension from the registry SSOT flag (producesArchive) rather than
  // a hardcoded slug set, so this module carries no knowledge of apiTool values.
  const ext = op.producesArchive ? 'zip' : 'pdf';
  return sanitizeBasename(`${stem}-${op.apiTool}.${ext}`);
}
