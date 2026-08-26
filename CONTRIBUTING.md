# Contributing to Socrata MCP Server

Thank you for your interest in contributing to Socrata MCP Server! This project enables MCP clients like Claude Desktop to access open government data through Socrata APIs.

## Getting Started

### Development Environment Setup

1. **Clone the repository**:
   ```bash
   git clone https://github.com/npstorey/socrata-mcp-server.git
   cd socrata-mcp-server
   ```

2. **Install dependencies**:
   ```bash
   npm install
   ```

3. **Configure a data portal**:
   Create a `.env` file in the root directory:
   ```
   DATA_PORTAL_URL=https://data.cityofchicago.org
   ```
   You can use any Socrata-powered data portal.

4. **Build and run**:
   ```bash
   npm run build
   npm start
   ```

### Testing Your Changes

Test your changes by interacting with the server through Claude Desktop:

1. Build the project with your changes
2. Update your Claude Desktop config to point to your development version
3. Check that Claude Desktop can successfully interact with the server

## Project Structure

- `src/index.ts` - MCP server initialization and request handling
- `src/tools/socrata-tools.ts` - The unified `get_data` tool implementation
- `src/skills/` - **generated; do not hand-edit.** Committed copies of `civic-ai-tools/docs/skills/{base,local,web}.md`, emitted by that repo's `scripts/check-skill-drift.mjs --emit`. The `civic-ai-tools` CI fails on any byte-level divergence. Edit the source in `civic-ai-tools` and land the regenerated copies here as a follow-up PR.
- `src/utils/` - Helper functions and type definitions
- `src/__tests__/` - Test files

## Testing

We use Vitest for testing:

```bash
# Run all tests
npm test

# Run tests in watch mode
npm run test:watch

# Run a specific test file
npx vitest run src/__tests__/filename.test.ts
```

## Code Style

We follow standard TypeScript best practices:

- Use TypeScript with strict typing
- Format with Prettier: `npm run format`
- Lint with ESLint: `npm run lint`
- Use async/await for asynchronous operations
- Follow consistent error handling patterns

## Pull Request Guidelines

1. **Focus on a single concern**: Each PR should address one feature, improvement, or bugfix.

2. **Include tests**: Add tests that cover your changes.

3. **Update documentation**: Keep the README and code comments up to date.

4. **Follow the existing style**: Match the code style of the project.

5. **Keep PRs small and focused**: Smaller, targeted PRs are easier to review and merge.

## Feature Requests and Bug Reports

Use the GitHub issue tracker to submit:

- **Bug reports**: Include clear steps to reproduce, expected vs. actual behavior
- **Feature requests**: Explain the use case and benefits clearly

## Areas for Contribution

Here are some areas where contributions would be particularly valuable:

- Support for additional Socrata API features
- Performance improvements
- Better error handling and reporting
- Additional example use cases
- Improved documentation

## If you use Claude Code

Cloning this repo installs its checked-in Claude Code configuration: `.claude/settings.json` (a network allowlist and a sandbox block), plus the agent definitions in `.claude/agents/` and the path-scoped rules in `.claude/rules/`.

Those files are ordinary JSON and Markdown — read them before you trust them, the same as any other code you clone. Personal overrides belong in `.claude/settings.local.json`, which is gitignored.

## This is a multi-repo project

This MCP server is one part of a larger project. If you're unsure where to contribute, see the [civic-ai-tools CONTRIBUTING guide](https://github.com/npstorey/civic-ai-tools/blob/main/CONTRIBUTING.md) for an overview of all four repos.

## Commits, signing, and how we merge

This repository follows the project-wide contribution policy in the
[hub CONTRIBUTING guide](https://github.com/npstorey/civic-ai-tools/blob/main/CONTRIBUTING.md#commits-signing-and-how-we-merge), which is the canonical
text. In short:

- **Sign off every commit — required.** `git commit -s` appends a `Signed-off-by:` line (DCO 1.1;
  what it certifies is in [IPR.md](https://github.com/npstorey/civic-ai-tools/blob/main/IPR.md), adopted per
  [ADR-0017](https://github.com/npstorey/civic-ai-tools/blob/main/docs/adr/0017-ipr-posture-dco-rf-statement.md)). A required `DCO` status check
  enforces it. Forgot? `git rebase --signoff main` fixes a whole branch at once.
- **Sign your commits — encouraged, not required.** SSH or GPG, with the public key registered on your
  GitHub account. Not enforced on any branch
  ([Q74](https://github.com/npstorey/civic-ai-tools/blob/main/docs/architecture/open-questions.md#q74--should-the-default-branches-require-signed-commits)
  records why), but because we never rewrite your commits, your signature is what stays on `main`.
- **Rebase into atomic commits before requesting review.** Each commit should build and pass tests on
  its own. We do not squash at merge time, so your branch lands exactly as you shaped it — and that is
  what keeps `git bisect` useful.
- **We merge with merge commits — never squash, never rebase.** Squash and rebase merges rewrite
  commits, so what lands on `main` is a new object: your signature is replaced by GitHub's and your
  per-commit sign-offs collapse into one commit body. A merge commit is the only method that leaves
  your commits on `main` as the objects you actually made and signed. Reasoning and costs:
  [ADR-0027](https://github.com/npstorey/civic-ai-tools/blob/main/docs/adr/0027-merge-commit-only-vcs-policy.md). To read `main` as one entry per
  pull request, use `git log --first-parent`.

The project's patent posture is the royalty-free statement at [PATENTS.md](https://github.com/npstorey/civic-ai-tools/blob/main/PATENTS.md).

## License

By contributing to this project, you agree that your contributions will be licensed under the project's MIT License.