/**
 * A data query a portal redirects is refused, never re-sent as a GET without its body (#75).
 *
 * MEASURED 2026-10-11. San Francisco's portal answers `POST data.sfgov.org/api/v3/views/<id>/query.json`
 * with 301 to the same path on data.sf.gov. Axios follows redirects through follow-redirects
 * 1.15.9, which re-sends a POST answered 301 or 302 as a GET and drops the body
 * (node_modules/follow-redirects/index.js:442-450). That GET carries no query, so it asks the new
 * host for the whole dataset: the first such request is `getRowCount`'s `count(*)`, and on the
 * fire-incidents dataset (733,061 rows at about 1.2 KB a row) the answer is near 880 MB. The
 * hosted server restarted on memory three times in the website's model evaluation. When a body
 * outgrew V8's string limit, axios rejected with the 200 response attached and no data
 * (node_modules/axios/lib/adapters/http.js:590-597), which the old message printed as
 * `API request failed: 200 - OK / Data: undefined`.
 *
 * Two loopback origins stand in for the two hosts: the first answers with a redirect to the
 * second, and the second records every request that reaches it. Different ports on 127.0.0.1 are
 * different hosts to a URL, so nothing here depends on how `localhost` resolves.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import http from 'node:http';
import { fetchFromSocrataApi } from '../utils/api.js';
import { McpError, ErrorCode } from '../utils/mcp-errors.js';
import { misclassifyingWordsIn } from './misclassifying-words.js';

type Seen = { method: string; url: string; body: string };

type Origin = {
  base: string;
  host: string;
  seen: Seen[];
  answer: (req: http.IncomingMessage, res: http.ServerResponse, body: string) => void;
  close: () => Promise<void>;
};

async function origin(): Promise<Origin> {
  const o = {
    seen: [] as Seen[],
    answer: (_req: http.IncomingMessage, res: http.ServerResponse) => res.end('[]')
  } as Origin;
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (chunk) => (body += chunk));
    req.on('end', () => {
      o.seen.push({ method: req.method ?? '', url: req.url ?? '', body });
      o.answer(req, res, body);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as { port: number };
  o.host = `127.0.0.1:${port}`;
  o.base = `http://${o.host}`;
  o.close = () => new Promise((resolve) => server.close(() => resolve()));
  return o;
}

const DATA_PATH = '/resource/abcd-1234.json';
const SODA3_PATH = '/api/v3/views/abcd-1234/query.json';

/** The rejection a call ends in, or a failure if it answered. */
async function refusalOf(call: Promise<unknown>): Promise<McpError> {
  try {
    await call;
  } catch (error) {
    return error as McpError;
  }
  throw new Error('the call answered; a refusal was expected');
}

describe('a data query the portal redirects', () => {
  let moved: Origin; // the old host, which answers with a redirect
  let movedTo: Origin; // the new host, which must receive nothing

  beforeAll(async () => {
    moved = await origin();
    movedTo = await origin();
  });

  afterAll(async () => {
    await moved.close();
    await movedTo.close();
  });

  beforeEach(() => {
    moved.seen.length = 0;
    movedTo.seen.length = 0;
    movedTo.answer = (_req, res) => res.end(JSON.stringify([{ count: '733061' }]));
  });

  it('positive control: an answer without a redirect comes back as the data', async () => {
    moved.answer = (_req, res) => res.end(JSON.stringify([{ count: '5' }]));
    await expect(fetchFromSocrataApi(DATA_PATH, { $select: 'count(*)', $limit: 1 }, moved.base)).resolves.toEqual([
      { count: '5' }
    ]);
    expect(moved.seen.map((s) => `${s.method} ${s.url}`)).toEqual([`POST ${SODA3_PATH}`]);
  });

  for (const status of [301, 302, 307, 308]) {
    it(`${status}: refused as invalid params, naming the new host, and nothing reaches it`, async () => {
      moved.answer = (req, res) => {
        res.writeHead(status, { Location: `${movedTo.base}${req.url}` });
        res.end();
      };
      const refusal = await refusalOf(fetchFromSocrataApi(DATA_PATH, { $select: 'count(*)', $limit: 1 }, moved.base));

      expect(refusal).toBeInstanceOf(McpError);
      expect(refusal.code).toBe(ErrorCode.InvalidParams);
      expect(refusal.message).toContain(`The portal ${moved.host} answered this request with ${status}`);
      expect(refusal.message).toContain(`pointing to ${movedTo.host}`);
      expect(refusal.message).toContain(`call again with domain "${movedTo.host}"`);
      // Hosts removed first: a random port can spell a listed status code (127.0.0.1:50234).
      const prose = refusal.message.replaceAll(moved.host, '<old host>').replaceAll(movedTo.host, '<new host>');
      expect(misclassifyingWordsIn(prose), refusal.message).toEqual([]);

      // The query went out once, as a POST with its body, and was not re-sent anywhere.
      expect(moved.seen).toHaveLength(1);
      expect(moved.seen[0].method).toBe('POST');
      expect(JSON.parse(moved.seen[0].body).query).toMatch(/^SELECT count\(\*\)/);
      expect(movedTo.seen).toEqual([]);
    });
  }

  it('the message that read a followed 301 as "200 - OK / Data: undefined" now says what the portal answered', async () => {
    moved.answer = (req, res) => {
      res.writeHead(301, { Location: `${movedTo.base}${req.url}` });
      res.end();
    };
    const { message } = await refusalOf(fetchFromSocrataApi(DATA_PATH, {}, moved.base));
    expect(message).toContain('answered this request with 301 Moved Permanently');
    expect(message).not.toContain('200 - OK');
    expect(message).not.toContain('Data: undefined');
  });

  it('a redirect on the same host names the location and offers no new domain', async () => {
    moved.answer = (_req, res) => {
      res.writeHead(301, { Location: '/elsewhere' });
      res.end();
    };
    const refusal = await refusalOf(fetchFromSocrataApi(DATA_PATH, {}, moved.base));
    expect(refusal.code).toBe(ErrorCode.InvalidParams);
    expect(refusal.message).toContain('pointing to /elsewhere');
    expect(refusal.message).not.toContain('call again with domain');
    expect(moved.seen).toHaveLength(1);
  });

  it('a GET path (catalog, metadata) still follows a redirect, as before: only the data query stops', async () => {
    moved.answer = (req, res) => {
      res.writeHead(301, { Location: `${movedTo.base}${req.url}` });
      res.end();
    };
    movedTo.answer = (_req, res) => res.end(JSON.stringify({ name: 'A dataset' }));
    await expect(fetchFromSocrataApi('/api/views/abcd-1234', {}, moved.base)).resolves.toEqual({ name: 'A dataset' });
    expect(movedTo.seen.map((s) => `${s.method} ${s.url}`)).toEqual(['GET /api/views/abcd-1234']);
  });
});
