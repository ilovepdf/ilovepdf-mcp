/**
 * test/index.test.ts
 *
 * T053: Bootstrap guard for src/index.ts (LOG-1, LOG-3, LOG-6).
 *
 * Asserts the bin entry point's structure via source-text analysis only.
 * We NEVER import or execute src/index.ts in this test — doing so would:
 *  - Connect a StdioServerTransport and corrupt the test runner's stdio.
 *  - Register persistent SIGINT/SIGTERM handlers that outlive the test.
 *  - Start an event loop that never exits.
 *
 * Assertions (all source-scan, no spawn):
 *  1. Shebang: `#!/usr/bin/env node` is the very first line (design §2.1).
 *  2. Ordering: `lockdownStdout()` call precedes `buildServer()` and
 *     `server.connect` in the source (design §2.3 — belt-and-suspenders
 *     must fire BEFORE the transport starts and BEFORE the server is built).
 *  3. Signal handlers: `process.on('SIGINT')` and `process.on('SIGTERM')` are
 *     both present (design §2.1 graceful shutdown).
 *  4. Transport isolation (positive): `src/index.ts` DOES import `server/stdio`.
 *  5. Transport isolation (guard): `src/index.ts` is the ONLY file under `src/`
 *     that imports `server/stdio` — this extends server-isolation.test.ts which
 *     covers server/core/domain/contract/lib but not src/tools/ or src/ root.
 *
 * Spawn-based stdio smoke test (initialize handshake → tools/list) is deferred
 * to the verify phase (R6 in tasks.md): it requires a compiled `dist/` and a
 * deterministic stdin/stdout handshake that is not reliable under vitest's
 * in-process runner. The live handshake is explicitly out of scope here.
 *
 * RED state: beforeAll fails (all tests in scope fail) when src/index.ts does
 * not exist. This is the expected state before T054 is implemented.
 */

import { beforeAll, describe, expect, it } from 'vitest';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join, relative } from 'node:path';

// ---------------------------------------------------------------------------
// Helpers (self-contained; mirrors server-isolation.test.ts pattern)
// ---------------------------------------------------------------------------

/** Strip block and line comments so patterns only match live code. */
function stripComments(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, '') // block comments (including JSDoc)
    .replace(/\/\/[^\n]*/g, ''); // line comments
}

/** Recursively collect absolute paths of .ts files under `dir`. */
function collectTsFiles(dir: string): string[] {
  const results: string[] = [];
  if (!existsSync(dir)) return results;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const abs = join(dir, entry.name);
    if (entry.isDirectory()) {
      results.push(...collectTsFiles(abs));
    } else if (entry.name.endsWith('.ts')) {
      results.push(abs);
    }
  }
  return results;
}

// ---------------------------------------------------------------------------
// File under test — populated in beforeAll
// ---------------------------------------------------------------------------

/** Repo root (process.cwd() = the project directory vitest runs from). */
const ROOT = process.cwd();
const INDEX_PATH = join(ROOT, 'src', 'index.ts');

// Set in beforeAll; empty string signals RED state if somehow accessed before.
let indexSrc = '';
let indexStripped = '';

// RED before T054: this guard makes every test in the file fail with a clear
// message when src/index.ts has not yet been created.
beforeAll(() => {
  expect(
    existsSync(INDEX_PATH),
    'src/index.ts does not exist — T054 must be implemented before this suite turns GREEN'
  ).toBe(true);

  indexSrc = readFileSync(INDEX_PATH, 'utf8');
  indexStripped = stripComments(indexSrc);
});

// ---------------------------------------------------------------------------
// 1. Shebang (design §2.1)
// ---------------------------------------------------------------------------

describe('src/index.ts — shebang', () => {
  it('the very first characters are #!/usr/bin/env node', () => {
    // The shebang must be the absolute first bytes in the file so the OS
    // interpreter directive works for the compiled dist/index.js bin entry.
    // tsc preserves a leading shebang; npm makes the file executable on install.
    expect(indexSrc.startsWith('#!/usr/bin/env node')).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 2. lockdownStdout() ordering (LOG-3, design §2.3)
// ---------------------------------------------------------------------------

describe('src/index.ts — stdout lockdown ordering (LOG-3)', () => {
  it('lockdownStdout() is called (present in live code)', () => {
    // Regex matches the call form: lockdownStdout() with optional whitespace.
    // Using the stripped source ensures JSDoc/comments don't produce false positives.
    expect(indexStripped).toMatch(/lockdownStdout\s*\(\s*\)/);
  });

  it('lockdownStdout() call precedes buildServer() call', () => {
    // stdout must be locked before any code that could produce log output via
    // console.log — buildServer() calls registerAllTools() which may log
    // (via transitive imports). Ordering is checked by character offset in the
    // stripped source so neither position can come from a comment.
    const lockdownPos = indexStripped.search(/lockdownStdout\s*\(\s*\)/);
    const buildPos = indexStripped.search(/buildServer\s*\(\s*\)/);

    expect(lockdownPos, 'lockdownStdout() call not found in src/index.ts').toBeGreaterThan(-1);
    expect(buildPos, 'buildServer() call not found in src/index.ts').toBeGreaterThan(-1);
    expect(
      lockdownPos,
      'lockdownStdout() must appear before buildServer() in src/index.ts'
    ).toBeLessThan(buildPos);
  });

  it('lockdownStdout() call precedes server.connect() call', () => {
    // stdout must be locked before the transport binds to process.stdout;
    // otherwise, the very first MCP frame emission could race with a stray log.
    const lockdownPos = indexStripped.search(/lockdownStdout\s*\(\s*\)/);
    const connectPos = indexStripped.search(/server\.connect\s*\(/);

    expect(lockdownPos, 'lockdownStdout() call not found in src/index.ts').toBeGreaterThan(-1);
    expect(connectPos, 'server.connect() call not found in src/index.ts').toBeGreaterThan(-1);
    expect(
      lockdownPos,
      'lockdownStdout() must appear before server.connect() in src/index.ts'
    ).toBeLessThan(connectPos);
  });
});

// ---------------------------------------------------------------------------
// 3. Signal handlers — graceful shutdown (LOG-1, design §2.1)
// ---------------------------------------------------------------------------

describe('src/index.ts — signal handlers (LOG-1)', () => {
  it("registers a SIGINT handler via process.on('SIGINT', ...)", () => {
    expect(indexStripped).toMatch(/process\.on\s*\(\s*['"]SIGINT['"]/);
  });

  it("registers a SIGTERM handler via process.on('SIGTERM', ...)", () => {
    expect(indexStripped).toMatch(/process\.on\s*\(\s*['"]SIGTERM['"]/);
  });
});

// ---------------------------------------------------------------------------
// 4 + 5. Transport isolation — positive and guard (LOG-3, LOG-6)
// ---------------------------------------------------------------------------

describe('src/index.ts — transport isolation guard (LOG-3, LOG-6)', () => {
  it('imports StdioServerTransport from server/stdio (positive assertion)', () => {
    // index.ts MUST bind the transport — this positive assertion confirms the
    // import is present and was not accidentally removed.
    expect(indexStripped).toMatch(/server\/stdio/);
  });

  it('src/index.ts is the ONLY file under src/ that imports from server/stdio', () => {
    // Extend the server-isolation.test.ts guard: that test covers server/core/
    // domain/contract/lib; this one covers the whole src/ tree so that a rogue
    // transport import added to src/tools/*.ts is also caught.
    const allSrcFiles = collectTsFiles(join(ROOT, 'src'));

    const offenders = allSrcFiles.filter(f => {
      if (f === INDEX_PATH) return false; // index.ts is the one permitted importer
      const code = stripComments(readFileSync(f, 'utf8'));
      return /server\/stdio/.test(code);
    });

    expect(
      offenders.map(f => './' + relative(ROOT, f).replace(/\\/g, '/')),
      'files other than src/index.ts that import from server/stdio'
    ).toEqual([]);
  });
});
