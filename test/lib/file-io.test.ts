/**
 * test/lib/file-io.ts — allowlist enforcement (FIO-1..FIO-6, FIO-8).
 *
 * Highest-risk unit: path traversal / exfiltration. These tests are the
 * security contract for `src/lib/file-io.ts`. They exercise the PUBLIC API
 * (readInputFile / resolveOutputPath / writeOutputFile / loadAllowlist /
 * deriveOutputFilename / isUrl) rather than the internal `resolveWithin`, so
 * the assertions match real behavior the server relies on.
 *
 * Temp dirs and a REAL symlink are created on disk so the symlink-escape
 * mitigation (FIO-4) is genuinely exercised, not mocked.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  realpathSync,
  symlinkSync,
  existsSync,
  rmSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  loadAllowlist,
  isUrl,
  readInputFile,
  resolveOutputPath,
  writeOutputFile,
  deriveOutputFilename,
  type Allowlist,
} from '../../src/lib/file-io.js';
import { ToolError, isToolError } from '../../src/domain/errors.js';
import type { OperationSpec } from '../../src/domain/operation-types.js';
import { specFor } from '../../src/domain/operations.js';

// --- helpers ---------------------------------------------------------------

/** Runs `fn` and returns the ToolError it throws (fails the test otherwise). */
function catchToolError(fn: () => unknown): ToolError {
  try {
    fn();
  } catch (err) {
    if (isToolError(err)) return err;
    throw err;
  }
  throw new Error('expected the call to throw a ToolError but it did not');
}

/** Awaits `promise`, returning the ToolError it rejects with. */
async function catchToolErrorAsync(promise: Promise<unknown>): Promise<ToolError> {
  try {
    await promise;
  } catch (err) {
    if (isToolError(err)) return err;
    throw err;
  }
  throw new Error('expected the promise to reject with a ToolError but it resolved');
}

/** Minimal OperationSpec — deriveOutputFilename only reads `apiTool`. */
const opFor = (apiTool: string): OperationSpec =>
  ({ apiTool } as unknown as OperationSpec);

// --- fixtures --------------------------------------------------------------

let work: string; // canonical allowlisted root
let outside: string; // canonical NON-allowlisted dir
let allow: Allowlist;

beforeAll(() => {
  // realpathSync so comparisons survive symlinked temp dirs (macOS /var, win 8.3).
  const base = realpathSync(mkdtempSync(path.join(tmpdir(), 'fio-')));
  work = path.join(base, 'work');
  outside = path.join(base, 'outside');
  mkdirSync(work, { recursive: true });
  mkdirSync(outside, { recursive: true });

  // A readable file inside the root.
  mkdirSync(path.join(work, 'docs'), { recursive: true });
  writeFileSync(path.join(work, 'docs', 'report.pdf'), 'PDF-INSIDE');
  mkdirSync(path.join(work, 'b'), { recursive: true });
  writeFileSync(path.join(work, 'b', 'report.pdf'), 'PDF-IN-B');

  // A secret OUTSIDE the root, reachable only via a symlink placed inside.
  writeFileSync(path.join(outside, 'secret.txt'), 'TOP-SECRET');

  allow = loadAllowlist({ ILOVEPDF_MCP_WORKDIR: work } as NodeJS.ProcessEnv);
});

afterAll(() => {
  try {
    rmSync(path.dirname(work), { recursive: true, force: true });
  } catch {
    /* best effort */
  }
});

// --- FIO-1: allowlist loading ---------------------------------------------

describe('loadAllowlist (FIO-1)', () => {
  it('defaults to the canonical process.cwd() when ILOVEPDF_MCP_WORKDIR is unset', () => {
    const a = loadAllowlist({} as NodeJS.ProcessEnv);
    expect(a.roots).toEqual([realpathSync(process.cwd())]);
    expect(a.defaultWorkdir).toBe(realpathSync(process.cwd()));
  });

  it('uses the explicit workdir as the primary root and default output dir', () => {
    const a = loadAllowlist({ ILOVEPDF_MCP_WORKDIR: work } as NodeJS.ProcessEnv);
    expect(a.roots[0]).toBe(work);
    expect(a.defaultWorkdir).toBe(work);
  });

  it('adds ILOVEPDF_MCP_ALLOWED_DIRS roots (canonicalized, split on path.delimiter)', () => {
    const a = loadAllowlist({
      ILOVEPDF_MCP_WORKDIR: work,
      ILOVEPDF_MCP_ALLOWED_DIRS: outside,
    } as NodeJS.ProcessEnv);
    expect(a.roots).toContain(work);
    expect(a.roots).toContain(outside);
  });

  it('drops a non-existent extra allowed dir instead of trusting it', () => {
    const ghost = path.join(work, 'does-not-exist-ever');
    const a = loadAllowlist({
      ILOVEPDF_MCP_WORKDIR: work,
      ILOVEPDF_MCP_ALLOWED_DIRS: ghost,
    } as NodeJS.ProcessEnv);
    expect(a.roots).not.toContain(ghost);
    expect(a.roots).toEqual([work]);
  });
});

// --- FIO-2: input canonicalization + containment ---------------------------

describe('readInputFile containment (FIO-2)', () => {
  it('reads a file inside an allowlisted root', async () => {
    const file = await readInputFile(path.join(work, 'docs', 'report.pdf'), allow);
    expect(file.filename).toBe('report.pdf');
    expect(file.size).toBe(Buffer.byteLength('PDF-INSIDE'));
    expect(Buffer.from(file.bytes).toString()).toBe('PDF-INSIDE');
    expect(file.absPath).toBe(path.join(work, 'docs', 'report.pdf'));
  });

  it('denies an absolute path outside the allowlist with FILE_ACCESS_DENIED', async () => {
    const err = await catchToolErrorAsync(
      readInputFile(path.join(outside, 'secret.txt'), allow)
    );
    expect(err.code).toBe('FILE_ACCESS_DENIED');
  });

  it('never leaks the attempted absolute path — names only the allowed root', async () => {
    const attempt = path.join(outside, 'secret.txt');
    const err = await catchToolErrorAsync(readInputFile(attempt, allow));
    expect(err.userMessage).not.toContain(attempt);
    expect(err.userMessage).not.toContain(outside);
  });
});

// --- FIO-5: traversal ------------------------------------------------------

describe('traversal handling (FIO-5)', () => {
  it('denies `..` that escapes the root', async () => {
    const escape = path.join(work, '..', 'outside', 'secret.txt');
    const err = await catchToolErrorAsync(readInputFile(escape, allow));
    expect(err.code).toBe('FILE_ACCESS_DENIED');
  });

  it('allows contained traversal (a/../b stays inside the root)', async () => {
    const contained = path.join(work, 'a', '..', 'b', 'report.pdf');
    const file = await readInputFile(contained, allow);
    expect(Buffer.from(file.bytes).toString()).toBe('PDF-IN-B');
  });
});

// --- FIO-4: symlink escape (real symlink on disk) --------------------------

describe('symlink escape (FIO-4)', () => {
  let symlinkOk = true;

  beforeAll(() => {
    try {
      // 'junction' works on Windows without elevation for directory links.
      symlinkSync(outside, path.join(work, 'escape'), 'junction');
    } catch {
      symlinkOk = false;
    }
  });

  it('denies a symlink inside the root that points outside', async () => {
    if (!symlinkOk) {
      // Environment cannot create symlinks; skip rather than false-pass.
      return;
    }
    const viaLink = path.join(work, 'escape', 'secret.txt');
    // Sanity: the link really does reach the outside secret.
    expect(existsSync(viaLink)).toBe(true);

    const err = await catchToolErrorAsync(readInputFile(viaLink, allow));
    expect(err.code).toBe('FILE_ACCESS_DENIED');
  });
});

// --- FIO-4 (write path): symlinked write-target LEAF escape ----------------

describe('symlinked write-target leaf escape (FIO-4 write-path regression)', () => {
  let linkPath: string;
  let linkKind: 'file' | 'junction' | 'none' = 'none';
  let secretTarget: string; // outside/secret.txt, holds 'TOP-SECRET' (set in beforeAll)

  beforeAll(() => {
    secretTarget = path.join(outside, 'secret.txt');
    // Preferred exploit shape: a FILE symlink whose leaf points at the
    // out-of-root secret. writeFile opens with O_CREAT|O_TRUNC and FOLLOWS the
    // symlink, so an unhardened write path would truncate/overwrite it.
    const fileLink = path.join(work, 'leak.pdf');
    try {
      symlinkSync(secretTarget, fileLink, 'file');
      linkPath = fileLink;
      linkKind = 'file';
      return;
    } catch {
      /* file symlinks need elevation on Windows (EPERM); fall back below. */
    }
    // Fallback used when file symlinks are unprivileged: a directory JUNCTION
    // leaf (no elevation needed) pointing out of root. lstat still reports it as
    // a symbolic link, so it exercises the same leaf-canonicalization defense.
    const juncLink = path.join(work, 'leakdir');
    try {
      symlinkSync(outside, juncLink, 'junction');
      linkPath = juncLink;
      linkKind = 'junction';
    } catch {
      linkKind = 'none';
    }
  });

  it('denies a write whose leaf symlink resolves outside the root, leaving the target intact', () => {
    if (linkKind === 'none') {
      // Environment cannot create symlinks/junctions; skip rather than false-pass.
      return;
    }
    const before = readFileSync(secretTarget, 'utf8');

    // (a) Resolution must reject BEFORE any write happens (FIO-3 + FIO-4).
    const err = catchToolError(() => resolveOutputPath(linkPath, 'x.pdf', allow));
    expect(err.code).toBe('FILE_ACCESS_DENIED');
    // No path leak: the denial names only the allowed root.
    expect(err.userMessage).not.toContain(outside);

    // (b) The out-of-root target is byte-for-byte unchanged (no truncate/overwrite).
    expect(readFileSync(secretTarget, 'utf8')).toBe(before);
    expect(readFileSync(secretTarget, 'utf8')).toBe('TOP-SECRET');
  });
});

// --- FIO-6: URL bypass -----------------------------------------------------

describe('isUrl / URL bypass (FIO-6)', () => {
  it('recognizes http(s) URLs', () => {
    expect(isUrl('https://example.com/a.pdf')).toBe(true);
    expect(isUrl('http://example.com/a.pdf')).toBe(true);
    expect(isUrl('HTTPS://EXAMPLE.com/a.pdf')).toBe(true);
  });

  it('does not treat local paths or other schemes as URLs', () => {
    expect(isUrl('/work/report.pdf')).toBe(false);
    expect(isUrl('C:\\work\\report.pdf')).toBe(false);
    expect(isUrl('report.pdf')).toBe(false);
    expect(isUrl('ftp://example.com/a.pdf')).toBe(false);
  });
});

// --- FIO-3: output containment (no write on denial) ------------------------

describe('resolveOutputPath / writeOutputFile (FIO-3)', () => {
  it('denies an output path outside the allowlist and writes NOTHING', () => {
    const evil = path.join(outside, 'evil.pdf');
    const err = catchToolError(() => resolveOutputPath(evil, 'x.pdf', allow));
    expect(err.code).toBe('FILE_ACCESS_DENIED');
    expect(existsSync(evil)).toBe(false);
  });

  it('defaults to the workdir when output_path is omitted (still validated)', () => {
    const resolved = resolveOutputPath(undefined, 'result.pdf', allow);
    expect(resolved).toBe(path.join(work, 'result.pdf'));
  });

  it('handles a nonexistent-but-in-root parent by creating dirs under the root', async () => {
    const dest = resolveOutputPath(
      path.join(work, 'out', 'new', 'file.pdf'),
      'file.pdf',
      allow
    );
    const res = await writeOutputFile(dest, new TextEncoder().encode('OUT'));
    expect(res.path).toBe(dest);
    expect(res.bytes).toBe(3);
    expect(existsSync(dest)).toBe(true);
  });
});

// --- FIO-8: missing / unreadable inputs ------------------------------------

describe('missing inputs (FIO-8)', () => {
  it('fails a nonexistent in-root input with FILE_NOT_FOUND (no crash)', async () => {
    const err = await catchToolErrorAsync(
      readInputFile(path.join(work, 'missing.pdf'), allow)
    );
    expect(err.code).toBe('FILE_NOT_FOUND');
  });
});

// --- Windows case-insensitive containment ----------------------------------

describe('Windows case-insensitive containment', () => {
  it.runIf(process.platform === 'win32')(
    'allows an in-root path whose root portion differs only in case',
    async () => {
      // Flip the case of the root prefix; on Windows this is the SAME location.
      const flipped = work.toUpperCase() + path.sep + path.join('docs', 'report.pdf');
      const file = await readInputFile(flipped, allow);
      expect(Buffer.from(file.bytes).toString()).toBe('PDF-INSIDE');
    }
  );
});

// --- macOS case-insensitive containment ------------------------------------
// macOS APFS/HFS+ is case-insensitive by default. realpathSync does NOT
// canonicalize case on macOS, so a legitimate in-root path whose ROOT portion
// differs only in case would be wrongly denied without explicit case-folding.
// This test mirrors the win32 case and documents the platform-coverage intent.

describe('macOS case-insensitive containment', () => {
  it.runIf(process.platform === 'darwin')(
    'allows an in-root path whose root portion differs only in case',
    async () => {
      // Flip the case of the root prefix; on macOS this is the SAME location.
      const flipped = work.toUpperCase() + path.sep + path.join('docs', 'report.pdf');
      const file = await readInputFile(flipped, allow);
      expect(Buffer.from(file.bytes).toString()).toBe('PDF-INSIDE');
    }
  );
});

// --- deriveOutputFilename --------------------------------------------------

describe('deriveOutputFilename', () => {
  it('prefers the upstream download_filename (sanitized to a basename)', () => {
    expect(deriveOutputFilename(opFor('compress'), ['/work/a.pdf'], 'result.pdf')).toBe(
      'result.pdf'
    );
    // Strips any directory component in the upstream name.
    expect(
      deriveOutputFilename(opFor('compress'), ['/work/a.pdf'], '../../evil.pdf')
    ).toBe('evil.pdf');
  });

  it('falls back to <stem>-<apiTool>.<ext> when no upstream name', () => {
    expect(deriveOutputFilename(opFor('compress'), ['/work/report.pdf'], '')).toBe(
      'report-compress.pdf'
    );
  });

  it('uses .zip for multi-file operations (split-pdf, pdf-to-jpg)', () => {
    // Use the real registry specs so the producesArchive SSOT flag drives the
    // extension — no apiTool slug literals hardcoded in this test.
    expect(deriveOutputFilename(specFor('split-pdf'), ['/work/doc.pdf'], '')).toBe(
      'doc-split.zip'
    );
    expect(deriveOutputFilename(specFor('pdf-to-jpg'), ['/work/doc.pdf'], '')).toBe(
      'doc-pdfjpg.zip'
    );
  });

  it('derives the stem from a URL source when the input is a URL', () => {
    expect(
      deriveOutputFilename(opFor('compress'), ['https://x.com/files/big.pdf'], '')
    ).toBe('big-compress.pdf');
  });

  // Data-safety: collision-avoidance (default output must never equal input).
  it('falls back to <stem>-<apiTool>.<ext> when upstream name matches any source basename', () => {
    // The upstream name "doc.pdf" is the same as source basename "doc.pdf".
    // Derivation must fall back to "doc-compress.pdf" to prevent overwriting the input.
    expect(
      deriveOutputFilename(opFor('compress'), ['/work/doc.pdf'], 'doc.pdf')
    ).toBe('doc-compress.pdf');
  });

  it('does NOT fall back when upstream name differs from all source basenames', () => {
    // "result.pdf" != "doc.pdf" → upstream name is used as-is.
    expect(
      deriveOutputFilename(opFor('compress'), ['/work/doc.pdf'], 'result.pdf')
    ).toBe('result.pdf');
  });

  it('collision detection is case-insensitive on all platforms (safety-first)', () => {
    // Source is "Doc.pdf", upstream is "doc.pdf" (different case).
    // On case-insensitive filesystems (Windows/macOS) these are the same file;
    // the fallback fires to be safe.
    const result = deriveOutputFilename(opFor('compress'), ['/work/Doc.pdf'], 'doc.pdf');
    // The fallback uses the stem from the source ("Doc" → "Doc-compress.pdf").
    expect(result).toBe('Doc-compress.pdf');
  });
});
