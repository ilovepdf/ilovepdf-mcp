#!/usr/bin/env tsx
/**
 * test/integration/runner.ts
 *
 * Conecta al servidor MCP via StdioClientTransport, ejecuta cada test del
 * suite contra archivos reales, y escribe test-results.json en la raíz del
 * proyecto.
 *
 * Uso:
 *   ILOVEPDF_PUBLIC_KEY=tu_clave npx tsx test/integration/runner.ts
 *
 * Variables de entorno:
 *   ILOVEPDF_PUBLIC_KEY   — requerido
 *   ILOVEPDF_MCP_WORKDIR  — opcional, default: C:\Users\FacundoYoris\Desktop\projects\ILovePDF
 *
 * La salida test-results.json puede importarse desde la página HTML del test suite.
 */

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { writeFileSync, mkdirSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = join(__dirname, '..', '..');

const WORKDIR =
  process.env.ILOVEPDF_MCP_WORKDIR ??
  'C:\\Users\\FacundoYoris\\Desktop\\projects\\ILovePDF';

const PDF = join(WORKDIR, 'AWS_Certified_AI_Practitioner.pdf');
const PNG = join(WORKDIR, 'iLovePDFLogo.png');
const OUT_DIR = join(WORKDIR, 'test-outputs');

// ---------------------------------------------------------------------------
// Test definitions
// ---------------------------------------------------------------------------

interface TestDef {
  toolId: string;
  testKey: string;
  name: string;
  sources: string[];
  params: Record<string, unknown>;
  /**
   * true  → espera isError:true  (test de error esperado)
   * false → espera success:true
   * null  → skip (comportamiento incierto o archivo requerido no disponible)
   */
  expectError: boolean | null;
}

const T = (
  toolId: string,
  testKey: string,
  name: string,
  sources: string[],
  params: Record<string, unknown>,
  expectError: boolean | null,
): TestDef => ({ toolId, testKey, name, sources, params, expectError });

const TESTS: TestDef[] = [
  // -------------------------------------------------------------------------
  // 01 · compress-pdf
  // -------------------------------------------------------------------------
  T('compress-pdf', 'd:0', 'Sin parámetros', [PDF], {}, false),
  T('compress-pdf', 'd:1', 'compression_level: recommended', [PDF], { compression_level: 'recommended' }, false),
  T('compress-pdf', 'd:2', 'compression_level: extreme', [PDF], { compression_level: 'extreme' }, false),
  T('compress-pdf', 'd:3', 'compression_level: low', [PDF], { compression_level: 'low' }, false),
  T('compress-pdf', 'd:4', 'Enum inválido → Zod error', [PDF], { compression_level: 'ultra' }, true),
  T('compress-pdf', 'd:5', 'Param inexistente → ignorado', [PDF], { fake_option: 'yes' }, false),

  // -------------------------------------------------------------------------
  // 02 · pdf-to-jpg
  // -------------------------------------------------------------------------
  T('pdf-to-jpg', 'd:0', 'Sin parámetros', [PDF], {}, false),
  T('pdf-to-jpg', 'd:1', 'pdfjpg_mode: pages', [PDF], { pdfjpg_mode: 'pages' }, false),
  T('pdf-to-jpg', 'd:2', 'pdfjpg_mode: extract', [PDF], { pdfjpg_mode: 'extract' }, false),
  T('pdf-to-jpg', 'd:3', 'quality: Normal', [PDF], { quality: 'Normal' }, false),
  T('pdf-to-jpg', 'd:4', 'quality: High', [PDF], { quality: 'High' }, false),
  T('pdf-to-jpg', 'd:5', 'extract + quality Normal', [PDF], { pdfjpg_mode: 'extract', quality: 'Normal' }, false),
  T('pdf-to-jpg', 'd:6', 'Enum inválido → Zod error', [PDF], { pdfjpg_mode: 'thumbnails' }, true),
  T('pdf-to-jpg', 'd:7', 'Param dpi directo (desconocido)', [PDF], { dpi: 200 }, false),

  // -------------------------------------------------------------------------
  // 03 · image-to-pdf
  // -------------------------------------------------------------------------
  T('image-to-pdf', 'd:0', 'Sin parámetros', [PNG], {}, false),
  T('image-to-pdf', 'd:1', 'Landscape + A4', [PNG], { orientation: 'landscape', pagesize: 'A4' }, false),
  T('image-to-pdf', 'd:2', 'Portrait + letter + margen 10', [PNG], { orientation: 'portrait', pagesize: 'letter', margin: 10 }, false),
  T('image-to-pdf', 'd:3', 'Sin fusionar', [PNG], { merge_after: false }, false),
  T('image-to-pdf', 'd:4', 'Landscape + fit → normalizer usa A4', [PNG], { orientation: 'landscape', pagesize: 'fit' }, false),
  T('image-to-pdf', 'd:5', 'Orientación inválida → portrait', [PNG], { orientation: 'sideways' }, false),
  T('image-to-pdf', 'd:6', 'Pagesize inválido → fit', [PNG], { pagesize: 'A3' }, false),
  T('image-to-pdf', 'd:7', 'margin negativo → 0', [PNG], { margin: -10 }, false),

  // -------------------------------------------------------------------------
  // 04 · office-to-pdf (skip — sin archivos Office en el directorio)
  // -------------------------------------------------------------------------
  T('office-to-pdf', 'd:0', 'Archivo Word (.docx)', [], {}, null),
  T('office-to-pdf', 'd:1', 'Archivo Excel (.xlsx)', [], {}, null),
  T('office-to-pdf', 'd:2', 'Archivo PowerPoint (.pptx)', [], {}, null),
  T('office-to-pdf', 'd:3', 'Param inexistente → ignorado', [], {}, null),

  // -------------------------------------------------------------------------
  // 05 · merge-pdf
  // -------------------------------------------------------------------------
  T('merge-pdf', 'd:0', '2 archivos', [PDF, PDF], {}, false),
  T('merge-pdf', 'd:1', '3 archivos', [PDF, PDF, PDF], {}, false),
  T('merge-pdf', 'd:2', 'Solo 1 archivo → error cardinality', [PDF], {}, true),
  T('merge-pdf', 'd:3', 'Param inexistente → ignorado', [PDF, PDF], { order: 'alphabetical' }, false),

  // -------------------------------------------------------------------------
  // 06 · split-pdf
  // -------------------------------------------------------------------------
  T('split-pdf', 'd:0', 'Sin parámetros', [PDF], {}, false),
  T('split-pdf', 'd:1', 'Ranges: 1-3 y 4-6', [PDF], { split_mode: 'ranges', ranges: '1-3,4-6' }, false),
  T('split-pdf', 'd:2', 'Fixed range: 2', [PDF], { split_mode: 'fixed_range', fixed_range: 2 }, false),
  T('split-pdf', 'd:3', 'Remove pages: 2 y 5', [PDF], { split_mode: 'remove_pages', remove_pages: '2,5' }, false),
  T('split-pdf', 'd:4', 'Ranges + merge_after', [PDF], { split_mode: 'ranges', ranges: '1-3,4-6', merge_after: true }, false),
  T('split-pdf', 'd:5', 'Solo fixed_range → infiere modo', [PDF], { fixed_range: 3 }, false),
  T('split-pdf', 'd:6', 'Solo ranges → infiere modo', [PDF], { ranges: '1-5' }, false),
  T('split-pdf', 'd:7', 'split_mode inválido → ranges', [PDF], { split_mode: 'pages', ranges: '1-2' }, false),
  T('split-pdf', 'd:8', 'merge_after con fixed_range → ignorado', [PDF], { split_mode: 'fixed_range', fixed_range: 1, merge_after: true }, false),
  T('split-pdf', 'd:9', 'fixed_range: 0 → normalizer usa 1', [PDF], { split_mode: 'fixed_range', fixed_range: 0 }, false),

  // -------------------------------------------------------------------------
  // 07 · unlock (skip — sin PDF protegido disponible)
  // -------------------------------------------------------------------------
  T('unlock', 'd:0', 'PDF sin contraseña', [PDF], {}, null),
  T('unlock', 'd:1', 'Con password correcto', [PDF], { password: 'correct_password' }, null),
  T('unlock', 'd:2', 'Con password incorrecto', [PDF], { password: 'wrong' }, null),
  T('unlock', 'd:3', 'PDF protegido sin password', [PDF], {}, null),

  // -------------------------------------------------------------------------
  // 08 · watermark
  // -------------------------------------------------------------------------
  T('watermark', 'd:0', 'Sin parámetros (mode=text sin text)', [PDF], {}, true),
  T('watermark', 'd:1', 'Texto: BORRADOR', [PDF], { text: 'BORRADOR' }, false),
  T('watermark', 'd:2', 'Times + rojo + 24pt', [PDF], { text: 'CONFIDENCIAL', font_family: 'Times New Roman', font_color: '#FF0000', font_size: 24 }, false),
  T('watermark', 'd:3', 'Mosaico + 45° + 50%', [PDF], { text: 'DRAFT', mosaic: true, rotation: 45, transparency: 50 }, false),
  T('watermark', 'd:4', 'Solo páginas 1-3', [PDF], { text: 'BORRADOR', pages: '1-3' }, false),
  T('watermark', 'd:5', 'Abajo a la derecha', [PDF], { text: 'TEST', vertical_position: 'bottom', horizontal_position: 'right' }, false),
  T('watermark', 'd:6', 'Layer below', [PDF], { text: 'MARCA', layer: 'below' }, false),
  T('watermark', 'd:7', 'Fuente no soportada → Arial', [PDF], { text: 'TEST', font_family: 'Helvetica' }, false),
  T('watermark', 'd:8', 'Color inválido "red" → #000000', [PDF], { text: 'TEST', font_color: 'red' }, false),
  T('watermark', 'd:9', 'mode=text sin text → error API', [PDF], { mode: 'text' }, true),
  T('watermark', 'd:10', 'font_style: Bold', [PDF], { text: 'BOLD', font_style: 'Bold' }, false),
  T('watermark', 'd:11', 'font_style: Italic', [PDF], { text: 'ITALIC', font_style: 'Italic' }, false),

  // -------------------------------------------------------------------------
  // 09 · pagenumber
  // -------------------------------------------------------------------------
  T('pagenumber', 'd:0', 'Sin parámetros', [PDF], {}, false),
  T('pagenumber', 'd:1', 'Saltear portada', [PDF], { first_cover: true }, false),
  T('pagenumber', 'd:2', 'Arriba a la derecha', [PDF], { vertical_position: 'top', horizontal_position: 'right' }, false),
  T('pagenumber', 'd:3', 'facing_pages', [PDF], { facing_pages: true }, false),
  T('pagenumber', 'd:4', 'starting_number: 10', [PDF], { starting_number: 10 }, false),
  T('pagenumber', 'd:5', 'Formato: Página {n} de {p}', [PDF], { text: 'Página {n} de {p}' }, false),
  T('pagenumber', 'd:6', 'Times 10pt gris', [PDF], { font_family: 'Times New Roman', font_size: 10, font_color: '#666666' }, false),
  T('pagenumber', 'd:7', 'vertical middle → normalizer usa bottom', [PDF], { vertical_position: 'middle' }, false),
  T('pagenumber', 'd:8', 'Solo páginas 2-end', [PDF], { pages: '2-end' }, false),
  T('pagenumber', 'd:9', 'facing_pages + first_cover', [PDF], { facing_pages: true, first_cover: true }, false),

  // -------------------------------------------------------------------------
  // 10 · pdf-ocr
  // -------------------------------------------------------------------------
  T('pdf-ocr', 'd:0', 'Default (inglés)', [PDF], {}, false),
  T('pdf-ocr', 'd:1', 'Solo español', [PDF], { ocr_languages: ['spa'] }, false),
  T('pdf-ocr', 'd:2', 'Español + inglés', [PDF], { ocr_languages: ['spa', 'eng'] }, false),
  T('pdf-ocr', 'd:3', 'Japonés', [PDF], { ocr_languages: ['jpn'] }, false),
  T('pdf-ocr', 'd:4', 'Código inválido → error API', [PDF], { ocr_languages: ['xyz'] }, true),
  T('pdf-ocr', 'd:5', 'Array vacío', [PDF], { ocr_languages: [] }, null),
  T('pdf-ocr', 'd:6', 'Param dpi desconocido', [PDF], { ocr_languages: ['eng'], dpi: 300 }, false),
];

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function toolName(toolId: string): string {
  return `ilovepdf_${toolId.replace(/-/g, '_')}`;
}

function pad(s: string, n: number): string {
  return s.length >= n ? s : s + ' '.repeat(n - s.length);
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const key = process.env.ILOVEPDF_PUBLIC_KEY;
  if (!key) {
    console.error('Error: ILOVEPDF_PUBLIC_KEY no está configurado.');
    process.exit(1);
  }

  for (const f of [PDF, PNG]) {
    if (!existsSync(f)) {
      console.warn(`Advertencia: archivo no encontrado: ${f}`);
    }
  }

  const tsxBin = join(
    PROJECT_ROOT,
    'node_modules',
    '.bin',
    process.platform === 'win32' ? 'tsx.cmd' : 'tsx',
  );

  console.log('Iniciando servidor MCP...\n');

  const transport = new StdioClientTransport({
    command: tsxBin,
    args: [join(PROJECT_ROOT, 'src', 'index.ts')],
    env: {
      ...process.env,
      ILOVEPDF_PUBLIC_KEY: key,
      ILOVEPDF_MCP_WORKDIR: WORKDIR,
    },
  });

  const client = new Client({ name: 'integration-runner', version: '1.0.0' });
  await client.connect(transport);

  interface TestResult {
    toolId: string;
    testKey: string;
    status: 'pass' | 'fail' | 'skip';
    duration: number;
    error: string | null;
  }

  const results: TestResult[] = [];
  let passed = 0, failed = 0, skipped = 0;

  for (const test of TESTS) {
    if (test.expectError === null) {
      results.push({ toolId: test.toolId, testKey: test.testKey, status: 'skip', duration: 0, error: null });
      console.log(`${pad('SKIP', 6)} ${test.toolId} / ${test.testKey}  ${test.name}`);
      skipped++;
      continue;
    }

    const start = Date.now();
    try {
      const raw = await client.callTool({
        name: toolName(test.toolId),
        arguments: {
          sources: test.sources,
          ...(Object.keys(test.params).length > 0 ? { options: test.params } : {}),
        },
      });

      const duration = Date.now() - start;
      const isError = (raw as Record<string, unknown>).isError === true;
      const status: 'pass' | 'fail' = test.expectError === isError ? 'pass' : 'fail';
      const errorMsg = isError
        ? (((raw as Record<string, unknown>).content as Array<{ text: string }>)?.[0]?.text ?? 'error')
        : null;

      results.push({ toolId: test.toolId, testKey: test.testKey, status, duration, error: errorMsg });
      console.log(`${pad(status.toUpperCase(), 6)} ${test.toolId} / ${test.testKey}  ${test.name} (${duration}ms)`);
      status === 'pass' ? passed++ : failed++;
    } catch (err) {
      const duration = Date.now() - start;
      results.push({ toolId: test.toolId, testKey: test.testKey, status: 'fail', duration, error: String(err) });
      console.log(`${pad('FAIL', 6)} ${test.toolId} / ${test.testKey}  ${test.name} — ${err}`);
      failed++;
    }
  }

  await client.close();

  const output = {
    generatedAt: new Date().toISOString(),
    workdir: WORKDIR,
    sourceFiles: { pdf: PDF, png: PNG },
    summary: { passed, failed, skipped, total: results.length },
    results,
  };

  const outFile = join(PROJECT_ROOT, 'test-results.json');
  writeFileSync(outFile, JSON.stringify(output, null, 2));

  console.log(`\n${'─'.repeat(60)}`);
  console.log(`Resultados: ${passed} ✓  ${failed} ✗  ${skipped} —  de ${results.length}`);
  console.log(`Escrito en: ${outFile}`);
  if (failed > 0) process.exit(1);
}

main().catch(err => {
  console.error('[runner] Error fatal:', err);
  process.exit(1);
});
