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

To run your own hosted instance, [`render.yaml`](render.yaml) mirrors the deployed instance's Render configuration and can be used as a Render Blueprint; any host that can run `npm run build && npm start` on Node 22+ with `PORT` set will do. If you fork from `render.yaml`, you **must** change its `name:` and `domains:` values — they belong to the reference deployment. The optional `SKILL_POSTURE` env var (see [Environment variables](#environment-variables)) controls whether the reference-demo posture overlay is appended to the web skill guidance; leave it unset for a generic deployment. To run it as a container instead, see [Run in a container](#run-in-a-container).

## Run in a container

The [`Dockerfile`](Dockerfile) builds the HTTP transport as an image: a multi-stage build (`npm ci`, then the same `clean` and `build:tsc` steps CI runs), a runtime stage with production dependencies only, running as the image's non-root `node` user with `NODE_ENV=production`. It serves `/mcp` and `/healthz` on `PORT` (8000 unless set).

```bash
docker build -t socrata-mcp-server .
docker run --rm -p 8000:8000 -e DATA_PORTAL_URL=https://data.cityofnewyork.us socrata-mcp-server
curl -fsS http://127.0.0.1:8000/healthz
```

The base image is a build argument, `NODE_IMAGE` (default `node:22-bookworm-slim`), so a deployment pipeline can substitute its own Node 22 image: `docker build --build-arg NODE_IMAGE=<your-image> .`. Nothing enters the image at build time but the source and the lockfile ([`.dockerignore`](.dockerignore) keeps `.env*`, `node_modules`, `dist`, `.git` and tests out of the build context); every setting below is read at run time from the container's environment.

**Settings.** All optional.

| Variable | What it does |
| --- | --- |
| `PORT` | The port the HTTP transport listens on. Default 8000, which is the port the image exposes. |
| `DATA_PORTAL_URL` | The default portal for a call that names none, e.g. `https://data.cityofnewyork.us`. Unset: no default, and such a call is refused per call (see [Environment variables](#environment-variables)). An instance behind a single-portal deployment of the [civic-ai-tools website](https://github.com/npstorey/civic-ai-tools-website) sets this to the same portal as the app's `SITE_DEFAULT_PORTAL`. |
| `SOCRATA_APP_TOKEN` | Sent as `X-App-Token` on every portal request, for the portal's higher rate limit. Without it, portals apply their anonymous throttle. |
| `SKILL_POSTURE` | Skill-guidance posture overlay. Leave unset for a generic deployment. |
| `ROW_FETCH_CAP` | Most rows a single "all rows" request will fetch across pages. Default 100000. |
| `MAX_RAW_ROWS` | Most rows a non-aggregating query returns. Default 10000. |
| `HTTP_PROXY`, `HTTPS_PROXY`, `NO_PROXY` | The egress proxy for portal calls, below. |

**This server has no authentication.** Anything that can reach the port can query portals through it, so it belongs on a private network: an ECS service or a compose stack the application reaches by an internal name, not a public listener. The application in front of it then names this server's host in **its own** `NO_PROXY`, so that its calls to the server stay inside the network rather than being sent to the egress proxy; the server needs no such entry for itself. `/healthz` answers 200 and is the path to give the orchestrator's health check (an ECS task definition's `healthCheck`, Render's `healthCheckPath`); the image declares no `HEALTHCHECK` of its own, because the slim image has no `curl` and a probe would cost a Node process every interval. The server writes no file, so it runs under a read-only root filesystem (`docker run --read-only`); CI measures that, the non-root user and `/healthz` on every change, in the `container-image` job.

**Through an egress proxy.** On a network where outbound traffic must leave through a proxy, set the conventional three and portal calls go through a `CONNECT` tunnel to it:

```bash
HTTPS_PROXY=http://proxy.internal:3128
HTTP_PROXY=http://proxy.internal:3128
NO_PROXY=.internal.example
```

With none of them set nothing is installed and every call is direct, exactly as before these existed. The lower-case spellings are read too and win when both are set; an `https://` destination uses `HTTPS_PROXY` and falls back to `HTTP_PROXY`; `localhost`, `127.0.0.1` and `[::1]` are always exempt and `NO_PROXY` is added to that (entries are exact hosts, or suffixes when they begin with `.` or `*`, optionally `:port`). A proxy address that carries a user and password (`http://user:pass@proxy`) is honoured, sent as `Proxy-Authorization` on the tunnel request, and never logged, but prefer one without: the address is readable by anything that can read the container's environment. A proxy that re-signs TLS is trusted the way Node trusts any private authority, through `NODE_EXTRA_CA_CERTS`. This needs code because axios, this server's HTTP client, reads the same variables but sends `https://` requests to the proxy as plain requests rather than opening a tunnel, which a proxy that admits HTTPS only through `CONNECT` refuses; [`src/utils/outbound-proxy.ts`](src/utils/outbound-proxy.ts) carries the measurement. To see it work locally, run the repository's CONNECT-only proxy and point the container at it:

```bash
node scripts/connect-only-proxy.mjs &      # on the host, 127.0.0.1:3128
docker run --rm -p 8000:8000 -e HTTPS_PROXY=http://host.docker.internal:3128 socrata-mcp-server
node scripts/mcp-portal-call.mjs http://127.0.0.1:8000/mcp data.cityofnewyork.us
```

The proxy prints one `CONNECT data.cityofnewyork.us:443` line per tunnel and `refused` for any plain request it is sent. CI runs the same call from a network whose only way out is that proxy.

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
