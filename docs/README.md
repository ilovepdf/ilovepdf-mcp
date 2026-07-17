# ilovepdf-mcp — Documentation

`ilovepdf-mcp` is a **headless, client-agnostic iLovePDF MCP server** distributed as `npx -y @ilovepdf/mcp`. It speaks the Model Context Protocol over **stdio** and exposes 10 iLovePDF PDF tools — one per registry operation, generated data-drivenly. Each tool resolves local-path or URL inputs, uploads them to the iLovePDF v1 API, and downloads the produced file to an allowlisted local directory, returning a structured MCP result with metrics.

For setup, client wiring (Claude Desktop, Cursor, etc.), and API-key configuration see the root **[README.md](../README.md)**.

---

## Documents

| Document | What it covers |
|---|---|
| [architecture.md](./architecture.md) | Layered module diagram, registry-driven tool-generation diagram, the 10 tools table, request lifecycle sequence diagram, stdout/stderr discipline, error model (11 `ErrorCode` values), result contract, and tech stack. |
| [security.md](./security.md) | Threat model, trust boundaries, file-IO allowlist and `resolveWithin` decision flow, network egress / SSRF guard diagram (SSRF-1..SSRF-6), credential handling (DEC-4 token stripping, DEC-5 minimal disclosure, audit-logger redaction, env hygiene), and accepted v1 residuals. |
| [deployment.md](./deployment.md) | Where each component runs (local server vs. iLovePDF cloud API), how the stdio protocol travels, why local/stdio was chosen over remote Streamable HTTP, best practices, and the PDF tooling landscape. |

---

## Authoritative specification

The technical documents in this `docs/` folder are the reference for the project's capabilities, design decisions, and security requirements. [architecture.md](./architecture.md) and [security.md](./security.md) cover the annotated requirements (TOOL-*, FIO-*, SSRF-*, ERR-*, LOG-*, ENV-*) in detail.

---

## Diagrams

All diagrams in `architecture.md` and `security.md` are **GitHub-native Mermaid** (`mermaid` fenced code blocks rendered directly by GitHub). No external tooling required to view them.

The `diagrams/` subdirectory contains `.mmd` source files and pre-rendered `.png` images used by older doc versions. To regenerate a PNG:

```bash
cd docs/diagrams
npx -y @mermaid-js/mermaid-cli -i <name>.mmd -o <name>.png -b white -s 2 -p .puppeteer.json
```
