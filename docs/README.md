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

The testable capability requirements and all design decisions live under [`openspec/specs/`](../openspec/specs/):

| Spec file | Covers |
|---|---|
| [`operations-registry.md`](../openspec/specs/operations-registry.md) | Registry SSOT, 10-op invariants |
| [`tool-generation-and-result-contract.md`](../openspec/specs/tool-generation-and-result-contract.md) | TOOL-1..TOOL-9: tool naming, input shape, result contract, failure surface |
| [`file-io-allowlist.md`](../openspec/specs/file-io-allowlist.md) | FIO-1..FIO-8: allowlist config, path canonicalization, symlink defense |
| [`network-egress-ssrf.md`](../openspec/specs/network-egress-ssrf.md) | SSRF-1..SSRF-6: scheme allow-list, IP range deny-list, DNS check, redirect re-validation, host allow-list |
| [`error-model.md`](../openspec/specs/error-model.md) | ERR-1..ERR-8: ToolError contract, retry behaviours, user-facing text rules |
| [`transport-and-logging.md`](../openspec/specs/transport-and-logging.md) | LOG-1..LOG-6: stdio bootstrap, stdout isolation, stderr-only logging, redaction |
| [`env-and-key-config.md`](../openspec/specs/env-and-key-config.md) | ENV-1..ENV-6: ILOVEPDF_PUBLIC_KEY, WORKDIR, ALLOWED_DIRS |

The archived design and verify reports are at [`openspec/changes/archive/mcp-headless-core/`](../openspec/changes/archive/mcp-headless-core/).

**openspec is the source of truth.** When this `docs/` folder and the specs disagree, the specs win.

---

## Diagrams

All diagrams in `architecture.md` and `security.md` are **GitHub-native Mermaid** (`mermaid` fenced code blocks rendered directly by GitHub). No external tooling required to view them.

The `diagrams/` subdirectory contains `.mmd` source files and pre-rendered `.png` images used by older doc versions. To regenerate a PNG:

```bash
cd docs/diagrams
npx -y @mermaid-js/mermaid-cli -i <name>.mmd -o <name>.png -b white -s 2 -p .puppeteer.json
```
