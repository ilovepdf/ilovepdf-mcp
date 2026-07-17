# Quick Start — try `@ilovepdf/mcp` from source

Pre-release trial guide (before the package is published to npm).

- **Version:** 0.1.0
- **Branch:** `staging`
- **Transport:** local stdio MCP server (runs on your machine; no hosting, no ports)

## Prerequisites

- **Node.js >= 18** (`node -v`)
- **git**
- An **iLovePDF public API key** — get one at <https://developer.ilovepdf.com/>
- An MCP-compatible client: **Claude Desktop**, **Cursor**, **opencode**, or the **MCP Inspector**

## 1. Get the code and build

```sh
git clone https://github.com/ilovepdf/ilovepdf-mcp.git
cd ilovepdf-mcp
git checkout staging
npm install
npm run build          # compiles to dist/  (dist/index.js is the server)
```

Optional sanity check (should start and wait for MCP frames; Ctrl+C to exit):

```sh
node dist/index.js
```

## 2. Wire it into your MCP client

Use an **absolute path to `dist/index.js`** and a **stable Node binary** (avoid version-manager shims for GUI apps).

### Claude Desktop

Edit `claude_desktop_config.json`
(Windows: `%APPDATA%\Claude\claude_desktop_config.json` · macOS: `~/Library/Application Support/Claude/claude_desktop_config.json`):

```json
{
  "mcpServers": {
    "ilovepdf": {
      "command": "C:\\Program Files\\nodejs\\node.exe",
      "args": ["C:\\path\\to\\ilovepdf-mcp\\dist\\index.js"],
      "env": {
        "ILOVEPDF_PUBLIC_KEY": "project_public_xxxxxxxx",
        "ILOVEPDF_MCP_WORKDIR": "C:\\path\\to\\a\\pdf-workspace"
      }
    }
  }
}
```

On macOS/Linux use `"command": "node"` (or the absolute node path) and forward-slash paths.

**Restart the client completely** after editing the config so it reloads the server.

### Cursor / opencode / other stdio clients

Same shape: `command` = node, `args` = `[".../dist/index.js"]`, `env` = the variables above.

## 3. Test it

In the client, point at a file **inside the workdir** (do not upload an attachment — the server works on local files):

```
Compress C:\path\to\a\pdf-workspace\sample.pdf with the iLovePDF MCP and give me the download link.
```

Expected: the tool runs and reports the size reduction and the output path. With `ILOVEPDF_MCP_RETURN_DOWNLOAD_URL=true` (see below) it also returns a clickable download link.

## Environment variables

| Variable | Required | Default | Description |
| --- | --- | --- | --- |
| `ILOVEPDF_PUBLIC_KEY` | Yes (per call) | — | Your iLovePDF public API key. |
| `ILOVEPDF_MCP_WORKDIR` | No | `cwd` | Allowlist root for inputs/outputs (created if missing). |
| `ILOVEPDF_MCP_ALLOWED_DIRS` | No | — | Extra allowlisted roots (`;` on Windows, `:` on Unix). |
| `ILOVEPDF_MCP_RETURN_DOWNLOAD_URL` | No | `false` | `true` → return a clickable iLovePDF download link in the result. |
| `ILOVEPDF_MCP_EMBED_RESULT` | No | `false` | `true` → also return the output file embedded in the result (for clients that support it, e.g. MCP Inspector). Leave off for Claude Desktop. |
| `ILOVEPDF_MCP_MAX_INLINE_MB` | No | `10` | Size cap (MB) for the embedded file blob when `EMBED_RESULT` is on. |

## Notes

- **Local files:** the server reads/writes files under the workdir (or `ALLOWED_DIRS`). Inputs may also be `https://` URLs. It never overwrites an input file.
- **Multi-file outputs** (`split_pdf`, `pdf_to_jpg`) are saved as a single `.zip`.
- **10 tools:** compress, pdf-to-jpg, image-to-pdf, office-to-pdf, merge, split, unlock, watermark, pagenumber, pdf-ocr.
- **Verified clients:** Claude Desktop, MCP Inspector, opencode.
