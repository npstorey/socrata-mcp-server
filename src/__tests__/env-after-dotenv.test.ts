/**
 * A setting in .env reaches the server: no module reads the environment at import.
 *
 * MEASURED 2026-10-12 at f8c776b. src/index.ts runs `dotenv.config()` in its module body, and an
 * ES module's body runs after every module it imports has been evaluated. So a value read in a
 * module body is read before .env is loaded. Two were: `MAX_RAW_ROWS` (src/tools/search.ts:11)
 * and the Socrata app token (src/utils/api.ts:12), which README.md documents setting in .env.
 * The built stdio server, started in a directory whose .env set `MAX_RAW_ROWS=3`, advertised
 * "at most 10,000 rows per call"; with the same value in the process environment it advertised
 * 3. Both are now read per call, as `DATA_PORTAL_URL` already was (src/utils/portal-config.ts).
 *
 * Each test sets the variable after the modules have loaded, which is what dotenv does.
 */
import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import http from 'node:http';
import ts from 'typescript';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { fetchFromSocrataApi } from '../utils/api.js';
import { UNIFIED_SOCRATA_TOOL } from '../tools/socrata-tools.js';

const ROOT = execFileSync('git', ['rev-parse', '--show-toplevel'], {
  cwd: fileURLToPath(new URL('.', import.meta.url)),
  encoding: 'utf8'
}).trim();

const APP_TOKEN = 'SOCRATA_APP_TOKEN';
const saved = { cap: process.env.MAX_RAW_ROWS, token: process.env[APP_TOKEN] };

afterEach(() => {
  if (saved.cap === undefined) delete process.env.MAX_RAW_ROWS;
  else process.env.MAX_RAW_ROWS = saved.cap;
  if (saved.token === undefined) delete process.env[APP_TOKEN];
  else process.env[APP_TOKEN] = saved.token;
});

describe('settings loaded after the modules, as dotenv loads them', () => {
  let origin: { base: string; headers: http.IncomingHttpHeaders[]; close: () => Promise<void> };

  beforeAll(async () => {
    const headers: http.IncomingHttpHeaders[] = [];
    const server = http.createServer((req, res) => {
      headers.push(req.headers);
      req.resume();
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end('[]');
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const { port } = server.address() as { port: number };
    origin = {
      base: `http://127.0.0.1:${port}`,
      headers,
      close: () =>
        new Promise((resolve) => {
          server.closeAllConnections();
          server.close(() => resolve());
        })
    };
  });

  afterAll(async () => {
    await origin.close();
  });

  it('MAX_RAW_ROWS: the cap the get_data description states is the one set after load', () => {
    process.env.MAX_RAW_ROWS = '3';
    const limit = (UNIFIED_SOCRATA_TOOL.inputSchema as { properties: { limit: { description: string } } }).properties.limit;
    expect(limit.description).toContain('at most 3 rows per call');
  });

  it('the app token set after load is sent with a portal request', async () => {
    process.env[APP_TOKEN] = 'app-token-set-after-load';
    await fetchFromSocrataApi('/resource/abcd-1234.json', { $limit: 1 }, origin.base);
    expect(origin.headers.at(-1)?.['x-app-token']).toBe('app-token-set-after-load');
  });

  it('no module reads process.env in its body, where it runs before .env is loaded', () => {
    const files = execFileSync('git', ['ls-files', 'src'], { cwd: ROOT, encoding: 'utf8' })
      .split('\n')
      .filter((file) => /\.(ts|mts|js|mjs)$/.test(file) && !/(__tests__\/|\.test\.|\.spec\.)/.test(file));
    const loadTimeReads: string[] = [];
    for (const file of files) {
      const text = readFileSync(join(ROOT, file), 'utf8');
      if (/do not hand-edit/i.test(text.split('\n').slice(0, 5).join('\n'))) continue;
      const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
      const visit = (node: ts.Node, inFunction: boolean): void => {
        const isFunction = ts.isFunctionLike(node);
        if (!inFunction && (ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node)) && node.expression.getText(source) === 'process.env') {
          const { line } = source.getLineAndCharacterOfPosition(node.getStart(source));
          loadTimeReads.push(`${file}:${line + 1} ${node.getText(source)}`);
        }
        ts.forEachChild(node, (child) => visit(child, inFunction || isFunction));
      };
      visit(source, false);
    }
    expect(loadTimeReads).toEqual([]);
  });
});
