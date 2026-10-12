/**
 * A portal request that runs past its time is refused once, inside its call's limit (#79).
 *
 * MEASURED 2026-10-11 and 2026-10-12 by the website's model evaluation (civic-ai-tools-website
 * #573): five rows on one Los Angeles question held the evaluation's whole 120 s, each with a
 * tool call open. This server gave a portal request 30 s and sent one that ran past it up to three
 * more times (src/utils/api.ts at 4e37e62, :17-18 and :75-76), so a slow query held a call for
 * about two minutes and the portal ran it four times, and `get_data` makes two such requests in a
 * row (a count, then the data). The website's client clears its 45 s timer once response headers
 * arrive (civic-ai-tools-website src/lib/mcp/client.ts:739-755), and this server sends them at
 * once (the hosted server, 2026-10-12 20:10Z: headers at 0.22 s, the result at 6.06 s), so this
 * server's own limit is the only one on a call. The old refusal also said "retried 3 times" and
 * "timed out", which the website reads as a timeout and answers by telling the model to give up.
 *
 * Loopback origins stand in for the portal. Each test passes `withCallLimit` a short limit, so a
 * request's time is the call's time left and nothing here waits 30 s.
 */
import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from 'vitest';
import http from 'node:http';
import { fetchFromSocrataApi } from '../utils/api.js';
import { withCallLimit, allowanceMs, REQUEST_LIMIT_MS, CALL_LIMIT_MS } from '../utils/call-budget.js';
import { McpError, ErrorCode } from '../utils/mcp-errors.js';
import { misclassifyingWordsIn } from './misclassifying-words.js';

const DATA_PATH = '/resource/abcd-1234.json';

/** How the origin answers one request. */
type Answer = 'hold' | 'trickle' | 'reset' | { status: number; headers?: Record<string, string> } | { afterMs: number; body: string };

type Portal = {
  base: string;
  host: string;
  requests: number;
  /** One per request, in order; once empty, every request is held. */
  answers: Answer[];
  close: () => Promise<void>;
};

async function portal(): Promise<Portal> {
  const p = { requests: 0, answers: [] as Answer[] } as Portal;
  const server = http.createServer((req, res) => {
    p.requests += 1;
    const answer = p.answers.shift() ?? 'hold';
    req.resume();
    if (answer === 'hold') return;
    if (answer === 'reset') {
      req.socket.destroy();
      return;
    }
    if (answer === 'trickle') {
      // Headers, then a byte every 20 ms: never silent long enough for a timer on silence.
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.write('[');
      const timer = setInterval(() => res.write(' '), 20);
      res.on('close', () => clearInterval(timer));
      return;
    }
    if ('status' in answer) {
      res.writeHead(answer.status, { 'Content-Type': 'application/json', ...answer.headers });
      res.end('{"message":"busy"}');
      return;
    }
    setTimeout(() => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(answer.body);
    }, answer.afterMs);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as { port: number };
  p.host = `127.0.0.1:${port}`;
  p.base = `http://${p.host}`;
  p.close = () =>
    new Promise((resolve) => {
      server.closeAllConnections();
      server.close(() => resolve());
    });
  return p;
}

async function refusalOf(call: Promise<unknown>): Promise<Error> {
  try {
    await call;
  } catch (error) {
    return error as Error;
  }
  throw new Error('the call answered; a refusal was expected');
}

/** The refusal's text, with the seconds waited written as N. */
function refusalText(host: string): string {
  return `The portal ${host} took too long to answer this request: this server waited N s for it and stopped, and did not send it again, so nothing from it is returned. A narrower request may answer: a shorter date range in where, an aggregate (group with count(*)) instead of rows, fewer columns (select), or a smaller limit.`;
}

const settle = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe('a portal request that runs past its time', () => {
  let origin: Portal;

  beforeAll(async () => {
    origin = await portal();
  });

  afterAll(async () => {
    await origin.close();
  });

  afterEach(() => {
    origin.answers = [];
    vi.restoreAllMocks();
  });

  it('states the limits this server applies: 30 s a request, 40 s a call, and 30 s for a request outside a call', () => {
    expect(REQUEST_LIMIT_MS).toBe(30_000);
    expect(CALL_LIMIT_MS).toBe(40_000);
    expect(allowanceMs()).toBe(30_000);
  });

  for (const [label, path] of [
    ['a data query (POST)', DATA_PATH],
    ['a GET path (metadata, catalog)', '/api/views/abcd-1234']
  ] as const) {
    it(`${label}: refused as invalid params at its time, and sent once`, async () => {
      vi.spyOn(console, 'error').mockImplementation(() => {});
      origin.answers = ['hold'];
      const before = origin.requests;
      const started = Date.now();
      const refusal = await refusalOf(withCallLimit(() => fetchFromSocrataApi(path, { $limit: 10 }, origin.base), 300));
      const elapsed = Date.now() - started;

      expect(refusal).toBeInstanceOf(McpError);
      expect((refusal as McpError).code).toBe(ErrorCode.InvalidParams);
      expect(refusal.message.replace(/waited \d+ s/, 'waited N s')).toBe(refusalText(origin.host));
      expect(refusal.message).not.toContain('retried');
      expect(misclassifyingWordsIn(refusal.message), refusal.message).toEqual([]);
      // Main sent it four times, 8.8 s at a 300 ms limit; the bound is loose for a loaded machine.
      expect(elapsed).toBeGreaterThanOrEqual(290);
      expect(elapsed).toBeLessThan(3_000);

      // The old first retry came 1 to 1.25 s after the timeout; nothing comes now.
      await settle(1_500);
      expect(origin.requests - before).toBe(1);
    });
  }

  it("one limit across a call's requests: a count that answers, then a data query held, refused at the call's limit", async () => {
    const lines: string[] = [];
    vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => {
      lines.push(args.map(String).join(' '));
    });
    origin.answers = [{ afterMs: 200, body: '[{"count":"5"}]' }, 'hold'];
    const before = origin.requests;
    const started = Date.now();
    const refusal = await refusalOf(
      withCallLimit(async () => {
        await fetchFromSocrataApi(DATA_PATH, { $select: 'count(*)', $limit: 1 }, origin.base);
        return fetchFromSocrataApi(DATA_PATH, { $limit: 5 }, origin.base);
      }, 600)
    );
    const elapsed = Date.now() - started;

    expect(refusal).toBeInstanceOf(McpError);
    expect(elapsed).toBeGreaterThanOrEqual(590);
    expect(origin.requests - before).toBe(2);
    // The data query was given the call's time left, not a limit of its own.
    const line = lines.find((l) => l.startsWith('[Portal] Took too long: ')) ?? '';
    expect(Number(/ allowed_ms=(\d+)/.exec(line)?.[1])).toBeLessThan(600);
    expect(Number(/ call_ms=(\d+)/.exec(line)?.[1])).toBeGreaterThanOrEqual(590);
  });

  it('an answer that sends a byte now and then is still stopped at its time', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    origin.answers = ['trickle'];
    const started = Date.now();
    const refusal = await refusalOf(withCallLimit(() => fetchFromSocrataApi(DATA_PATH, {}, origin.base), 400));

    expect(refusal).toBeInstanceOf(McpError);
    expect(refusal.message.replace(/waited \d+ s/, 'waited N s')).toBe(refusalText(origin.host));
    // Without a bound on the total, this would wait for the test's own timeout.
    expect(Date.now() - started).toBeLessThan(3_000);
  });

  it('positive control: a 503 is still retried, and the answer that follows is returned', async () => {
    origin.answers = [{ status: 503 }, { afterMs: 0, body: '[{"a":1}]' }];
    const before = origin.requests;
    const rows = await fetchFromSocrataApi<unknown[]>(DATA_PATH, {}, origin.base);

    expect(rows).toEqual([{ a: 1 }]);
    expect(origin.requests - before).toBe(2);
  });

  it("a retry whose wait would pass the call's limit is not made", async () => {
    origin.answers = [{ status: 503 }];
    const before = origin.requests;
    const error = await refusalOf(withCallLimit(() => fetchFromSocrataApi(DATA_PATH, {}, origin.base), 500));

    // Had the retry been made, its request would have been held and refused as too long.
    expect(error.message).toContain('API request failed: 503');
    expect(origin.requests - before).toBe(1);
  });

  it('a 429 whose Retry-After passes the limit is answered at once, without claiming retries', async () => {
    origin.answers = [{ status: 429, headers: { 'Retry-After': '60' } }];
    const before = origin.requests;
    const error = await refusalOf(fetchFromSocrataApi(DATA_PATH, {}, origin.base));

    // Had it waited the 60 s Retry-After, the test would have run past its own timeout.
    expect(error.message).toBe('Rate limited by the data portal (HTTP 429). Too many requests — try again in a minute.');
    expect(origin.requests - before).toBe(1);
  });

  it('a request that gets no response does not claim retries it never made', async () => {
    origin.answers = ['reset'];
    const before = origin.requests;
    const error = await refusalOf(fetchFromSocrataApi(DATA_PATH, {}, origin.base));

    expect(error.message).toMatch(/^API request failed: No response received\. Message: /);
    expect(error.message).not.toContain('retried');
    await settle(1_500);
    expect(origin.requests - before).toBe(1);
  });

  it("the log line gives the request's shape, never its text", async () => {
    const lines: string[] = [];
    for (const method of ['error', 'warn', 'log'] as const) {
      vi.spyOn(console, method).mockImplementation((...args: unknown[]) => {
        lines.push(args.map(String).join(' '));
      });
    }
    origin.answers = ['hold', 'hold'];

    await refusalOf(
      withCallLimit(
        () =>
          fetchFromSocrataApi(
            DATA_PATH,
            {
              $select: 'date_trunc_ym(createddate) as SENTINEL_ALIAS, count(*) as n',
              $where: "address like '%SENTINEL STREET%'",
              $q: 'SENTINEL reader phrase',
              $limit: 12,
              $offset: 0
            },
            origin.base
          ),
        300
      )
    );
    await refusalOf(
      withCallLimit(() => fetchFromSocrataApi('/api/views/noise SENTINEL words', { q: 'SENTINEL catalog terms' }, origin.base), 300)
    );

    const portalLines = lines.filter((line) => line.startsWith('[Portal] Took too long: '));
    expect(portalLines).toHaveLength(2);
    expect(portalLines[0]).toMatch(
      new RegExp(
        `^\\[Portal\\] Took too long: portal=${origin.host} endpoint=/api/v3/views/\\{id\\}/query\\.json dataset=abcd-1234 ` +
          'clauses=select:59,where:32,q:22 limit=12 offset=0 waited_ms=\\d+ allowed_ms=\\d+ call_ms=\\d+$'
      )
    );
    expect(portalLines[1]).toMatch(
      new RegExp(
        `^\\[Portal\\] Took too long: portal=${origin.host} endpoint=/api/views/\\{id\\} clauses=q:22 waited_ms=\\d+ allowed_ms=\\d+ call_ms=\\d+$`
      )
    );
    expect(lines.filter((line) => line.includes('SENTINEL'))).toEqual([]);
  });
});
