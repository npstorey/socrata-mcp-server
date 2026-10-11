/**
 * Each result is logged as a summary (rows, columns, bytes), never whole (#77).
 *
 * Every result used to go to stderr whole and pretty-printed, from four places in src/index.ts:
 * the get_data, search and fetch handlers' own lines, and the wrapper around every request
 * handler, which logged a tool result a second time. A large answer cost its size again in the
 * log, and a portal's records went to the log with it.
 *
 * The planted value below is in every row the mocked portal returns. Each tool call is driven
 * through the real `createServer()` handlers; the value must reach the client and never the log.
 */

import { describe, it, expect, vi, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';

vi.mock('axios');
vi.mock('../utils/api.js', () => ({
  fetchFromSocrataApi: vi.fn()
}));

import axios from 'axios';
import type { JSONRPCMessage } from '@modelcontextprotocol/sdk/types.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { fetchFromSocrataApi } from '../utils/api.js';
import { documentCache } from '../utils/cache.js';
import { createServer } from '../index.js';
import { summarizeResult } from '../utils/log-summary.js';

const mockedFetch = vi.mocked(fetchFromSocrataApi);
const mockedAxiosGet = vi.mocked(axios.get);

const PLANTED = 'PLANTED-ROW-VALUE-7f3a';
const PORTAL = 'data.portal-named-in-the-call.example';

describe('summarizeResult', () => {
  it('a query result: rows, distinct columns across rows, and the bytes of the text sent', () => {
    const result = { data: [{ a: 1, b: 2 }, { a: 3, c: 4 }], is_sample: false, returned_rows: 2, total_rows: 2 };
    const text = JSON.stringify(result, null, 2);
    expect(summarizeResult(result, text)).toBe(`rows=2 columns=3 bytes=${Buffer.byteLength(text)}`);
  });

  it('a catalog result (an array): rows and columns', () => {
    expect(summarizeResult([{ id: 'abcd-1234', name: 'A' }])).toMatch(/^rows=1 columns=2 bytes=\d+$/);
  });

  it('a tool result: its content items and their text bytes, with no serializing of the whole', () => {
    const result = { content: [{ type: 'text', text: 'héllo' }, { type: 'text', text: 'abc' }], isError: false };
    expect(summarizeResult(result)).toBe('content=2 bytes=9');
  });

  it('anything else: its bytes as JSON', () => {
    expect(summarizeResult({ tools: [] })).toBe('bytes=12');
    expect(summarizeResult(undefined)).toBe('bytes=0');
  });
});

type JsonRpcResponse = {
  jsonrpc: '2.0';
  id: number;
  result?: { content?: Array<{ type: string; text: string }>; isError?: boolean };
  error?: { code: number; message: string };
};

async function connectRaw() {
  const server = await createServer();
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  await server.connect(serverSide);
  const pending = new Map<number, (message: JsonRpcResponse) => void>();
  clientSide.onmessage = (message) => {
    const response = message as JsonRpcResponse;
    const settle = typeof response.id === 'number' ? pending.get(response.id) : undefined;
    if (settle) {
      pending.delete(response.id);
      settle(response);
    }
  };
  await clientSide.start();
  let nextId = 1;
  const request = (method: string, params: unknown) =>
    new Promise<JsonRpcResponse>((resolve) => {
      const id = nextId++;
      pending.set(id, resolve);
      void clientSide.send({ jsonrpc: '2.0', id, method, params } as JSONRPCMessage);
    });
  await request('initialize', {
    protocolVersion: '2025-06-18',
    capabilities: {},
    clientInfo: { name: 'result-log-summary', version: '1.0.0' }
  });
  await clientSide.send({ jsonrpc: '2.0', method: 'notifications/initialized' } as JSONRPCMessage);
  return {
    callTool: (name: string, args: Record<string, unknown>) => request('tools/call', { name, arguments: args }),
    close: async () => {
      await clientSide.close();
      await server.close();
    }
  };
}

describe('tool results reach the client whole and the log as a summary', () => {
  let rpc: Awaited<ReturnType<typeof connectRaw>>;
  let logged: string[];
  const saved = process.env.DATA_PORTAL_URL;

  beforeAll(async () => {
    rpc = await connectRaw();
  });

  afterAll(async () => {
    await rpc?.close();
    if (saved === undefined) delete process.env.DATA_PORTAL_URL;
    else process.env.DATA_PORTAL_URL = saved;
  });

  beforeEach(() => {
    vi.clearAllMocks();
    documentCache.clear();
    mockedFetch.mockImplementation((async (path: string, params: Record<string, unknown> = {}) => {
      if (path.startsWith('/api/catalog/v1')) {
        return { results: [{ resource: { id: 'abcd-1234', name: PLANTED, description: PLANTED } }] };
      }
      if (/^\/api\/views\/[^/]+\/columns$/.test(path)) return [{ fieldName: 'status', name: PLANTED }];
      if (path.startsWith('/api/views/')) return { name: PLANTED, columns: [] };
      if (path.startsWith('/resource/')) {
        if (params.$select === 'count(*)') return [{ count: '2' }];
        return [
          { ':id': 'row-1', status: PLANTED, borough: 'BRONX' },
          { ':id': 'row-2', status: PLANTED, borough: 'QUEENS' }
        ];
      }
      return {};
    }) as never);
    mockedAxiosGet.mockResolvedValue({ data: [{ count: '2' }] } as never);

    logged = [];
    const record = (...args: unknown[]) => {
      logged.push(args.map((a) => (typeof a === 'string' ? a : JSON.stringify(a) ?? String(a))).join(' '));
    };
    vi.spyOn(console, 'error').mockImplementation(record);
    vi.spyOn(console, 'log').mockImplementation(record);
  });

  afterEach(() => {
    vi.mocked(console.error).mockRestore();
    vi.mocked(console.log).mockRestore();
  });

  it('get_data type=query: the rows reach the client, the log carries rows=2 columns=3 and no row', async () => {
    const response = await rpc.callTool('get_data', { type: 'query', domain: PORTAL, dataset_id: 'abcd-1234', limit: 2 });
    expect(response.result?.content?.[0].text).toContain(PLANTED);
    expect(logged.filter((line) => line.includes(PLANTED))).toEqual([]);
    expect(logged.some((line) => /^\[Tool\] Result: rows=2 columns=3 bytes=\d+$/.test(line))).toBe(true);
    expect(logged.some((line) => /^\[Server\] Handler returned: content=1 bytes=\d+$/.test(line))).toBe(true);
  });

  it('get_data type=catalog: no dataset text in the log', async () => {
    const response = await rpc.callTool('get_data', { type: 'catalog', domain: PORTAL, query: 'noise' });
    expect(response.result?.content?.[0].text).toContain(PLANTED);
    expect(logged.filter((line) => line.includes(PLANTED))).toEqual([]);
    expect(logged.some((line) => /^\[Tool\] Result: rows=1 columns=\d+ bytes=\d+$/.test(line))).toBe(true);
  });

  it('fetch: the record reaches the client, the log carries content=1 and a size', async () => {
    const response = await rpc.callTool('fetch', { id: `dataset:${PORTAL}:abcd-1234` });
    expect(JSON.stringify(response.result)).toContain(PLANTED);
    expect(logged.filter((line) => line.includes(PLANTED))).toEqual([]);
    expect(logged.some((line) => /^\[Tool\] Fetch result: content=\d+ bytes=\d+$/.test(line))).toBe(true);
  });

  it('search: the result reaches the client, the log carries content and a size', async () => {
    process.env.DATA_PORTAL_URL = `https://${PORTAL}`;
    try {
      const response = await rpc.callTool('search', { query: 'noise' });
      expect(response.error, JSON.stringify(response.error)).toBeUndefined();
      expect(logged.filter((line) => line.includes(PLANTED))).toEqual([]);
      expect(logged.some((line) => /^\[Tool\] Search result: content=\d+ bytes=\d+$/.test(line))).toBe(true);
    } finally {
      delete process.env.DATA_PORTAL_URL;
    }
  });
});
