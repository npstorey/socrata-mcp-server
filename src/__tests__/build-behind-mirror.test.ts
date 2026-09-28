/**
 * A build behind a registry mirror edits no Dockerfile.
 *
 * A deployment whose build hosts reach neither Docker Hub nor the public npm registry pulls
 * through a registry mirror instead, and it can redirect only what a build argument names. Over
 * every Dockerfile the repository tracks, this guard asserts four properties:
 *
 *   1. No `syntax` parser directive. One makes the builder pull a frontend image from Docker Hub
 *      before it reads the file, and no build argument reaches that pull.
 *   2. Every image a build pulls is named by a global ARG. Each FROM, and each `COPY --from=` /
 *      `RUN --mount=…from=`, names an earlier stage or `${NAME}` for an ARG declared ahead of the
 *      first FROM, the only scope a FROM reads.
 *   3. Every RUN that installs with npm follows an `ARG NPM_CONFIG_REGISTRY` in its own stage, and
 *      nothing gives that setting a value in the file. The declaration is load-bearing, measured on
 *      Docker 29.4: with it removed from the production-deps stage, that stage's `npm ci` ignored
 *      `--build-arg NPM_CONFIG_REGISTRY=<mirror>` and fetched from registry.npmjs.org. A default
 *      (or an ENV) would put a registry into the reference build, which uses npm's own.
 *   4. Every `resolved` URL in package-lock.json is on https://registry.npmjs.org/. With the
 *      argument set, npm fetched every one of those from the mirror (measured: the tarballs a
 *      logging mirror served were exactly the set each stage installed, and no connection went to
 *      the public registry). A `resolved` URL on another host is a case that measurement did not
 *      cover, and a build behind a mirror may try to reach that host directly.
 *
 * CI reaches Docker Hub and the npm registry directly, so a build that ignores a mirror is green
 * there. These assertions are where it goes red. The model is the application repository's
 * scripts/build-behind-mirror.test.mjs, which asserts 1-3 for its images and pip.
 *
 * THE UNIVERSE IS DERIVED, NOT LISTED: every file `git ls-files` reports named `Dockerfile`,
 * `Dockerfile.<suffix>` or `<name>.Dockerfile`.
 *
 * STATED BLIND SPOTS. This reads text and builds nothing. It sees an image pull only through FROM
 * and `from=`: a RUN that downloads by other means (curl, apt-get, git) and an ADD of a URL are
 * invisible to it. It recognises an npm download as `npm ci`, `npm install`, `npm i`, `npm add`,
 * `npm update` or `npx` in a RUN; yarn, pnpm, or npm with a flag ahead of its command, is not read.
 * It refuses a heredoc or an `escape` directive rather than misreading one. It cannot see whether
 * a mirror serves the same images and packages the defaults name.
 */

import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = execFileSync('git', ['rev-parse', '--show-toplevel'], {
  cwd: fileURLToPath(new URL('.', import.meta.url)),
  encoding: 'utf8'
}).trim();

const REGISTRY_ARG = 'NPM_CONFIG_REGISTRY';
/** npm's default registry: what the lockfile's `resolved` URLs name, and what a set registry replaced. */
const DEFAULT_REGISTRY = 'https://registry.npmjs.org/';

const DOCKERFILE_PATH = /(?:^|\/)(?:Dockerfile(?:\.[^/]+)?|[^/]+\.Dockerfile)$/;
/** An npm command that can download from the registry. */
const NPM_DOWNLOAD = /(?:^|[\s;&|(])(?:npm\s+(?:ci|install|i|add|update)|npx)(?=\s|$)/;
/** `${NAME}` or `$NAME`, and nothing else. */
const ARG_REFERENCE = /^\$(?:\{([A-Za-z_]\w*)\}|([A-Za-z_]\w*))$/;
const HEREDOC = /<<-?\s*["']?[A-Za-z_]/;

type Directive = { key: string; value: string };
type Arg = { name: string; hasDefault: boolean; line: number };
type Run = { command: string; line: number };
type Pull = { ref: string; via: string; line: number };
type Stage = {
  index: number;
  name: string | null;
  args: Arg[];
  envs: { text: string; line: number }[];
  runs: Run[];
  pulls: Pull[];
};
type Dockerfile = { directives: Directive[]; globalArgs: Arg[]; stages: Stage[] };

// --- The parser and the detectors. Pure functions of text, so the decoys below drive the very
// --- code the tree assertions run.

/** The parser directives: the `# key=value` lines ahead of any other line, a blank line included. */
export function parserDirectives(text: string): Directive[] {
  const directives: Directive[] = [];
  for (const line of text.split('\n')) {
    const m = /^#\s*([A-Za-z][A-Za-z0-9]*)\s*=\s*(.*?)\s*$/.exec(line);
    if (!m) break;
    directives.push({ key: m[1].toLowerCase(), value: m[2] });
  }
  return directives;
}

/** Instructions with continuation lines joined and comment lines dropped, each at its first line. */
function instructions(text: string): { keyword: string; rest: string; line: number }[] {
  const out: { keyword: string; rest: string; line: number }[] = [];
  let current: { text: string; line: number } | null = null;
  const lines = text.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (line.startsWith('#') || line === '') continue;
    const continues = line.endsWith('\\');
    const body = continues ? line.slice(0, -1).trim() : line;
    if (current === null) current = { text: body, line: i + 1 };
    else current.text = `${current.text} ${body}`;
    if (!continues) {
      out.push(split(current));
      current = null;
    }
  }
  if (current !== null) out.push(split(current));
  return out;
}

function split({ text, line }: { text: string; line: number }) {
  const [keyword, ...rest] = text.split(/\s+/);
  return { keyword: keyword.toUpperCase(), rest: rest.join(' '), line };
}

export function parseDockerfile(text: string): Dockerfile {
  const directives = parserDirectives(text);
  if (directives.some((d) => d.key === 'escape')) {
    throw new Error('an `escape` directive changes the continuation character, which this parser does not read');
  }
  const globalArgs: Arg[] = [];
  const stages: Stage[] = [];
  for (const { keyword, rest, line } of instructions(text)) {
    if (HEREDOC.test(rest)) throw new Error(`line ${line}: a heredoc, which this parser does not read`);
    const stage = stages.at(-1);
    switch (keyword) {
      case 'FROM': {
        const words = rest.split(/\s+/).filter((w) => !w.startsWith('--'));
        const as = words.findIndex((w) => w.toUpperCase() === 'AS');
        stages.push({
          index: stages.length,
          name: as > 0 ? words[as + 1].toLowerCase() : null,
          args: [],
          envs: [],
          runs: [],
          pulls: [{ ref: words[0], via: 'FROM', line }]
        });
        break;
      }
      case 'ARG': {
        const args = rest
          .split(/\s+/)
          .map((w) => ({ name: w.split('=')[0], hasDefault: w.includes('='), line }));
        (stage ? stage.args : globalArgs).push(...args);
        break;
      }
      case 'ENV':
        stage?.envs.push({ text: rest, line });
        break;
      case 'COPY':
      case 'ADD':
        for (const m of rest.matchAll(/--from=(\S+)/g)) stage?.pulls.push({ ref: m[1], via: `${keyword} --from`, line });
        break;
      case 'RUN':
        for (const m of rest.matchAll(/--mount=\S*?\bfrom=([^,\s]+)/g)) {
          stage?.pulls.push({ ref: m[1], via: 'RUN --mount from=', line });
        }
        stage?.runs.push({ command: rest.replace(/^(?:--\S+\s+)*/, ''), line });
        break;
    }
  }
  return { directives, globalArgs, stages };
}

export function syntaxDirective(path: string, text: string): string[] {
  return parserDirectives(text)
    .filter((d) => d.key === 'syntax')
    .map(
      (d) =>
        `${path} sets \`# syntax=${d.value}\`, so every build pulls that frontend image from its registry ` +
        'before reading the file, and a build behind a mirror has to edit the file to stop it'
    );
}

export function unnamedPulls(path: string, text: string): string[] {
  const { globalArgs, stages } = parseDockerfile(text);
  const globalNames = new Set(globalArgs.map((a) => a.name));
  const findings: string[] = [];
  for (const stage of stages) {
    const earlier = stages.slice(0, stage.index);
    for (const { ref, via, line } of stage.pulls) {
      const isEarlierStage =
        earlier.some((s) => s.name === ref.toLowerCase()) || (/^\d+$/.test(ref) && Number(ref) < stage.index);
      const arg = ARG_REFERENCE.exec(ref);
      const named = arg !== null && globalNames.has(arg[1] ?? arg[2]);
      if (isEarlierStage || named || ref === 'scratch') continue;
      findings.push(
        `${path} line ${line}: ${via} pulls "${ref}", which is neither an earlier stage nor a build argument ` +
          'declared ahead of the first FROM, so a build behind a registry mirror has to edit the file to redirect it'
      );
    }
  }
  return findings;
}

/** Every RUN that downloads with npm, and each one the registry argument does not reach. */
export function unreachedInstalls(path: string, text: string): { installing: string[]; findings: string[] } {
  const { globalArgs, stages } = parseDockerfile(text);
  const installing: string[] = [];
  const findings: string[] = [];
  const sameSetting = (name: string) => name.toUpperCase() === REGISTRY_ARG;
  for (const arg of [...globalArgs, ...stages.flatMap((s) => s.args)]) {
    if (sameSetting(arg.name) && arg.hasDefault) {
      findings.push(
        `${path} line ${arg.line} gives ${arg.name} a default, so a build that passes nothing sends every ` +
          "npm download there in place of npm's own registry, and is not the reference build"
      );
    }
  }
  for (const stage of stages) {
    const label = stage.name ?? String(stage.index);
    for (const env of stage.envs) {
      if (new RegExp(`(?:^|\\s)${REGISTRY_ARG}(?:=|\\s)`, 'i').test(env.text)) {
        findings.push(
          `${path} line ${env.line}: an ENV sets ${REGISTRY_ARG} in stage "${label}", which fixes the registry ` +
            'in the file (and in the image, if it is the final stage) instead of leaving it to the build argument'
        );
      }
    }
    for (const run of stage.runs.filter((r) => NPM_DOWNLOAD.test(r.command))) {
      installing.push(`${path} ${label}`);
      if (!stage.args.some((a) => a.name === REGISTRY_ARG && a.line < run.line)) {
        findings.push(
          `${path} line ${run.line} downloads with npm in stage "${label}" with no ARG ${REGISTRY_ARG} declared ` +
            'ahead of it in that stage, so that install reaches the public registry behind a mirror'
        );
      }
    }
  }
  return { installing, findings };
}

export function foreignResolved(lockText: string): { resolved: number; findings: string[] } {
  const lock = JSON.parse(lockText) as { packages?: Record<string, { resolved?: string }> };
  const entries = Object.entries(lock.packages ?? {}).filter(([, p]) => typeof p.resolved === 'string');
  const findings = entries
    .filter(([, p]) => !(p.resolved as string).startsWith(DEFAULT_REGISTRY))
    .map(
      ([key, p]) =>
        `package-lock.json "${key}" resolves to ${p.resolved}, outside ${DEFAULT_REGISTRY}: the registry ` +
          'argument was measured to redirect only URLs on that host'
    );
  return { resolved: entries.length, findings };
}

// --- The tree.

const repoFile = (path: string) => readFileSync(join(ROOT, path), 'utf8');
const dockerfiles = execFileSync('git', ['ls-files', '-z'], { cwd: ROOT, encoding: 'utf8' })
  .split('\0')
  .filter((file) => DOCKERFILE_PATH.test(file));

describe('a build behind a registry mirror edits no Dockerfile', () => {
  it('the derivation finds the Dockerfile the repository builds', () => {
    expect(dockerfiles).toContain('Dockerfile');
  });

  it('no Dockerfile pulls a frontend image through a syntax directive', () => {
    expect(dockerfiles.flatMap((path) => syntaxDirective(path, repoFile(path)))).toEqual([]);
  });

  it('every image a build pulls is named by a build argument', () => {
    expect(dockerfiles.flatMap((path) => unnamedPulls(path, repoFile(path)))).toEqual([]);
  });

  it(`every npm download reads ${REGISTRY_ARG}, declared in its own stage with no value`, () => {
    const results = dockerfiles.map((path) => unreachedInstalls(path, repoFile(path)));
    expect(results.flatMap((r) => r.findings)).toEqual([]);
    // The search, not the file, failed if either install is missing.
    const installing = results.flatMap((r) => r.installing);
    expect(installing).toContain('Dockerfile build');
    expect(installing).toContain('Dockerfile production-deps');
  });

  it(`every resolved URL in the lockfile is on ${DEFAULT_REGISTRY}`, () => {
    const { resolved, findings } = foreignResolved(repoFile('package-lock.json'));
    expect(resolved).toBeGreaterThan(0);
    expect(findings).toEqual([]);
  });
});

// --- The decoys: each is a way the property could break, driven through the same detectors.

const MIRRORED = [
  'ARG NODE_IMAGE=node:22-bookworm-slim',
  'FROM ${NODE_IMAGE} AS build',
  'ARG NPM_CONFIG_REGISTRY',
  'RUN npm ci',
  'FROM ${NODE_IMAGE} AS runtime',
  'COPY --from=build /app /app'
].join('\n');

const installFindings = (text: string) => unreachedInstalls('decoy', text).findings;

describe('the detectors catch each way a mirror build breaks', () => {
  it('find nothing in a file a mirror build can use', () => {
    expect(syntaxDirective('decoy', MIRRORED)).toEqual([]);
    expect(unnamedPulls('decoy', MIRRORED)).toEqual([]);
    expect(unreachedInstalls('decoy', MIRRORED)).toEqual({ installing: ['decoy build'], findings: [] });
  });

  it('a syntax directive', () => {
    expect(syntaxDirective('decoy', `# syntax=docker/dockerfile:1\n\n${MIRRORED}`)).toHaveLength(1);
  });

  it('but not a syntax line after another comment, which Docker reads as a comment', () => {
    expect(syntaxDirective('decoy', `# An image.\n# syntax=docker/dockerfile:1\n${MIRRORED}`)).toEqual([]);
  });

  it('an image named in a FROM, a COPY --from= and a RUN --mount from=', () => {
    expect(unnamedPulls('decoy', MIRRORED.replace('FROM ${NODE_IMAGE} AS build', 'FROM node:22 AS build'))).toHaveLength(1);
    expect(unnamedPulls('decoy', `${MIRRORED}\nCOPY --from=docker:29-cli /usr/local/bin/docker /usr/local/bin/`)).toHaveLength(1);
    expect(unnamedPulls('decoy', `${MIRRORED}\nRUN --mount=type=bind,from=busybox,target=/b true`)).toHaveLength(1);
  });

  it('an image named by a stage-scoped ARG, which a FROM cannot read', () => {
    const decoy = ['FROM scratch AS base', 'ARG LATE_IMAGE=node:22', 'FROM ${LATE_IMAGE} AS build'].join('\n');
    expect(unnamedPulls('decoy', decoy)).toHaveLength(1);
  });

  it('an npm download in a stage that does not declare the argument', () => {
    const decoy = `${MIRRORED}\nFROM \${NODE_IMAGE} AS production-deps\nRUN npm ci --omit=dev`;
    expect(installFindings(decoy)).toHaveLength(1);
  });

  it('an npm download ahead of the declaration in its stage', () => {
    const decoy = MIRRORED.replace('ARG NPM_CONFIG_REGISTRY\nRUN npm ci', 'RUN npm ci\nARG NPM_CONFIG_REGISTRY');
    expect(installFindings(decoy)).toHaveLength(1);
  });

  it('an npm download on a continued RUN line, npm install and npx included', () => {
    for (const run of ['RUN apt-get update && \\\n    npm ci', 'RUN npm install', 'RUN npx tsc']) {
      const decoy = `ARG NODE_IMAGE=node:22\nFROM \${NODE_IMAGE} AS build\n${run}`;
      expect(installFindings(decoy)).toHaveLength(1);
    }
  });

  it('a registry fixed in the file, by an ARG default or an ENV', () => {
    const address = 'https://registry.example.internal/npm/';
    expect(installFindings(MIRRORED.replace('ARG NPM_CONFIG_REGISTRY', `ARG NPM_CONFIG_REGISTRY=${address}`))).toHaveLength(1);
    expect(installFindings(`${MIRRORED}\nENV npm_config_registry=${address}`)).toHaveLength(1);
  });

  it('refuses a heredoc rather than misreading it', () => {
    expect(() => parseDockerfile(`${MIRRORED}\nRUN <<EOF\nnpm ci\nEOF`)).toThrow(/heredoc/);
  });

  it('a lockfile entry resolved outside the default registry', () => {
    const lock = JSON.stringify({
      packages: {
        '': {},
        'node_modules/a': { resolved: `${DEFAULT_REGISTRY}a/-/a-1.0.0.tgz` },
        'node_modules/b': { resolved: 'https://codeload.example.org/b/tar.gz/v1' }
      }
    });
    expect(foreignResolved(lock)).toEqual({ resolved: 2, findings: [expect.stringContaining('node_modules/b')] });
  });
});
