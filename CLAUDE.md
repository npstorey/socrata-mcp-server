# Claude Project Primer - Socrata MCP Server

## Project overview

MCP server for accessing open data on Socrata-powered portals. Supports stdio and HTTP (Streamable HTTP) transports.

## Strategic context — what not to include in this repo

This repo is public. Strategic and relationship context — specific external stakeholders, prospective collaborators, pre-meeting strategy, private outreach plans, named individuals' opinions or quotes — lives in local-only planning docs outside this repo (workspace `CLAUDE.md`, `ROADMAP.md`, per-user auto-memory), not here.

When contributing code, docs, commit messages, issue bodies, PR descriptions, or starter prompts for implementation chats that will commit to this repo, use neutral phrasing: "an external stakeholder," "an upcoming demo," "a follow-up meeting" — not specific names. If a task prompt you received includes strategic context, scrub it before producing any content destined for this repo.

## Key commands

```bash
npm run build     # Clean build (tsc)
npm run dev       # Start locally on http://localhost:10000
npm run start     # Production mode
npm test          # Run tests (vitest)
```

## Architecture

- `src/index.ts` — Server entry point, tool/prompt/resource handlers
- `src/mcp/tools/socrata.ts` — Socrata API tool implementations
- `src/mcp/transport/streamableHttp.ts` — HTTP transport with session management
- `src/tools/socrata-tools.ts` — Tool schema definitions
- `src/utils/api.ts` — Socrata API client
- `src/utils/portal-info.ts` — Portal metadata utilities

## Tools

| Tool | Purpose |
|------|---------|
| `get_data` | Unified access: catalog search, metadata, SoQL queries, metrics |
| `search` | Search datasets/records, returns ID/score pairs |
| `fetch` | Retrieve full metadata/records by ID |

## Environment

```bash
PORT=10000
DATA_PORTAL_URL=https://data.cityofnewyork.us
```

## Deployment

- Deployed on Render: `https://socrata-mcp-server.onrender.com`
- Powers the live demo at [civicaitools.org](https://civicaitools.org)

## Architecture documentation

Cross-repo architecture documents and spec drafts live in the hub repo at [`civic-ai-tools/docs/architecture/`](https://github.com/npstorey/civic-ai-tools/tree/main/docs/architecture). The Open Evidence Standard governs the shape of evidence packages produced from MCP tool calls (this server is L1 of the standards stack — see `end-state-vision.md` §1). When changing tool schemas, response shapes, or trace-relevant attributes (`mcp.source`, etc.), check whether the change is constrained by spec sections or by open questions in [`open-questions.md`](https://github.com/npstorey/civic-ai-tools/blob/main/docs/architecture/open-questions.md). Both spec drafts are internal working drafts (pre-v0.1, not for external review).

## Related repos

| Repo | Purpose |
|------|---------|
| [civic-ai-tools](https://github.com/npstorey/civic-ai-tools) | Starter project, MCP configs, skill docs |
| [civic-ai-tools-website](https://github.com/npstorey/civic-ai-tools-website) | Demo website |
