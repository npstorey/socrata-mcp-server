# Socrata MCP Server

A [Model Context Protocol (MCP)](https://modelcontextprotocol.io/) server that connects AI tools to open data on any [Socrata](https://www.tylertech.com/products/socrata)-powered portal — including NYC, Chicago, San Francisco, and hundreds of other cities.

> **Formerly known as opengov-mcp-server.** Renamed to avoid confusion with OpenGov Inc.

## What it does

This server gives AI assistants (Claude, Copilot, Cursor, Codex) direct access to public datasets via Socrata's open data API. Instead of the AI guessing at data, it can query real civic data in real time.

**Example queries an AI can answer with this server:**
- "What are the top 311 complaint types in Brooklyn this month?"
- "Show me restaurant inspection trends in Manhattan"
- "Compare crime data across Chicago neighborhoods"

## Quick start

### Use with npx (no install needed)

```bash
npx socrata-mcp-server --stdio
```

### Claude Desktop configuration

Add this to your Claude Desktop config (`~/Library/Application Support/Claude/claude_desktop_config.json` on macOS):

```json
{
  "mcpServers": {
    "socrata": {
      "command": "npx",
      "args": ["-y", "socrata-mcp-server", "--stdio"],
      "env": {
        "DEFAULT_DOMAIN": "data.cityofnewyork.us"
      }
    }
  }
}
```

### Development

```bash
git clone https://github.com/npstorey/socrata-mcp-server.git
cd socrata-mcp-server
npm install
npm run build
npm run dev   # Starts on http://localhost:10000 (with PORT=10000 from .env)
```

### Environment variables

```bash
# .env
PORT=10000                                     # Project convention (local dev + Render). The code falls back to 8000 if PORT is unset.
DATA_PORTAL_URL=https://data.cityofnewyork.us  # Default portal (optional)
SOCRATA_APP_TOKEN=                             # Optional Socrata app token, sent as X-App-Token on portal requests for higher rate limits. Without it, portals apply stricter anonymous throttling.
```

## Available tools

| Tool | Description |
|------|-------------|
| `get_data` | Unified data access: catalog search, metadata lookup, SoQL queries, and dataset metrics |
| `search` | Search for datasets or records, returns ID/score pairs |
| `fetch` | Retrieve full dataset metadata or records by ID |

### Skill guidance

The server also serves composed skill guidance to clients via the MCP `prompts/get` endpoint (`skill-guidance` prompt). **`src/skills/*.ts` are generated, not authored here** — the source of truth is [`civic-ai-tools/docs/skills/`](https://github.com/npstorey/civic-ai-tools/tree/main/docs/skills), and that repo's CI byte-compares the two. Guidance changes start with a PR to that repo.

## Supported portals

Works with any Socrata-powered open data portal. Some popular ones:

| City | Portal |
|------|--------|
| New York City | `data.cityofnewyork.us` |
| Chicago | `data.cityofchicago.org` |
| San Francisco | `data.sfgov.org` |
| Seattle | `data.seattle.gov` |
| Los Angeles | `data.lacity.org` |

## Transport

- **stdio** — For local use with Claude Code, Cursor, and VS Code Copilot
- **HTTP (Streamable HTTP)** — For web applications. Endpoint: `POST /mcp`

The deployed instance at `https://socrata-mcp-server.onrender.com` powers [civicaitools.org](https://civicaitools.org).

To run your own hosted instance, [`render.yaml`](render.yaml) mirrors the deployed instance's Render configuration and can be used as a Render Blueprint; any host that can run `npm run build && npm start` with `PORT` set will do.

## Development

```bash
npm test          # Run tests
npm run build     # Build TypeScript
npm run dev       # Start dev server
npm run lint      # Lint
```

## Related projects

This server is one of four repositories in the Civic AI Tools / Typed Standards project. Analyses run through it can be packaged as signed, independently verifiable evidence; [civic-ai-tools](https://github.com/npstorey/civic-ai-tools) is the hub for that architecture.

| Repository | Description |
|-----------|-------------|
| [civic-ai-tools](https://github.com/npstorey/civic-ai-tools) | Starter project that bundles this server with Data Commons MCP for multi-source civic data queries |
| [civic-ai-tools-website](https://github.com/npstorey/civic-ai-tools-website) | Demo website at [civicaitools.org](https://civicaitools.org) — side-by-side comparison of AI with and without live data |
| [typedstandards](https://github.com/npstorey/typedstandards) | The Typed Standards home — verification/producer cores and [typedstandards.org](https://typedstandards.org) |
| [odp-mcp](https://github.com/socrata/odp-mcp) | Socrata's official MCP server (similar functionality, different implementation) |

## Contributing

Contributions are welcome! See [CONTRIBUTING.md](CONTRIBUTING.md) for guidelines.

## Disclaimer

This is a personal project and is not affiliated with, endorsed by, or representative of any employer or organization.

## License

MIT
