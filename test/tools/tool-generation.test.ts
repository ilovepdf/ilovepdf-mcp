/**
 * test/tools/tool-generation.test.ts
 *
 * Registry-driven tool generation tests (TOOL-1, TOOL-2, TOOL-6, OPS-7).
 * RED for T050 — `src/tools/register.ts` does not yet exist.
 *
 * A fake 11th operation ("stub-test-op") is injected via vi.mock to prove
 * TOOL-1: registerAllTools is purely data-driven — adding an entry to the
 * operations registry requires NO changes to register.ts and automatically
 * yields one more registered tool.
 *
 * The stub spec carries a `widgetParams` field (OPS-7): the headless tool
 * generator must ignore extra metadata entirely (widgetParams were present in
 * the old widget registry; this proves they are not accessed by the generator).
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';

// ---------------------------------------------------------------------------
// Stub constants — vi.hoisted ensures they are available inside vi.mock
// factory functions, which are hoisted above regular imports.
// ---------------------------------------------------------------------------
const { STUB_OP_NAME, STUB_TOOL_NAME } = vi.hoisted(() => {
  const name = 'stub-test-op';
  return {
    STUB_OP_NAME: name,
    STUB_TOOL_NAME: `iLovePDF_${name.replace(/-/g, '_')}`,
  };
});

// ---------------------------------------------------------------------------
// Module mocks (registered before imports are resolved)
// ---------------------------------------------------------------------------

/**
 * Inject a fake 11th operation into the operations registry.
 * The stub spec includes `widgetParams` (OPS-7): a field from the old
 * widget registry that the headless tool generator must ignore.
 */
vi.mock('../../src/domain/operations.js', async importOriginal => {
  const actual = await importOriginal<typeof import('../../src/domain/operations.js')>();
  const { z } = await import('zod');

  // Plain object that satisfies OperationSpec structurally at runtime.
  // The `widgetParams` field is intentionally extra (OPS-7).
  const stubSpec = {
    name: STUB_OP_NAME,
    apiTool: 'compress' as const,
    label: 'Stub Test Op',
    description: 'Stub op used in tool-generation tests.',
    acceptedExtensions: ['.pdf'] as readonly string[],
    defaultOptions: {} as Readonly<Record<string, unknown>>,
    requiresSharedTask: false,
    mustBeDirect: false,
    optionsSchema: z.object({}).passthrough(),
    // OPS-7: extra field from the old widget registry; must be silently ignored.
    widgetParams: ['some_ignored_param'],
  };

  return {
    ...actual,
    OPERATION_NAMES: [
      ...actual.OPERATION_NAMES,
      STUB_OP_NAME as unknown as import('../../src/domain/operation-types.js').OperationName,
    ],
    specFor: (
      n: import('../../src/domain/operation-types.js').OperationName
    ): import('../../src/domain/operation-types.js').OperationSpec => {
      if ((n as string) === STUB_OP_NAME) {
        return stubSpec as unknown as import('../../src/domain/operation-types.js').OperationSpec;
      }
      return actual.specFor(n);
    },
  };
});

/**
 * Make describeTool handle the stub op name, since the real implementation
 * throws for any op not in its CAPABILITY map.
 */
vi.mock('../../src/tools/descriptions.js', async importOriginal => {
  const actual = await importOriginal<typeof import('../../src/tools/descriptions.js')>();
  return {
    ...actual,
    describeTool: (
      op: import('../../src/domain/operation-types.js').OperationName
    ): string => {
      if ((op as string) === STUB_OP_NAME) {
        return 'Stub op for testing. Input is a local file path or URL.';
      }
      return actual.describeTool(op);
    },
  };
});

// ---------------------------------------------------------------------------
// Real imports (resolved after vi.mock factories are registered)
// ---------------------------------------------------------------------------

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { OPERATION_NAMES, specFor } from '../../src/domain/operations.js';
import { toolName } from '../../src/tools/tool-name.js';
import { registerAllTools } from '../../src/tools/register.js'; // RED: file does not exist yet

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * The shape of each entry in McpServer's internal _registeredTools map.
 * We access the private field via a bracketed cast for introspection in tests.
 */
type RawTool = {
  inputSchema?: unknown;
  outputSchema?: unknown;
  title?: string;
  description?: string;
};

/** Read the private _registeredTools map from a McpServer instance. */
function getTools(server: McpServer): Record<string, RawTool> {
  return (server as unknown as Record<string, unknown>)['_registeredTools'] as Record<
    string,
    RawTool
  >;
}

/** Create a fresh McpServer for each test. */
function makeServer(): McpServer {
  return new McpServer(
    { name: '@ilovepdf/mcp-test', version: '0.0.0' },
    { capabilities: { tools: {} } }
  );
}

// ---------------------------------------------------------------------------
// TOOL-1: registration count equals OPERATION_NAMES.length
// ---------------------------------------------------------------------------

describe('registerAllTools — count (TOOL-1)', () => {
  it('registers exactly OPERATION_NAMES.length tools', () => {
    const server = makeServer();
    registerAllTools(server);
    const tools = getTools(server);
    expect(Object.keys(tools)).toHaveLength(OPERATION_NAMES.length);
  });

  it('mocked OPERATION_NAMES includes the stub (10 total)', () => {
    // Confirm the mock injected the extra entry — prerequisite for the next test.
    // (9 real ops + 1 stub = 10; unlock temporarily disabled.)
    expect(OPERATION_NAMES).toContain(STUB_OP_NAME);
    expect(OPERATION_NAMES).toHaveLength(10);
  });

  it('stubbed extra entry yields an extra tool with no register.ts change (TOOL-1)', () => {
    // OPERATION_NAMES is mocked to 10 entries. registerAllTools must produce
    // 10 tools purely by iteration — no hardcoded counts in register.ts.
    const server = makeServer();
    registerAllTools(server);
    const tools = getTools(server);
    expect(Object.keys(tools)).toHaveLength(10);
    expect(Object.keys(tools)).toContain(STUB_TOOL_NAME);
  });

  it('each op produces exactly one distinct tool (no duplicates)', () => {
    const server = makeServer();
    registerAllTools(server);
    const tools = getTools(server);
    const distinct = new Set(Object.keys(tools));
    expect(distinct.size).toBe(OPERATION_NAMES.length);
  });
});

// ---------------------------------------------------------------------------
// TOOL-2 / DEC-1: tool names are the mechanical ilovepdf_<snake_case> rule
// ---------------------------------------------------------------------------

describe('registerAllTools — tool names (TOOL-2 / DEC-1)', () => {
  let tools: Record<string, RawTool>;

  beforeEach(() => {
    const server = makeServer();
    registerAllTools(server);
    tools = getTools(server);
  });

  it('every op maps to its DEC-1 mechanical tool name', () => {
    for (const name of OPERATION_NAMES) {
      const expected = toolName(
        specFor(name as unknown as import('../../src/domain/operation-types.js').OperationName)
      );
      expect(
        Object.keys(tools),
        `expected tool "${expected}" for op "${name}"`
      ).toContain(expected);
    }
  });

  it('tool names for the 9 real ops match the exact DEC-1 set', () => {
    const EXPECTED = [
      'iLovePDF_compress_pdf',
      'iLovePDF_pdf_to_jpg',
      'iLovePDF_image_to_pdf',
      'iLovePDF_office_to_pdf',
      'iLovePDF_merge_pdf',
      'iLovePDF_split_pdf',
      // 'iLovePDF_unlock', // TEMPORARILY DISABLED — re-enable to publish.
      'iLovePDF_watermark',
      'iLovePDF_pagenumber',
      'iLovePDF_pdf_ocr',
    ];
    for (const name of EXPECTED) {
      expect(Object.keys(tools)).toContain(name);
    }
  });

  it('all tool names match ^iLovePDF_[a-z_]+$', () => {
    for (const name of Object.keys(tools)) {
      expect(name, `tool name "${name}" must match pattern`).toMatch(
        /^iLovePDF_[a-z_]+$/
      );
    }
  });
});

// ---------------------------------------------------------------------------
// TOOL-6: every registered tool declares non-empty inputSchema + outputSchema
// ---------------------------------------------------------------------------

describe('registerAllTools — schemas (TOOL-6)', () => {
  let tools: Record<string, RawTool>;

  beforeEach(() => {
    const server = makeServer();
    registerAllTools(server);
    tools = getTools(server);
  });

  it('every tool has inputSchema defined and non-null', () => {
    for (const [name, tool] of Object.entries(tools)) {
      expect(tool.inputSchema, `${name}.inputSchema`).toBeDefined();
      expect(tool.inputSchema, `${name}.inputSchema must not be null`).not.toBeNull();
    }
  });

  it('every tool has outputSchema defined and non-null', () => {
    for (const [name, tool] of Object.entries(tools)) {
      expect(tool.outputSchema, `${name}.outputSchema`).toBeDefined();
      expect(tool.outputSchema, `${name}.outputSchema must not be null`).not.toBeNull();
    }
  });
});

// ---------------------------------------------------------------------------
// OPS-7: widgetParams on a spec is silently ignored by the generator
// ---------------------------------------------------------------------------

describe('registerAllTools — OPS-7 (widgetParams ignored)', () => {
  it('stub op with widgetParams field registers with correct name and schemas', () => {
    const server = makeServer();
    registerAllTools(server);
    const tools = getTools(server);
    // The stub spec has `widgetParams` (old widget field). It must be registered
    // normally — the headless tool generator must not access or fail on this field.
    expect(Object.keys(tools)).toContain(STUB_TOOL_NAME);
    expect(tools[STUB_TOOL_NAME]?.inputSchema).toBeDefined();
    expect(tools[STUB_TOOL_NAME]?.outputSchema).toBeDefined();
  });
});
