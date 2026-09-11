/**
 * No default names a portal (server#63; civic-ai-tools-website#434, ruling D6 = B).
 *
 * This server's default portal is configuration: `DATA_PORTAL_URL`, read per call through
 * `src/utils/portal-config.ts`, and absent means there is none. This guard keeps a portal from
 * coming back as a code default by any of the three routes one has taken or could take:
 *
 *   1. A host written into source. `FALLBACK_PORTAL_URL` was a string literal naming one city,
 *      and every portal-less call silently ran against it.
 *   2. A load-time snapshot of the variable. `src/utils/api.ts` read `DATA_PORTAL_URL` in its
 *      module body as a second default layer, before `src/index.ts` had run `dotenv.config()`.
 *   3. A request made without the caller's portal. `fetchFromSocrataApi` defaulted its
 *      `baseUrl` to that snapshot, so a call site that omitted it inherited a default.
 *
 * THE UNIVERSE IS DERIVED, NOT LISTED. Every file `git ls-files` reports with a
 * JavaScript/TypeScript-family extension, minus two classes, each excluded by a property of
 * the file rather than by its name:
 *   - tests — a `__tests__/` or top-level `test/` path, or a `.test.`/`.spec.` basename. A test
 *     that sets a portal configures one explicitly, which is configuration, not a default;
 *   - generated files — a header (first five lines) declaring `do not hand-edit`. The skill
 *     catalogue in `src/skills/` names several portals on purpose and is emitted from the hub
 *     repository (`.claude/rules/skills.md`); the marker, not the directory, excludes it.
 * A source file added anywhere, including under a directory that does not exist yet, is in the
 * universe. `scripts/` is in it, which is why ALLOWED_HOSTS has entries.
 *
 * WHAT IT READS. String and template-literal text, through the TypeScript parser, so a host in
 * a comment is prose and never counted; and the call and property-access shapes of the AST.
 *
 * ALLOWED_HOSTS holds hosts that are not portals, each with its reason. The check is
 * bidirectional: an entry that no longer matches anything in the universe fails, so the list
 * cannot outlive its reason.
 *
 * STATED BLIND SPOTS.
 *   - A host assembled at run time from pieces (`'data.' + city + '.gov'`).
 *   - A bare host of fewer than three labels written without a scheme (`example.org`). With a
 *     scheme (`https://example.org`) it is caught.
 *   - A bare host spelled with capitals. Inside a URL, case does not matter.
 *   - A default read from an environment variable under another name.
 *   - Tracked files outside the JS/TS family (JSON, YAML, Markdown). `render.yaml` names the
 *     variable and never its value; README examples are documentation, not defaults.
 *   - Files not yet tracked by git — the universe is what `git ls-files` reports, so a run
 *     before `git add` does not see a new file. CI checks out committed files only.
 */

import { describe, it, expect } from 'vitest';
import ts from 'typescript';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = execFileSync('git', ['rev-parse', '--show-toplevel'], {
  cwd: fileURLToPath(new URL('.', import.meta.url)),
  encoding: 'utf8'
}).trim();

/** Hosts that are not portals and may appear in source, each with the reason it is here. */
const ALLOWED_HOSTS: Record<string, string> = {
  'socrata-mcp.civicaitools.org':
    "The reference deployment's own MCP endpoint. scripts/smoke-deployed-endpoint.mjs is the monitor for that deployment and probes it by design (SMOKE_MCP_URL overrides it). It is this server's address, not a portal, and no tool call is ever routed to it.",
  'github.com':
    "This repository's URL, in the smoke script's User-Agent string. Not a portal."
};

const PORTAL_VARIABLE = 'DATA_PORTAL_URL';
const REQUEST_HELPER = 'fetchFromSocrataApi';
const BASE_URL_ARGUMENT_POSITION = 3;

const SOURCE_EXTENSION = /\.(?:ts|mts|cts|js|mjs|cjs)$/;
const TEST_PATH = /(?:^|\/)__tests__\/|^test\/|\.(?:test|spec)\.[cm]?[jt]s$/;
const GENERATED_MARKER = /do not hand-edit/i;
const HEADER_LINES = 5;

type Universe = { scanned: string[]; tests: string[]; generated: string[] };

function deriveUniverse(): Universe {
  const tracked = execFileSync('git', ['ls-files', '-z'], { cwd: ROOT, encoding: 'utf8' })
    .split('\0')
    .filter((file) => SOURCE_EXTENSION.test(file));
  const universe: Universe = { scanned: [], tests: [], generated: [] };
  for (const file of tracked) {
    if (TEST_PATH.test(file)) {
      universe.tests.push(file);
      continue;
    }
    const header = readFileSync(join(ROOT, file), 'utf8').split('\n').slice(0, HEADER_LINES).join('\n');
    if (GENERATED_MARKER.test(header)) {
      universe.generated.push(file);
      continue;
    }
    universe.scanned.push(file);
  }
  return universe;
}

// --- The detectors. Pure functions of (file name, source text), so the decoys below drive the
// --- very code the tree assertions run.

/** `scheme://host` in any literal, whatever the host's shape or top-level domain. */
const URL_HOST = /\b[a-z][a-z0-9+.-]*:\/\/([^\s/'"`<>?#:@{}$]+)/gi;
/** A bare lowercase host of three or more labels, e.g. a portal host written without a scheme. */
const BARE_HOST = /(?<![\w.@/-])(?:[a-z0-9-]+\.){2,}[a-z]{2,}(?![\w.-])/g;
const HOSTNAME = /^(?:[a-z0-9-]+\.)+[a-z]{2,}$/i;

export function hostsIn(text: string): string[] {
  const found = new Set<string>();
  for (const match of text.matchAll(URL_HOST)) {
    const host = match[1].toLowerCase();
    if (HOSTNAME.test(host)) found.add(host);
  }
  for (const match of text.matchAll(BARE_HOST)) found.add(match[0]);
  return [...found];
}

type Finding = { file: string; line: number; detail: string };

function parse(file: string, text: string): ts.SourceFile {
  return ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
}

function lineOf(source: ts.SourceFile, node: ts.Node): number {
  return source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1;
}

function walk(node: ts.Node, visit: (node: ts.Node) => void): void {
  visit(node);
  ts.forEachChild(node, (child) => walk(child, visit));
}

/** Every host spelled inside a string or template literal. Comments are not literals. */
export function hostLiterals(file: string, text: string): Finding[] {
  const source = parse(file, text);
  const findings: Finding[] = [];
  walk(source, (node) => {
    if (
      ts.isStringLiteral(node) ||
      ts.isNoSubstitutionTemplateLiteral(node) ||
      ts.isTemplateHead(node) ||
      ts.isTemplateMiddle(node) ||
      ts.isTemplateTail(node)
    ) {
      for (const host of hostsIn(node.text)) {
        findings.push({ file, line: lineOf(source, node), detail: host });
      }
    }
  });
  return findings;
}

function isProcessEnv(node: ts.Node): boolean {
  return (
    ts.isPropertyAccessExpression(node) &&
    node.name.text === 'env' &&
    ts.isIdentifier(node.expression) &&
    node.expression.text === 'process'
  );
}

function namesVariable(node: ts.Node | undefined): boolean {
  return !!node && (ts.isIdentifier(node) || ts.isStringLiteralLike(node)) && node.text === PORTAL_VARIABLE;
}

function readsPortalVariable(node: ts.Node): boolean {
  if (ts.isPropertyAccessExpression(node) && isProcessEnv(node.expression) && node.name.text === PORTAL_VARIABLE) {
    return true;
  }
  if (ts.isElementAccessExpression(node) && isProcessEnv(node.expression) && namesVariable(node.argumentExpression)) {
    return true;
  }
  if (
    ts.isVariableDeclaration(node) &&
    ts.isObjectBindingPattern(node.name) &&
    node.initializer !== undefined &&
    isProcessEnv(node.initializer)
  ) {
    return node.name.elements.some((element) => namesVariable(element.propertyName ?? element.name));
  }
  return false;
}

function insideFunction(node: ts.Node): boolean {
  for (let parent = node.parent; parent; parent = parent.parent) {
    if (ts.isFunctionLike(parent)) return true;
  }
  return false;
}

/**
 * Every read of `DATA_PORTAL_URL` that runs when the module loads rather than when it is
 * called. A class field initializer counts as load time here, which is conservative.
 */
export function loadTimeReads(file: string, text: string): Finding[] {
  const source = parse(file, text);
  const findings: Finding[] = [];
  walk(source, (node) => {
    if (readsPortalVariable(node) && !insideFunction(node)) {
      findings.push({ file, line: lineOf(source, node), detail: node.getText(source).slice(0, 80) });
    }
  });
  return findings;
}

/** Every call to the request helper, with how many arguments it passes. */
export function requestHelperCalls(file: string, text: string): Array<Finding & { argumentCount: number }> {
  const source = parse(file, text);
  const calls: Array<Finding & { argumentCount: number }> = [];
  walk(source, (node) => {
    if (!ts.isCallExpression(node)) return;
    const callee = node.expression;
    const name = ts.isIdentifier(callee)
      ? callee.text
      : ts.isPropertyAccessExpression(callee)
        ? callee.name.text
        : undefined;
    if (name !== REQUEST_HELPER) return;
    calls.push({
      file,
      line: lineOf(source, node),
      detail: node.getText(source).split('\n')[0].slice(0, 80),
      argumentCount: node.arguments.length
    });
  });
  return calls;
}

function format(findings: Finding[]): string {
  return findings.map((f) => `${f.file}:${f.line}  ${f.detail}`).join('\n');
}

describe('no default names a portal — over a universe derived from git', () => {
  const universe = deriveUniverse();
  const sources = universe.scanned.map((file) => ({ file, text: readFileSync(join(ROOT, file), 'utf8') }));

  it('derives a universe that reaches past src/, excludes tests, and excludes generated files by their marker', () => {
    expect(universe.scanned).toContain('src/index.ts');
    expect(universe.scanned).toContain('src/utils/portal-config.ts');
    expect(universe.scanned).toContain('src/utils/api.ts');
    expect(universe.scanned.some((file) => !file.startsWith('src/'))).toBe(true);
    expect(universe.tests.length).toBeGreaterThan(0);
    expect(universe.generated.length).toBeGreaterThan(0);
    expect(universe.scanned.some((file) => TEST_PATH.test(file))).toBe(false);
  });

  it('spells no portal host in any literal', () => {
    const offences = sources
      .flatMap(({ file, text }) => hostLiterals(file, text))
      .filter((finding) => !(finding.detail in ALLOWED_HOSTS));
    expect(offences, `a host in source is a default waiting to happen:\n${format(offences)}`).toEqual([]);
  });

  it('carries no ALLOWED_HOSTS entry that no longer describes the tree', () => {
    const seen = new Set(sources.flatMap(({ file, text }) => hostLiterals(file, text)).map((f) => f.detail));
    const stale = Object.keys(ALLOWED_HOSTS).filter((host) => !seen.has(host));
    expect(stale, `allowlisted hosts no source spells any more:\n${stale.join('\n')}`).toEqual([]);
  });

  it(`reads ${PORTAL_VARIABLE} nowhere at load time`, () => {
    const offences = sources.flatMap(({ file, text }) => loadTimeReads(file, text));
    expect(offences, `a load-time read is a snapshot, and a snapshot is a default:\n${format(offences)}`).toEqual([]);
  });

  it(`passes a baseUrl at every call to ${REQUEST_HELPER}`, () => {
    const calls = sources.flatMap(({ file, text }) => requestHelperCalls(file, text));
    // Not vacuous: the helper is called, so the assertion below has something to fail on.
    expect(calls.length).toBeGreaterThan(0);
    const missing = calls.filter((call) => call.argumentCount < BASE_URL_ARGUMENT_POSITION);
    expect(missing, `a call without its own baseUrl inherits whatever the helper defaults to:\n${format(missing)}`).toEqual([]);
  });
});

describe('the detectors can fail — each shape a default could take, driven through the same code', () => {
  const decoy = 'decoy.ts';

  it('flags a host in a URL literal, a bare host literal, and a host inside a template', () => {
    expect(hostLiterals(decoy, `export const A = 'https://data.decoy-city.gov';`).map((f) => f.detail)).toEqual([
      'data.decoy-city.gov'
    ]);
    expect(hostLiterals(decoy, `export const A = "data.decoy-city.gov";`).map((f) => f.detail)).toEqual([
      'data.decoy-city.gov'
    ]);
    expect(hostLiterals(decoy, 'export const A = (d: string) => `Search data.decoy-city.gov for ${d}`;').map((f) => f.detail)).toEqual([
      'data.decoy-city.gov'
    ]);
    expect(hostLiterals(decoy, `export const A = 'https://opendata.decoy.nl/api';`).map((f) => f.detail)).toEqual([
      'opendata.decoy.nl'
    ]);
  });

  it('does not flag a host in a comment, an interpolated host, a resource URI, or a module path', () => {
    const clean = [
      `// defaults to https://data.decoy-city.gov when unset`,
      `/* data.decoy-city.gov */ export const A = 1;`,
      'export const A = (domain: string) => `https://${domain}/resource`;',
      `export const A = 'data://portal/info/api-guide';`,
      `import { x } from '../utils/api.js';`,
      `export const A = 'dataset-id.json';`
    ];
    for (const text of clean) expect(hostLiterals(decoy, text), text).toEqual([]);
  });

  it(`flags a load-time read of ${PORTAL_VARIABLE} in each spelling, and not a read made per call`, () => {
    const atLoad = [
      `const U = process.env.${PORTAL_VARIABLE} ?? '';`,
      `const U = process.env['${PORTAL_VARIABLE}'];`,
      `const { ${PORTAL_VARIABLE} } = process.env;`,
      `const { ${PORTAL_VARIABLE}: portal } = process.env;`,
      `class A { u = process.env.${PORTAL_VARIABLE}; }`
    ];
    for (const text of atLoad) expect(loadTimeReads(decoy, text), text).toHaveLength(1);

    const perCall = [
      `export function f() { return process.env.${PORTAL_VARIABLE}; }`,
      `export const f = () => process.env['${PORTAL_VARIABLE}'];`,
      `export const o = { get u() { return process.env.${PORTAL_VARIABLE}; } };`,
      `const U = process.env.OTHER_VARIABLE;`
    ];
    for (const text of perCall) expect(loadTimeReads(decoy, text), text).toEqual([]);
  });

  it(`counts the arguments of each ${REQUEST_HELPER} call, direct or through a namespace`, () => {
    const text = [
      `await ${REQUEST_HELPER}('/api/views/x', {});`,
      `await api.${REQUEST_HELPER}('/api/views/x', {}, baseUrl);`
    ].join('\n');
    expect(requestHelperCalls(decoy, text).map((c) => c.argumentCount)).toEqual([2, 3]);
  });
});
