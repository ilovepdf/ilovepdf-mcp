# @ilovepdf/mcp

MCP server for [iLovePDF](https://www.ilovepdf.com/) — gives any MCP client (Claude Desktop, Cursor, etc.) direct access to iLovePDF's PDF tools via a local stdio server. Files are read from and written to your local filesystem; multi-file outputs (split, PDF-to-JPG) are saved as a single `.zip` archive.

## Requirements

- Node.js >= 18
- An iLovePDF public API key — obtain one at <https://developer.ilovepdf.com/>

## Quick start

Run without installing:

```sh
npx -y @ilovepdf/mcp
```

Or install globally:

```sh
npm install -g @ilovepdf/mcp
ilovepdf-mcp
```

The server speaks MCP over stdio. Set `ILOVEPDF_PUBLIC_KEY` before running:

```sh
ILOVEPDF_PUBLIC_KEY=project_public_xxxxxxxx npx -y @ilovepdf/mcp
```

> The server starts and lists all tools even when `ILOVEPDF_PUBLIC_KEY` is not set. The key is only required when a tool is actually called.

### Run from source (before the npm release)

Until the package is published to npm, run it from the repository. See [`docs/QUICKSTART.md`](docs/QUICKSTART.md) for the full step-by-step:

```sh
git clone https://github.com/ilovepdf/ilovepdf-mcp.git
cd ilovepdf-mcp && git checkout dev
npm install && npm run build     # produces dist/index.js
```

Then point your MCP client at the built entrypoint with an absolute path, e.g. `"command": "node", "args": ["/abs/path/to/ilovepdf-mcp/dist/index.js"]`.

## Environment variables

| Variable | Required | Default | Description |
| --- | --- | --- | --- |
| `ILOVEPDF_PUBLIC_KEY` | Yes (per-call) | — | iLovePDF public API key. The server starts without it but every tool call fails until it is set. |
| `ILOVEPDF_MCP_WORKDIR` | No | `process.cwd()` | Primary working directory. Tool inputs and outputs must live under this path (or under `ILOVEPDF_MCP_ALLOWED_DIRS`). Created automatically if it does not exist. |
| `ILOVEPDF_MCP_ALLOWED_DIRS` | No | — | Additional allowlisted roots, separated by the OS path delimiter (`:` on Unix, `;` on Windows). Non-existent entries are ignored with a warning. |
| `ILOVEPDF_MCP_RETURN_DOWNLOAD_URL` | No | `false` | `true` returns a clickable iLovePDF download link in the result. Default keeps the URL credential stripped. |
| `ILOVEPDF_MCP_EMBED_RESULT` | No | `false` | `true` also returns the output file embedded in the result for clients that support it (e.g. MCP Inspector). Left off by default for maximum client compatibility (some clients reject non-text embedded content). |
| `ILOVEPDF_MCP_MAX_INLINE_MB` | No | `10` | Size cap (MB) for the embedded file blob when `ILOVEPDF_MCP_EMBED_RESULT` is on (`0` disables embedding). |

All file access is deny-by-default. Inputs and outputs must resolve to a path inside the workdir or one of the allowed dirs. Path traversal (`../`) and symlinks that escape the root are blocked. URL inputs (`https://…`) bypass the path allowlist and are uploaded directly to iLovePDF.

## Available tools

| Tool name | Description |
| --- | --- |
| `ilovepdf_compress_pdf` | Compress a PDF to reduce file size |
| `ilovepdf_pdf_to_jpg` | Convert PDF pages to JPEG images (output: `.zip`) |
| `ilovepdf_image_to_pdf` | Convert JPG/PNG/TIFF images to PDF |
| `ilovepdf_office_to_pdf` | Convert Word, Excel, or PowerPoint to PDF |
| `ilovepdf_merge_pdf` | Combine multiple PDFs into one |
| `ilovepdf_split_pdf` | Split a PDF by page range or fixed chunks (output: `.zip`) |
| `ilovepdf_unlock` | Remove password and permission restrictions from a PDF via iLovePDF (owner-restricted PDFs are unlocked regardless of the supplied password) |
| `ilovepdf_watermark` | Add a text or image watermark to a PDF |
| `ilovepdf_pagenumber` | Add page numbers to a PDF |
| `ilovepdf_pdf_ocr` | Extract text from scanned PDFs using OCR |

> **Multi-file outputs:** `ilovepdf_split_pdf` and `ilovepdf_pdf_to_jpg` return multiple files. The server saves them as a single `.zip` archive — it does **not** extract the archive automatically.

## Client wiring

### Claude Desktop

Edit `claude_desktop_config.json`:
- macOS: `~/Library/Application Support/Claude/claude_desktop_config.json`
- Windows: `%APPDATA%\Claude\claude_desktop_config.json`

```json
{
  "mcpServers": {
    "ilovepdf": {
      "command": "npx",
      "args": ["-y", "@ilovepdf/mcp"],
      "env": {
        "ILOVEPDF_PUBLIC_KEY": "project_public_xxxxxxxx"
      }
    }
  }
}
```

To restrict file access to a specific directory, add `ILOVEPDF_MCP_WORKDIR`:

```json
{
  "mcpServers": {
    "ilovepdf": {
      "command": "npx",
      "args": ["-y", "@ilovepdf/mcp"],
      "env": {
        "ILOVEPDF_PUBLIC_KEY": "project_public_xxxxxxxx",
        "ILOVEPDF_MCP_WORKDIR": "/Users/you/Documents/pdf-workspace"
      }
    }
  }
}
```

### Cursor

Edit `~/.cursor/mcp.json` (global) or `.cursor/mcp.json` (project-local):

```json
{
  "mcpServers": {
    "ilovepdf": {
      "command": "npx",
      "args": ["-y", "@ilovepdf/mcp"],
      "env": {
        "ILOVEPDF_PUBLIC_KEY": "project_public_xxxxxxxx"
      }
    }
  }
}
```

### Generic MCP client

Any client that supports the `stdio` transport can connect using:

```json
{
  "command": "npx",
  "args": ["-y", "@ilovepdf/mcp"],
  "env": {
    "ILOVEPDF_PUBLIC_KEY": "project_public_xxxxxxxx",
    "ILOVEPDF_MCP_WORKDIR": "/path/to/working/directory",
    "ILOVEPDF_MCP_ALLOWED_DIRS": "/extra/root1:/extra/root2"
  }
}
```

Adjust `ILOVEPDF_MCP_ALLOWED_DIRS` separator to `;` on Windows.

## File access model

- **Inputs** may be local paths (resolved against the workdir) or `https://` URLs.
- **Outputs** land in the workdir by default. Pass `output_path` to each tool to choose a specific location; it must be inside the workdir or an allowed dir.
- The server creates the workdir on startup if it does not exist. Extra allowed dirs that do not exist are dropped with a warning.

## License

MIT
