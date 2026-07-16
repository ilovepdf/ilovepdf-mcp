/**
 * types.ts
 *
 * Shared iLovePDF domain types for the headless MCP server.
 *
 * Ported from ../openai-app/mcp-server/src/types.ts. This headless port keeps
 * ONLY the iLovePDF API contract types (auth, task, file, process request/
 * response). All OpenAI Apps SDK / widget types (MCPResource, MCPContentItem,
 * StructuredContent*, MCPToolResponse, ToolConfig, ToolDefinition,
 * WidgetResourceMeta) and the Cloudflare Worker `CloudflareEnv` type are
 * dropped — this server returns real MCP tool results and reads config from
 * process.env.
 */

export interface ILovePDFAuth {
  token: string;
}

export interface ILovePDFTask {
  server: string;
  task: string;
  files?: Record<string, string>;
}

export interface ILovePDFFile {
  server_filename: string;
  filename: string;
  rotate?: number;
  password?: string;
}

export interface ILovePDFProcessResponse {
  download_filename: string;
  filesize: number;
  output_filesize: number;
  output_filenumber?: number;
  output_extensions?: string[];
  status?: string;
  status_message?: string;
  timer: string;
}

/** Options for iLovePDF process API */
export interface ILovePDFProcessOptions {
  files: ILovePDFFile[];
  /** Compression level for compress tool */
  compression_level?: 'low' | 'recommended' | 'extreme';
  /** Password for unlock tool */
  password?: string;
  /** Page ranges for split tool (e.g., "1-3,5,7-10") */
  ranges?: string;
  /** Watermark text */
  text?: string;
  /** Watermark mode */
  mode?: 'text' | 'image';
  /** OCR language */
  ocr_languages?: string[];
  /** Generic additional options */
  [key: string]: unknown;
}
