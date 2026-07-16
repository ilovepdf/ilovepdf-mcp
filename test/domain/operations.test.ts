/**
 * test/domain/operations.test.ts
 *
 * Registry-integrity tests for the OPERATIONS single source of truth
 * (OPS-1..OPS-7).
 *
 * The registry is the ONE authoritative record of the 10 supported PDF
 * operations. Every other module (tool generation, executor, validation)
 * derives its data from here via `apiToolFor` / `specFor` / `OPERATION_NAMES`.
 * These tests lock the exact op set, the kebab-case naming rule, the exact
 * iLovePDF API tool slugs, accepted extensions, and the orchestration flags —
 * and assert no apiTool slug is hardcoded outside the registry (source scan).
 */

import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  OPERATIONS,
  OPERATION_NAMES,
  specFor,
  apiToolFor,
} from '../../src/domain/operations.js';
import { OPTIONS_SCHEMAS } from '../../src/contract/options-schema.js';
import type {
  OperationName,
  ApiTool,
} from '../../src/domain/operation-types.js';

// The authoritative op → apiTool mapping the registry MUST express.
const EXPECTED_API_TOOL: Record<OperationName, ApiTool> = {
  'compress-pdf': 'compress',
  'pdf-to-jpg': 'pdfjpg',
  'image-to-pdf': 'imagepdf',
  'office-to-pdf': 'officepdf',
  'merge-pdf': 'merge',
  'split-pdf': 'split',
  'unlock': 'unlock',
  'watermark': 'watermark',
  'pagenumber': 'pagenumber',
  'pdf-ocr': 'pdfocr',
};

const EXPECTED_EXTENSIONS: Record<OperationName, string[]> = {
  'compress-pdf': ['.pdf'],
  'pdf-to-jpg': ['.pdf'],
  'image-to-pdf': ['.jpg', '.jpeg', '.png', '.tif', '.tiff'],
  'office-to-pdf': ['.doc', '.docx', '.xls', '.xlsx', '.ppt', '.pptx'],
  'merge-pdf': ['.pdf'],
  'split-pdf': ['.pdf'],
  'unlock': ['.pdf'],
  'watermark': ['.pdf'],
  'pagenumber': ['.pdf'],
  'pdf-ocr': ['.pdf'],
};

const ALL_OPS = Object.keys(EXPECTED_API_TOOL) as OperationName[];

describe('OPERATIONS registry integrity (OPS-1, OPS-2)', () => {
  it('OPERATION_NAMES equals Object.keys(OPERATIONS)', () => {
    expect(OPERATION_NAMES).toEqual(Object.keys(OPERATIONS));
  });

  it('contains exactly 10 operations', () => {
    expect(OPERATION_NAMES).toHaveLength(10);
    expect(Object.keys(OPERATIONS)).toHaveLength(10);
  });

  it('contains exactly the expected op names', () => {
    expect(new Set(OPERATION_NAMES)).toEqual(new Set(ALL_OPS));
  });

  it('every operation name is kebab-case (^[a-z]+(-[a-z]+)*$)', () => {
    const kebab = /^[a-z]+(-[a-z]+)*$/;
    for (const name of OPERATION_NAMES) {
      expect(name, `operation name "${name}"`).toMatch(kebab);
    }
  });

  it("each spec's name field matches its registry key", () => {
    for (const name of OPERATION_NAMES) {
      expect(OPERATIONS[name].name).toBe(name);
    }
  });
});

describe('apiToolFor mapping (OPS-2)', () => {
  it('maps each of the 10 ops to its exact iLovePDF slug', () => {
    for (const name of ALL_OPS) {
      expect(apiToolFor(name)).toBe(EXPECTED_API_TOOL[name]);
    }
  });

  it('specFor returns the full spec for each op', () => {
    for (const name of ALL_OPS) {
      expect(specFor(name)).toBe(OPERATIONS[name]);
      expect(specFor(name).apiTool).toBe(EXPECTED_API_TOOL[name]);
    }
  });
});

describe('acceptedExtensions (OPS-3)', () => {
  it('are exact per operation', () => {
    for (const name of ALL_OPS) {
      expect(
        Array.from(OPERATIONS[name].acceptedExtensions),
        `extensions for "${name}"`
      ).toEqual(EXPECTED_EXTENSIONS[name]);
    }
  });
});

describe('orchestration flags (OPS-5, OPS-6)', () => {
  it('requiresSharedTask is true ONLY for merge-pdf and image-to-pdf', () => {
    for (const name of ALL_OPS) {
      const expected = name === 'merge-pdf' || name === 'image-to-pdf';
      expect(OPERATIONS[name].requiresSharedTask, `requiresSharedTask for "${name}"`).toBe(
        expected
      );
    }
  });

  it('mustBeDirect is true ONLY for unlock', () => {
    for (const name of ALL_OPS) {
      expect(OPERATIONS[name].mustBeDirect, `mustBeDirect for "${name}"`).toBe(
        name === 'unlock'
      );
    }
  });
});

describe('optionsSchema wiring (OPS-4)', () => {
  it('each op references OPTIONS_SCHEMAS[name] (same reference)', () => {
    for (const name of ALL_OPS) {
      expect(OPERATIONS[name].optionsSchema).toBe(OPTIONS_SCHEMAS[name]);
    }
  });
});

describe('widget/legacy fields removed (OPS-7)', () => {
  it('no spec carries a widgetParams field', () => {
    for (const name of ALL_OPS) {
      expect(OPERATIONS[name]).not.toHaveProperty('widgetParams');
    }
  });

  it('does not export TOOL_TO_API_MAP or an "ilovepdf" wildcard', async () => {
    const mod = await import('../../src/domain/operations.js');
    expect(mod).not.toHaveProperty('TOOL_TO_API_MAP');
  });
});

describe('cardinality fields — minSources / maxSources (TOOL-4 decoupled)', () => {
  /**
   * Convention (documented in operation-types.ts):
   *   min = op.minSources ?? 1
   *   max = op.maxSources ?? (op.minSources !== undefined ? Infinity : 1)
   *
   * - Both fields omitted  → exactly 1 source (single-file ops)
   * - minSources set, maxSources omitted → min≤sources≤Infinity (unbounded)
   */
  it('merge-pdf has minSources=2 and maxSources undefined (unbounded max)', () => {
    expect(OPERATIONS['merge-pdf'].minSources).toBe(2);
    expect(OPERATIONS['merge-pdf'].maxSources).toBeUndefined();
  });

  it('image-to-pdf has minSources=1 and maxSources undefined (unbounded max)', () => {
    expect(OPERATIONS['image-to-pdf'].minSources).toBe(1);
    expect(OPERATIONS['image-to-pdf'].maxSources).toBeUndefined();
  });

  it('all 8 single-file ops have both minSources and maxSources undefined (default exactly 1)', () => {
    const singleFileOps = [
      'compress-pdf',
      'pdf-to-jpg',
      'office-to-pdf',
      'split-pdf',
      'unlock',
      'watermark',
      'pagenumber',
      'pdf-ocr',
    ] as const;

    for (const name of singleFileOps) {
      expect(OPERATIONS[name].minSources, `minSources for "${name}"`).toBeUndefined();
      expect(OPERATIONS[name].maxSources, `maxSources for "${name}"`).toBeUndefined();
    }
  });

  it('requiresSharedTask remains an upload-strategy flag independent of cardinality', () => {
    // image-to-pdf: requiresSharedTask=true AND minSources=1 (not 2) — these are decoupled.
    expect(OPERATIONS['image-to-pdf'].requiresSharedTask).toBe(true);
    expect(OPERATIONS['image-to-pdf'].minSources).toBe(1);
    // merge-pdf: also requiresSharedTask=true AND minSources=2.
    expect(OPERATIONS['merge-pdf'].requiresSharedTask).toBe(true);
    expect(OPERATIONS['merge-pdf'].minSources).toBe(2);
  });
});

describe('producesArchive SSOT flag (ZIP derivation — Fix 4)', () => {
  it('producesArchive is true ONLY for split-pdf and pdf-to-jpg', () => {
    for (const name of ALL_OPS) {
      const expected = name === 'split-pdf' || name === 'pdf-to-jpg';
      if (expected) {
        expect(OPERATIONS[name].producesArchive, `producesArchive for "${name}"`).toBe(true);
      } else {
        // Optional field is absent (undefined) for all non-archive ops.
        expect(OPERATIONS[name].producesArchive, `producesArchive for "${name}"`).toBeUndefined();
      }
    }
  });

  it('no bare slug literals "split" or "pdfjpg" remain in file-io.ts ZIP_API_TOOLS (source scan)', () => {
    const src: string = readFileSync(join(process.cwd(), 'src', 'lib', 'file-io.ts'), 'utf8');
    // Strip comments so JSDoc references don't trigger false positives.
    const code = src
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/\/\/[^\n]*/g, '');
    // These exact slug strings must NOT appear as string literals in file-io.ts code.
    expect(code).not.toMatch(/'split'/);
    expect(code).not.toMatch(/'pdfjpg'/);
    expect(code).not.toMatch(/ZIP_API_TOOLS/);
  });
});

describe('single-source-of-truth source scan (OPS-1)', () => {
  function collectTsFiles(dir: string, base: string, acc: string[]): string[] {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const abs = join(dir, entry.name);
      const rel = join(base, entry.name);
      if (entry.isDirectory()) {
        collectTsFiles(abs, rel, acc);
      } else if (entry.name.endsWith('.ts')) {
        acc.push(rel);
      }
    }
    return acc;
  }

  // Strip line + block comments so we only inspect real code (JSDoc examples
  // mentioning slugs are not violations).
  function stripComments(src: string): string {
    return src
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/\/\/[^\n]*/g, '');
  }

  const files = collectTsFiles(join(process.cwd(), 'src'), 'src', []);

  it('the op→apiTool mapping is not re-declared anywhere (no TOOL_TO_API_MAP)', () => {
    const offenders = files.filter(rel =>
      /TOOL_TO_API_MAP/.test(
        stripComments(readFileSync(join(process.cwd(), rel), 'utf8'))
      )
    );
    expect(offenders, 'files still referencing TOOL_TO_API_MAP in code').toEqual([]);
  });

  it('no "ilovepdf" wildcard maps to an apiTool slug in code', () => {
    // The dropped Worker wildcard was `ilovepdf: 'compress'`. Any object entry
    // keying the literal "ilovepdf" (quoted or bare) to a slug is forbidden.
    const wildcard = /(['"]ilovepdf['"]|\bilovepdf)\s*:\s*['"][a-z]+['"]/;
    const offenders = files.filter(rel =>
      wildcard.test(stripComments(readFileSync(join(process.cwd(), rel), 'utf8')))
    );
    expect(offenders, 'files declaring an ilovepdf wildcard slug mapping').toEqual([]);
  });

  it('the registry file declares no secondary hardcoded slug map', () => {
    // Within operations.ts, the ONLY place a slug appears as a value must be
    // each op's own `apiTool:` field — exactly 10 such assignments, no more.
    const src = stripComments(
      readFileSync(join(process.cwd(), 'src', 'domain', 'operations.ts'), 'utf8')
    );
    const apiToolAssignments = src.match(/apiTool:\s*['"][a-z]+['"]/g) ?? [];
    expect(apiToolAssignments).toHaveLength(10);
    expect(src).not.toMatch(/TOOL_TO_API_MAP/);
    expect(src).not.toMatch(/ilovepdf['"]?\s*:/);
  });
});
