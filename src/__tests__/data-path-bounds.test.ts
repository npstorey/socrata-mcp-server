/**
 * One portal exchange is bounded in size, both ways (#77).
 *
 * Axios leaves `maxContentLength` and `maxBodyLength` unbounded by default, and this server set
 * neither, so an answer was read into memory whatever its size. #75 showed the cost: a redirect
 * turned a count into a whole-dataset download and the hosted server restarted. Every request
 * through `fetchFromSocrataApi` now carries both bounds, and passing one is answered with a
 * refusal that says what to ask for instead.
 *
 * A loopback origin streams an answer past the bound; the test checks the refusal and that the
 * download was cut off near the bound rather than read to the end.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import http from 'node:http';
import { fetchFromSocrataApi, MAX_RESPONSE_BYTES, MAX_REQUEST_BYTES } from '../utils/api.js';
import { McpError, ErrorCode } from '../utils/mcp-errors.js';
import { misclassifyingWordsIn } from './misclassifying-words.js';

const MiB = 1024 * 1024;
const DATA_PATH = '/resource/abcd-1234.json';

type Portal = {
  base: string;
  requests: number;
  /** Bytes the origin managed to write before the client stopped reading, per response. */
  written: number[];
  /** How many bytes of JSON array the next answer streams. */
  answerBytes: number;
  close: () => Promise<void>;
};

/** Streams a JSON array of `answerBytes`, a chunk at a time, honouring back-pressure. */
async function portal(): Promise<Portal> {
  const p = { requests: 0, written: [] as number[], answerBytes: 0 } as Portal;
  const row = JSON.stringify({ unique_key: '00000000', complaint_type: 'Noise - Residential', descriptor: 'Loud Music/Party' });
  const server = http.createServer((req, res) => {
    p.requests += 1;
    req.resume();
    req.on('end', () => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.write('[');
      const chunk = Buffer.from(`${row},`.repeat(Math.floor(64 * 1024 / (row.length + 1))));
      let sent = 0;
      const index = p.written.push(0) - 1;
      const pump = () => {
        while (sent + chunk.length < p.answerBytes) {
          if (res.destroyed) return;
          sent += chunk.length;
          p.written[index] = sent;
          if (!res.write(chunk)) {
            res.once('drain', pump);
            return;
          }
        }
        res.end(`${row}]`);
      };
      res.on('close', () => res.removeAllListeners('drain'));
      pump();
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as { port: number };
  p.base = `http://127.0.0.1:${port}`;
  p.close = () =>
    new Promise((resolve) => {
      server.closeAllConnections();
      server.close(() => resolve());
    });
  return p;
}

async function refusalOf(call: Promise<unknown>): Promise<McpError> {
  try {
    await call;
  } catch (error) {
    return error as McpError;
  }
  throw new Error('the call answered; a refusal was expected');
}

describe('the bounds on one portal exchange', () => {
  let origin: Portal;

  beforeAll(async () => {
    origin = await portal();
  });

  afterAll(async () => {
    await origin.close();
  });

  it('states the bounds this server applies: 32 MiB in, 1 MiB out', () => {
    expect(MAX_RESPONSE_BYTES).toBe(32 * MiB);
    expect(MAX_REQUEST_BYTES).toBe(1 * MiB);
  });

  it('positive control: an answer under the bound is read whole', async () => {
    origin.answerBytes = 2 * MiB;
    const rows = await fetchFromSocrataApi<unknown[]>(DATA_PATH, { $limit: 10 }, origin.base);
    expect(rows.length).toBeGreaterThan(1000);
  });

  for (const [label, path] of [
    ['a data query (POST)', DATA_PATH],
    ['a GET path (metadata, catalog)', '/api/views/abcd-1234']
  ] as const) {
    it(`${label}: an answer past 32 MiB is refused as invalid params, and the download is cut off`, async () => {
      origin.answerBytes = 128 * MiB;
      const before = origin.requests;
      const refusal = await refusalOf(fetchFromSocrataApi(path, {}, origin.base));

      expect(refusal).toBeInstanceOf(McpError);
      expect(refusal.code).toBe(ErrorCode.InvalidParams);
      expect(refusal.message).toContain('passed 32 MiB');
      expect(refusal.message).toContain('Ask for less');
      expect(misclassifyingWordsIn(refusal.message), refusal.message).toEqual([]);

      // Refused once, not retried, and stopped near the bound rather than read to 128 MiB.
      expect(origin.requests - before).toBe(1);
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(origin.written[origin.written.length - 1]).toBeLessThan(48 * MiB);
    });
  }

  it('a request body past 1 MiB is refused before it is sent', async () => {
    origin.answerBytes = 1024;
    const before = origin.requests;
    const longQuery = `SELECT * WHERE unique_key IN (${"'00000000',".repeat(Math.ceil(MiB / 11))}'0')`;
    const refusal = await refusalOf(fetchFromSocrataApi(DATA_PATH, { $query: longQuery }, origin.base));

    expect(refusal).toBeInstanceOf(McpError);
    expect(refusal.code).toBe(ErrorCode.InvalidParams);
    expect(refusal.message).toContain('larger than 1 MiB');
    expect(refusal.message).toContain('it was not sent');
    expect(misclassifyingWordsIn(refusal.message), refusal.message).toEqual([]);
    expect(origin.requests - before).toBe(0);
  });
});
