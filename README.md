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

**Requires Node.js 22 or newer** (see [`.node-version`](.node-version)). The MCP SDK's HTTP transport relies on the global `crypto`, which Node 18 and earlier don't expose without a flag — on those versions every request fails at runtime rather than at install time.

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
        "DATA_PORTAL_URL": "https://data.cityofnewyork.us"
      }
    }
  }
}
```

`DATA_PORTAL_URL` is optional; see [Environment variables](#environment-variables) for what leaving it unset means.

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
DATA_PORTAL_URL=https://data.cityofnewyork.us  # Optional. The default portal for a call that names none. Unset: no default (below).
SOCRATA_APP_TOKEN=                             # Optional Socrata app token, sent as X-App-Token on portal requests for higher rate limits. Without it, portals apply stricter anonymous throttling.
SKILL_POSTURE=                                 # Optional skill-guidance posture. Unset: generic web overlay only. `reference-demo`: appends the demo-posture overlay (demo limits + CTA) for web modality. See https://github.com/npstorey/civic-ai-tools/blob/main/docs/skills/README.md for the composition model.
```

**`DATA_PORTAL_URL` is optional, and absent means absent.** Set, it is the portal a tool call uses when the call names none. Unset, the server has no default portal and does not choose one on a caller's behalf: a call that names no portal — `get_data` without `domain`, `fetch` by a bare dataset id, or `search` (which takes no portal argument) — is refused, per call, with a JSON-RPC error (code `-32602`) that says how to name one. Calls that name their portal (`domain` on `get_data`; `dataset:<portal-host>:<dataset-id>` or a dataset URL on `fetch`) work either way. The tool, prompt and resource text names the configured portal, or states that none is configured. A server fronting several portals can leave it unset; the server does not start with a portal of its own.

An instance of the [civic-ai-tools website](https://github.com/npstorey/civic-ai-tools-website) that fronts a single portal sets this server's `DATA_PORTAL_URL` and the app's `SITE_DEFAULT_PORTAL` to the same portal.

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

The deployed instance at `https://socrata-mcp.civicaitools.org/mcp` powers [civicaitools.org](https://civicaitools.org). (Its Render-issued hostname is `opengov-mcp-server.onrender.com` — the service keeps its pre-rename name, as [`render.yaml`](render.yaml) notes.)

That endpoint is watched by a scheduled [deployed-endpoint smoke](.github/workflows/deployed-endpoint-smoke.yml): a daily MCP handshake at the current protocol revision, run against the live service. It exists because the two outages this server has had — a protocol-ceiling skew ([#44](https://github.com/npstorey/socrata-mcp-server/issues/44)) and a Node-runtime floor ([#47](https://github.com/npstorey/socrata-mcp-server/issues/47)) — were both host-side drift with no commit behind them, invisible to the unit suite by construction. Run it yourself with `npm run smoke:deployed`, or against another instance with `SMOKE_MCP_URL=https://your-host/mcp npm run smoke:deployed`. No credentials needed; this server requires no authentication.

To run your own hosted instance, [`render.yaml`](render.yaml) mirrors the deployed instance's Render configuration and can be used as a Render Blueprint; any host that can run `npm run build && npm start` on Node 22+ with `PORT` set will do. If you fork from `render.yaml`, you **must** change its `name:` and `domains:` values — they belong to the reference deployment. The optional `SKILL_POSTURE` env var (see [Environment variables](#environment-variables)) controls whether the reference-demo posture overlay is appended to the web skill guidance; leave it unset for a generic deployment.

## Development

```bash
npm test          # Run tests
npm run build     # Build TypeScript
npm run dev       # Start dev server
npm run lint      # Lint
```

## Related projects

This server is one of four repositories in the Civic AI Tools / Typed Standards project. Analyses run through it can be packaged as a signed, independently verifiable record; [civic-ai-tools](https://github.com/npstorey/civic-ai-tools) is the hub for that architecture.

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
