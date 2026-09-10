/**
 * test/server-isolation.test.ts
 *
 * Guard test for LOG-2 (transport isolation) and LOG-1 (server builder).
 *
 * Two invariants are enforced:
 *
 * 1. SOURCE SCAN — `src/server.ts` and every TypeScript file under
 *    `src/core/`, `src/domain/`, `src/contract/`, and `src/lib/` must NOT
 *    import from the transport module path (`server/stdio`) and must NOT
 *    reference `process.stdout` or `process.stdin` in live code.
 *    Node built-ins such as `dns`, `net`, `url`, `path`, and `fs` are
 *    permitted — only the transport entry point and direct stdio stream
 *    references are forbidden (LOG-2).
 *
 * 2. RUNTIME ASSERT — `buildServer()` returns a fully configured `McpServer`
 *    with all 9 tools registered WITHOUT connecting a transport. No transport
 *    is bound here; the registered tool count is verified via the internal
 *    `_registeredTools` map (same introspection pattern as
 *    test/tools/tool-generation.test.ts).
 *
 * This file is RED until `src/server.ts` is implemented (T052), because the
 * `buildServer` import below fails when the file does not exist.
 */

import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { OPERATION_NAMES } from '../src/domain/operations.js';
import { buildServer } from '../src/server.js'; // RED until T052 — file does not exist

// ---------------------------------------------------------------------------
// Source-scan helpers
// ---------------------------------------------------------------------------

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

/** Strip block and line comments so patterns only match live code. */
function stripComments(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, '') // block comments (including JSDoc)
    .replace(/\/\/[^\n]*/g, ''); // line comments
}

/** Repo root — where `package.json` lives and tests are run from. */
const ROOT = process.cwd();

/**
 * Files subject to the transport-isolation guard:
 *   - src/server.ts (the builder itself)
 *   - every .ts file under src/core/, src/domain/, src/contract/, src/lib/
 *
 * Files that do not yet exist are filtered out. The suite is still RED in
 * the pre-T052 state because the `buildServer` import above fails at
 * module-load time before any test function executes.
 */
const SCANNED_FILES: string[] = [
  join(ROOT, 'src', 'server.ts'),
  ...collectTsFiles(join(ROOT, 'src', 'core')),
  ...collectTsFiles(join(ROOT, 'src', 'domain')),
  ...collectTsFiles(join(ROOT, 'src', 'contract')),
  ...collectTsFiles(join(ROOT, 'src', 'lib')),
].filter(f => existsSync(f));

// ---------------------------------------------------------------------------
// Runtime helper types
// ---------------------------------------------------------------------------

type RegisteredToolsMap = Record<
  string,
  { inputSchema?: unknown; outputSchema?: unknown }
>;

/** Read the private _registeredTools map from a McpServer instance. */
function getTools(server: McpServer): RegisteredToolsMap {
  return (server as Record<string, unknown>)[
    '_registeredTools'
  ] as RegisteredToolsMap;
}

// ---------------------------------------------------------------------------
// LOG-2: source isolation scan
// ---------------------------------------------------------------------------

describe('server isolation — source scan (LOG-2)', () => {
  it('the scanned file list is non-empty', () => {
    // Sanity guard: if this fails the test environment is broken (no source
    // files to scan). Expected count is at least the core/domain/lib files.
    expect(SCANNED_FILES.length).toBeGreaterThan(0);
  });

  it('no scanned file imports from server/stdio (transport forbidden)', () => {
    const offenders = SCANNED_FILES.filter(file => {
      const code = stripComments(readFileSync(file, 'utf8'));
      // Match the import path substring — catches both:
      //   from '@modelcontextprotocol/sdk/server/stdio.js'
      //   from './server/stdio.js'  (hypothetical relative form)
      return /server\/stdio/.test(code);
    });
    expect(
      offenders.map(f => f.replace(ROOT + '/', './')),
      'files that import from server/stdio'
    ).toEqual([]);
  });

  it('no scanned file references StdioServerTransport (transport forbidden)', () => {
    const offenders = SCANNED_FILES.filter(file => {
      const code = stripComments(readFileSync(file, 'utf8'));
      return /StdioServerTransport/.test(code);
    });
    expect(
      offenders.map(f => f.replace(ROOT + '/', './')),
      'files referencing StdioServerTransport'
    ).toEqual([]);
  });

  it('no scanned file references process.stdout (direct stdio stream forbidden)', () => {
    const offenders = SCANNED_FILES.filter(file => {
      const code = stripComments(readFileSync(file, 'utf8'));
      return /process\.stdout/.test(code);
    });
    expect(
      offenders.map(f => f.replace(ROOT + '/', './')),
      'files referencing process.stdout'
    ).toEqual([]);
  });

  it('no scanned file references process.stdin (direct stdio stream forbidden)', () => {
    const offenders = SCANNED_FILES.filter(file => {
      const code = stripComments(readFileSync(file, 'utf8'));
      return /process\.stdin/.test(code);
    });
    expect(
      offenders.map(f => f.replace(ROOT + '/', './')),
      'files referencing process.stdin'
    ).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// LOG-1 / LOG-2: buildServer() runtime assertion
// ---------------------------------------------------------------------------

describe('buildServer() — runtime assertion (LOG-1, LOG-2)', () => {
  it('returns a McpServer instance', () => {
    const server = buildServer();
    expect(server).toBeInstanceOf(McpServer);
  });

  it('registers exactly OPERATION_NAMES.length (9) tools without a transport', () => {
    // buildServer() must complete with all tools registered and without
    // calling server.connect() — no transport is bound in this test.
    const server = buildServer();
    const tools = getTools(server);
    expect(Object.keys(tools)).toHaveLength(OPERATION_NAMES.length);
  });

  it('registers exactly 9 tools (absolute count guard)', () => {
    // unlock temporarily disabled (10 → 9). Re-enable to restore the 10th tool.
    const server = buildServer();
    const tools = getTools(server);
    expect(Object.keys(tools)).toHaveLength(9);
  });

  it('every registered tool has inputSchema and outputSchema defined', () => {
    const server = buildServer();
    const tools = getTools(server);
    for (const [name, tool] of Object.entries(tools)) {
      expect(tool.inputSchema, `${name}.inputSchema`).toBeDefined();
      expect(tool.outputSchema, `${name}.outputSchema`).toBeDefined();
    }
  });
});
