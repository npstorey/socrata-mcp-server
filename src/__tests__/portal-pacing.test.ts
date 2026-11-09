/**
 * An optional gap between requests to one portal, and `Retry-After` read on 429 and 503.
 *
 * MEASURED 2026-11-06 on data.cityofnewyork.us, by a client outside this server: about 83
 * back-to-back aggregate queries, sent with an app token, drew 27 429s and 15 503s in about
 * 50 minutes, and none carried `Retry-After`. Socrata publishes no request-rate number
 * (https://dev.socrata.com/docs/app-tokens), so the gap is the operator's to set and is off by
 * default (src/utils/portal-pacing.ts).
 *
 * Loopback origins stand in for the portal, as in slow-portal.test.ts.
 */
import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from 'vitest';
import http from 'node:http';
import { fetchFromSocrataApi } from '../utils/api.js';
import { withCallLimit } from '../utils/call-budget.js';
import { McpError, ErrorCode } from '../utils/mcp-errors.js';
import {
  MAX_INTERVAL_MS,
  MIN_INTERVAL_ENV,
  minIntervalMs,
  resetPacing,
  retryAfterMs,
  takeTurn,
} from '../utils/portal-pacing.js';
import { listenOnAPortSpelling429, misclassifyingWordsIn } from './misclassifying-words.js';

const DATA_PATH = '/resource/abcd-1234.json';

type Answer = { status: number; headers?: Record<string, string> } | 'hold';

type Portal = {
  base: string;
  host: string;
  /** When each request arrived, in ms since the epoch. */
  arrivals: number[];
  answers: Answer[];
  close: () => Promise<void>;
};

async function portal(onPortSpelling429 = false): Promise<Portal> {
  const p = { arrivals: [] as number[], answers: [] as Answer[] } as Portal;
  const server = http.createServer((req, res) => {
    p.arrivals.push(Date.now());
    const answer = p.answers.shift() ?? { status: 200 };
    req.resume();
    if (answer === 'hold') return;
    res.writeHead(answer.status, { 'Content-Type': 'application/json', ...answer.headers });
    res.end(answer.status === 200 ? '[{"n":"1"}]' : '{"message":"busy"}');
  });
  if (onPortSpelling429) await listenOnAPortSpelling429(server);
  else await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
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

function gaps(times: number[]): number[] {
  return times.slice(1).map((t, i) => t - times[i]);
}

describe('the gap setting', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    resetPacing();
  });

  it('is off when unset, blank, not a number, zero or negative', () => {
    for (const value of [undefined, '', '  ', 'fast', '0', '-200']) {
      if (value === undefined) vi.stubEnv(MIN_INTERVAL_ENV, undefined as unknown as string);
      else vi.stubEnv(MIN_INTERVAL_ENV, value);
      expect(minIntervalMs()).toBe(0);
    }
  });

  it('reads whole milliseconds and is held to at most 10 s', () => {
    vi.stubEnv(MIN_INTERVAL_ENV, '250.9');
    expect(minIntervalMs()).toBe(250);
    vi.stubEnv(MIN_INTERVAL_ENV, '600000');
    expect(minIntervalMs()).toBe(MAX_INTERVAL_MS);
  });

  it('gives each host its own turns, and takes none that would start at or after the deadline', () => {
    vi.stubEnv(MIN_INTERVAL_ENV, '500');
    const now = 1_000_000;
    expect(takeTurn('a.example', now + 5_000, now)).toBe(0);
    expect(takeTurn('a.example', now + 5_000, now)).toBe(500);
    expect(takeTurn('a.example', now + 5_000, now)).toBe(1_000);
    expect(takeTurn('b.example', now + 5_000, now)).toBe(0);
    expect(takeTurn('a.example', now + 1_500, now)).toBeNull();
    // The refused turn was not taken: a call with more time still gets 1.5 s.
    expect(takeTurn('a.example', now + 5_000, now)).toBe(1_500);
  });

  it('takes no turns when off', () => {
    const now = 1_000_000;
    expect(takeTurn('a.example', now + 10, now)).toBe(0);
    expect(takeTurn('a.example', now + 10, now)).toBe(0);
  });
});

describe('Retry-After', () => {
  it('reads seconds and an HTTP date, and ignores what it cannot read', () => {
    const now = Date.parse('2026-11-06T20:00:00Z');
    expect(retryAfterMs('7', now)).toBe(7_000);
    expect(retryAfterMs('Fri, 06 Nov 2026 20:00:30 GMT', now)).toBe(30_000);
    expect(retryAfterMs('Fri, 06 Nov 2026 19:59:00 GMT', now)).toBe(0);
    expect(retryAfterMs('soon', now)).toBeUndefined();
    expect(retryAfterMs('', now)).toBeUndefined();
    expect(retryAfterMs(undefined, now)).toBeUndefined();
  });
});

describe('requests to a portal', () => {
  let origin: Portal;

  beforeAll(async () => {
    origin = await portal();
  });

  afterAll(async () => {
    await origin.close();
  });

  afterEach(() => {
    origin.answers = [];
    origin.arrivals = [];
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
    resetPacing();
  });

  it('are sent back to back when no gap is set', async () => {
    for (let i = 0; i < 3; i++) await fetchFromSocrataApi(DATA_PATH, {}, origin.base);
    expect(origin.arrivals).toHaveLength(3);
    for (const gap of gaps(origin.arrivals)) expect(gap).toBeLessThan(150);
  });

  it('are spaced by the gap when one is set, including requests from calls running at once', async () => {
    vi.stubEnv(MIN_INTERVAL_ENV, '200');
    await Promise.all(
      [0, 1, 2].map(() =>
        withCallLimit(() => fetchFromSocrataApi(DATA_PATH, {}, origin.base), 5_000)
      )
    );
    expect(origin.arrivals).toHaveLength(3);
    for (const gap of gaps(origin.arrivals)) expect(gap).toBeGreaterThanOrEqual(190);
  });

  it('that would have no turn inside the call are refused, unsent, in words the website does not misread', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.stubEnv(MIN_INTERVAL_ENV, '2000');
    await withCallLimit(() => fetchFromSocrataApi(DATA_PATH, {}, origin.base), 1_000);
    const refusal = await refusalOf(
      withCallLimit(() => fetchFromSocrataApi(DATA_PATH, {}, origin.base), 1_000)
    );

    expect(refusal).toBeInstanceOf(McpError);
    expect((refusal as McpError).code).toBe(ErrorCode.InvalidParams);
    expect(refusal.message).toContain(MIN_INTERVAL_ENV);
    // Host removed first: a random port can spell a listed status code (#102).
    expect(misclassifyingWordsIn(refusal.message.replaceAll(origin.host, '<host>')), refusal.message).toEqual([]);
    expect(origin.arrivals).toHaveLength(1);
  });

  it('on a port that spells 429, with no turn inside the call, are refused in words the website does not misread', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.stubEnv(MIN_INTERVAL_ENV, '2000');
    const spelled = await portal(true);
    try {
      expect(spelled.host).toMatch(/^127\.0\.0\.1:429\d\d$/);
      await withCallLimit(() => fetchFromSocrataApi(DATA_PATH, {}, spelled.base), 1_000);
      const refusal = await refusalOf(
        withCallLimit(() => fetchFromSocrataApi(DATA_PATH, {}, spelled.base), 1_000)
      );

      expect(refusal).toBeInstanceOf(McpError);
      expect(refusal.message).toContain(spelled.host);
      // Host removed first: this port spells a listed status code (#102).
      expect(misclassifyingWordsIn(refusal.message.replaceAll(spelled.host, '<host>')), refusal.message).toEqual([]);
      expect(spelled.arrivals).toHaveLength(1);
    } finally {
      await spelled.close();
    }
  });

  for (const status of [429, 503]) {
    it(`a ${status} with Retry-After in seconds is retried after that wait, inside the call`, async () => {
      origin.answers = [{ status, headers: { 'Retry-After': '1' } }, { status: 200 }];
      const data = await withCallLimit(
        () => fetchFromSocrataApi(DATA_PATH, {}, origin.base),
        5_000
      );
      expect(data).toEqual([{ n: '1' }]);
      expect(origin.arrivals).toHaveLength(2);
      expect(gaps(origin.arrivals)[0]).toBeGreaterThanOrEqual(990);
    });
  }

  it('a 503 whose Retry-After date passes the limit is answered at once', async () => {
    const later = new Date(Date.now() + 120_000).toUTCString();
    origin.answers = [{ status: 503, headers: { 'Retry-After': later } }];
    const started = Date.now();
    const error = await refusalOf(fetchFromSocrataApi(DATA_PATH, {}, origin.base));
    expect(Date.now() - started).toBeLessThan(2_000);
    expect(error.message).toContain('API request failed: 503');
    expect(origin.arrivals).toHaveLength(1);
  });
});
