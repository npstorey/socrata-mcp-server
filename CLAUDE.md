# CLAUDE.md — Socrata MCP Server

MCP server for open data on Socrata-powered portals. Two transports: stdio (local CLI
clients) and Streamable HTTP (web clients). The reference deployment runs on Render at
`https://socrata-mcp.civicaitools.org/mcp` and powers the live demo at civicaitools.org;
its Render-issued hostname is still the pre-rename `opengov-mcp-server.onrender.com`.

Tool surface: `SOCRATA_TOOLS` in `src/tools/socrata-tools.ts`, registered in
`src/index.ts`. Read those rather than a list here.

## Strategic context — what not to include in this repo

This repo is public. Strategic and relationship context — named external stakeholders,
prospective collaborators, pre-meeting strategy, private outreach plans, individuals'
opinions or quotes — lives in local-only planning docs outside this repo, not here.

In code, docs, commit messages, issue bodies, PR descriptions, or starter prompts
destined for this repo, use neutral phrasing: "an external stakeholder," "an upcoming
demo," "a follow-up meeting." Scrub strategic context out of a task prompt before
producing anything that lands here.

## Secret hygiene

Never `cat`, `head`, `tail`, or otherwise dump `.env*`, `auth.json`, `credentials*`, `*.pem`,
`*.key`, or anything under `~/.ssh` or `~/.aws`. Two reads are permitted: a field-scoped read
by key **name** (`grep '^VAR_NAME=' .env.local`), or a command the tool itself exposes. Never
load-and-print a credentials file, even through a redaction filter.
<!-- civic-ai-tools#174: a redaction filter one nesting level too high printed a live bearer token in full; rotation took a server-side revoke, not a local logout -->

## Build / test

Node is pinned in `.node-version` (22); CI reads that file. Under a version manager a
non-interactive shell has no `node` on `PATH` — load it first: `eval "$(fnm env)" && fnm use 22`.
<!-- the sibling repo's ts#52 gate: every step exited 127 on a green branch and was reported as a failing gate -->

The three CI gates (`.github/workflows/ci.yml`), with what a pass looks like:

- `npm run clean && npm run build:tsc` — `tsc --outDir dist`, silent on success. CI runs
  those two pieces rather than `npm run build`, whose `prebuild-check` step dumps ~1,100
  lines of SDK diagnostics and produces no artifacts.
- `npm test` — `Test Files 15 passed | 2 skipped (17)`, `Tests 92 passed | 9 skipped (101)`.
  The 9: 6 live-API integration tests behind `RUN_INTEGRATION=1` (`npm run
  test:integration`), and 3 hardcoded `.skip`s in the transport-sequence tests.
- `npm run lint` — a pass here is **`✖ 117 problems (0 errors, 117 warnings)`** with
  exit 0. The warnings are pre-existing; don't clear them as a side effect of another
  change.
  <!-- measured 2026-08-22: a green lint here is not silent, and reading the ✖ line as failure invites an out-of-scope sweep -->

`npm run dev` runs the built `dist/` with dotenv loaded, so build first.

## Environment

- `DATA_PORTAL_URL` — **required**; any Socrata portal, e.g.
  `https://data.cityofnewyork.us`. `src/utils/portal-info.ts` throws when it is unset.
- `PORT` — HTTP transport port. Default **8000** in code (`src/index.ts`); the Render
  deployment supplies its own.
- `SKILL_POSTURE` — optional; deployment posture overlay. Semantics in
  [`.claude/rules/skills.md`](.claude/rules/skills.md).

## Architecture

- `src/index.ts` — entry point: tool/prompt/resource handlers, both transports.
- `src/openai-compatible-transport.ts` — HTTP transport wrapper (session injection for
  header-less clients) over the SDK's Streamable HTTP transport.
- `src/skills/` — **generated; do not hand-edit.** The sync rule is in
  [`.claude/rules/skills.md`](.claude/rules/skills.md).
- `src/tools/`, `src/utils/`, `src/schema/` — tool schemas and handlers; Socrata API
  client, cache and portal metadata; shared request schemas.

Cross-repo architecture documents and spec drafts live in the hub repo at
[`civic-ai-tools/docs/architecture/`](https://github.com/npstorey/civic-ai-tools/tree/main/docs/architecture)
— this server is L1 of the standards stack; the hub also holds skill sources and MCP configs, and
[civic-ai-tools-website](https://github.com/npstorey/civic-ai-tools-website) is the demo site. Before
changing a tool schema or response shape, check whether the spec or `open-questions.md` constrains it.

## Merges and sign-off

Work lands via PRs to `main`; never push to `main`. `git commit -s` on every commit —
the `Signed-off-by:` email must match the commit author email exactly, or DCO fails
(absence is not the only way to fail it). See [CONTRIBUTING.md](CONTRIBUTING.md).
