/**
 * Every tool call runs under one time limit across its portal requests (#79).
 *
 * src/__tests__/slow-portal.test.ts shows what a request does with its call's limit. This file
 * shows that each tool's handler sets that limit: a request made by `get_data`, `search` or
 * `fetch` finds its call's 40 s, and the row count `get_data` type=metrics fetches with axios
 * directly (src/tools/socrata-tools.ts) is sent with the call's time bounds.
 *
 * Each call is sent as raw JSON-RPC through the real `createServer()` handlers, with the portal
 * client mocked so every request records the limit it ran under rather than being sent.
 */
import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';

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
import { currentCall, CALL_LIMIT_MS, REQUEST_LIMIT_MS, type CallBudget } from '../utils/call-budget.js';

const mockedFetch = vi.mocked(fetchFromSocrataApi);
const mockedAxiosGet = vi.mocked(axios.get);

const CONFIGURED_URL = 'https://data.cityofchicago.org';
const NAMED_HOST = 'data.portal-named-in-the-call.example';

/** The limit each request ran under, `undefined` for one outside any call. */
let limits: Array<CallBudget | undefined> = [];

function answerLikeAPortal(): void {
  mockedFetch.mockImplementation((async (path: string, params: Record<string, unknown> = {}) => {
    limits.push(currentCall());
    if (path.startsWith('/api/catalog/v1')) {
      return { results: [{ resource: { id: 'abcd-1234', name: 'A dataset', description: 'About noise' } }] };
    }
    if (/^\/api\/views\/[^/]+\/columns$/.test(path)) return [];
    if (path.startsWith('/api/views/')) return { name: 'A dataset', columns: [] };
    if (path.startsWith('/resource/')) {
      return params.$select === 'count(*)' ? [{ count: '1' }] : [{ ':id': 'row-1', status: 'open' }];
    }
    return {};
  }) as never);
  mockedAxiosGet.mockImplementation((async () => {
    limits.push(currentCall());
    return { data: [{ count: '1' }] };
  }) as never);
}

type JsonRpcResponse = {
  jsonrpc: '2.0';
  id: number;
  result?: { content?: Array<{ type: string; text: string }>; isError?: boolean };
  error?: { code: number; message: string };
};

/** A raw JSON-RPC client on the real server's handlers. */
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
    clientInfo: { name: 'call-limit-handlers', version: '1.0.0' }
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

const CALLS: Array<{ label: string; tool: string; args: Record<string, unknown> }> = [
  { label: 'get_data type=query', tool: 'get_data', args: { type: 'query', domain: NAMED_HOST, dataset_id: 'abcd-1234', where: "status = 'open'" } },
  { label: 'get_data type=catalog', tool: 'get_data', args: { type: 'catalog', domain: NAMED_HOST, query: 'noise' } },
  { label: 'get_data type=metadata', tool: 'get_data', args: { type: 'metadata', domain: NAMED_HOST, dataset_id: 'abcd-1234' } },
  { label: 'get_data type=metrics', tool: 'get_data', args: { type: 'metrics', domain: NAMED_HOST, dataset_id: 'abcd-1234' } },
  { label: 'search', tool: 'search', args: { query: 'noise' } },
  { label: 'fetch', tool: 'fetch', args: { id: `dataset:${NAMED_HOST}:abcd-1234` } }
];

describe('each tool call runs under one limit across its portal requests', () => {
  let rpc: Awaited<ReturnType<typeof connectRaw>>;
  const saved = process.env.DATA_PORTAL_URL;

  beforeAll(async () => {
    process.env.DATA_PORTAL_URL = CONFIGURED_URL;
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
    limits = [];
    answerLikeAPortal();
  });

  for (const call of CALLS) {
    it(`${call.label}: every request it makes runs under one 40 s limit`, async () => {
      const response = await rpc.callTool(call.tool, call.args);

      expect(response.error, JSON.stringify(response.error)).toBeUndefined();
      expect(limits.length).toBeGreaterThan(0);
      expect(limits.every((limit) => limit !== undefined && limit.deadline - limit.start === CALL_LIMIT_MS)).toBe(true);
      expect(new Set(limits).size).toBe(1);
    });
  }

  it("get_data type=metrics: the row count it fetches with axios directly carries the call's time bounds", async () => {
    await rpc.callTool('get_data', { type: 'metrics', domain: NAMED_HOST, dataset_id: 'abcd-1234' });

    expect(mockedAxiosGet).toHaveBeenCalledTimes(1);
    const config = mockedAxiosGet.mock.calls[0][1] as { timeout?: number; signal?: unknown };
    expect(config.timeout).toBeGreaterThan(0);
    expect(config.timeout).toBeLessThanOrEqual(REQUEST_LIMIT_MS);
    expect(config.signal).toBeInstanceOf(AbortSignal);
  });
});
