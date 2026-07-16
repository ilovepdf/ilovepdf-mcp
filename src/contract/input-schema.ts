/**
 * contract/input-schema.ts
 *
 * Zod input pieces for the headless iLovePDF MCP server (TOOL-4).
 *
 * REPLACES the widget-shaped input of ../openai-app/mcp-server. That server
 * accepted files already uploaded to iLovePDF (`uploaded_files`) or referenced
 * by URL (`files`) so a ChatGPT widget could drive the lifecycle. This server
 * runs locally, so the input model shifts to LOCAL file paths.
 *
 * DROPPED vs. source: `uploadedFileSchema`, `urlFileSchema`,
 * `IlovepdfInputSchema`, `ilovepdfInputSchemaJson`.
 *
 * Exports the small building blocks consumed by `tools/input-shape.ts`:
 *   - `sourcesSchema`    — one or more non-empty local file paths (required)
 *   - `outputPathSchema` — optional destination path for the produced file
 */

import { z } from 'zod';

/**
 * Local input files to process. At least one path is required and every entry
 * must be a non-empty string. The file-io allowlist (not this schema) is what
 * enforces which paths are actually readable.
 */
export const sourcesSchema = z
  .array(z.string().min(1, 'source path must not be empty'))
  .min(1, 'at least one source file is required')
  .describe('Local file paths to process (at least one, each non-empty).');

/**
 * Optional destination path for the produced file. When omitted, the tool
 * layer chooses a default location next to the source(s).
 */
export const outputPathSchema = z
  .string()
  .min(1, 'output_path must not be empty')
  .optional()
  .describe('Optional destination path for the produced file.');
