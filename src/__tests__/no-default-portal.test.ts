/**
 * A call that names no portal, on a server with no default portal configured, is refused per
 * call as a JSON-RPC error (server#63; civic-ai-tools-website#434, ruling D6 = B).
 *
 * Adopted from the red instrument on draft PR #66, which failed at c3c2f88 on all three of its
 * shapes: each recorded a request against the portal the old code fallback named instead of
 * refusing. Its three shapes are kept verbatim below the transport; this file widens them to
 * every call shape that used a default, and drives them to the envelope a client receives.
 *
 * WHY THE ENVELOPE AND NOT THE THROW. The website's client records a call as rejected only when
 * the response is a JSON-RPC `error`; a result carrying `isError: true` reads as an answer. So
 * the refusal is asserted where a client meets it: raw JSON-RPC messages sent through the real
 * `createServer()` handlers over an in-memory transport, and each response read whole — an
 * `error` with code -32602 and a message, and no `result`.
 *
 * THE FIXTURE CAN FAIL IN EVERY DIRECTION. The Socrata client is mocked, so every request a call
 * would make is recorded rather than sent.
 *   - Unset: each portal-less shape must be refused AND record no request.
 *   - Unset: the same shapes naming a portal must still answer, against that portal — a server
 *     that refused everything fails here.
 *   - Set: the configured portal is not the one the old fallback named, so a surviving fallback
 *     and the configured default record different requests; and a shape naming a portal must
 *     reach that portal, never the configured one.
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
import { handleSearchTool, handleFetchTool, handleSocrataTool } from '../tools/socrata-tools.js';

const mockedFetch = vi.mocked(fetchFromSocrataApi);
const mockedAxiosGet = vi.mocked(axios.get);

/** Not the portal the removed fallback named, so a survivor and a fix record different requests. */
const CONFIGURED_URL = 'https://data.cityofchicago.org';
const CONFIGURED_HOST = 'data.cityofchicago.org';
/** The host the removed fallback named. No recorded request may carry it in any state. */
const OLD_FALLBACK_HOST = 'data.cityofnewyork.us';
/** A portal a call names for itself. */
const NAMED_HOST = 'data.portal-named-in-the-call.example';

/**
 * Words the website's failure classifier reads as "the source was unreachable, slow or
 * rate-limited" (civic-ai-tools-website `src/lib/streaming.ts` `classifyStreamError`, at
 * ea1164c), plus `parse`, which its client's SSE branch (`src/lib/mcp/client.ts`) treats as a
 * parse failure and replaces. A refusal is none of those things, so its text carries none of
 * them. The website's own classifier is the authority; this copy is a local early warning.
 */
const MISCLASSIFYING_WORDS = [
  'unavailable', 'mcp server', 'mcp tool', 'initialization failed', 'econnrefused', 'enotfound',
  'fetch failed', '502', '503', '504', 'failed to connect', 'no response body', 'network',
  'connection', 'timed out', 'timeout', 'did not respond within', 'rate limit', '429',
  'socrata_mcp_url', 'no model api key', 'missing credentials', 'invalid api key',
  'incorrect api key', 'parse'
];

type ToolName = 'get_data' | 'fetch' | 'search';
type Shape = { label: string; tool: ToolName; args: Record<string, unknown>; nextStep: string };

/** Every call shape that used to fall back to a default portal. */
const PORTAL_LESS: Shape[] = [
  { label: 'get_data type=catalog', tool: 'get_data', args: { type: 'catalog', query: 'noise' }, nextStep: '"domain"' },
  { label: 'get_data type=metadata', tool: 'get_data', args: { type: 'metadata', dataset_id: 'abcd-1234' }, nextStep: '"domain"' },
  {
    label: 'get_data type=query (the dataset-query branch)',
    tool: 'get_data',
    args: { type: 'query', dataset_id: 'abcd-1234', where: "status = 'open'" },
    nextStep: '"domain"'
  },
  { label: 'get_data type=metrics', tool: 'get_data', args: { type: 'metrics', dataset_id: 'abcd-1234' }, nextStep: '"domain"' },
  { label: 'fetch by a bare dataset id', tool: 'fetch', args: { id: 'abcd-1234' }, nextStep: 'dataset:<portal-host>:<dataset-id>' },
  { label: 'fetch by dataset-id:row-id', tool: 'fetch', args: { id: 'abcd-1234:row-1' }, nextStep: 'dataset:<portal-host>:<dataset-id>' },
  { label: 'search', tool: 'search', args: { query: 'noise' }, nextStep: 'get_data with type "catalog"' }
];

/** The same families, naming a portal. These must answer, against that portal, in both states. */
const NAMING_A_PORTAL: Shape[] = [
  { label: 'get_data type=catalog with domain', tool: 'get_data', args: { type: 'catalog', query: 'noise', domain: NAMED_HOST }, nextStep: '' },
  {
    label: 'get_data type=query with the portal alias',
    tool: 'get_data',
    args: { type: 'query', dataset_id: 'abcd-1234', portal: NAMED_HOST },
    nextStep: ''
  },
  { label: 'fetch dataset:<portal>:<id>', tool: 'fetch', args: { id: `dataset:${NAMED_HOST}:abcd-1234` }, nextStep: '' },
  { label: 'fetch <portal>:<id>', tool: 'fetch', args: { id: `${NAMED_HOST}:abcd-1234` }, nextStep: '' },
  { label: 'fetch by the dataset URL', tool: 'fetch', args: { id: `https://${NAMED_HOST}/d/abcd-1234` }, nextStep: '' }
];

/** Answers each request shape the handlers make, enough for every branch to run to a result. */
function answerLikeAPortal(): void {
  mockedFetch.mockImplementation((async (path: string, params: Record<string, unknown> = {}) => {
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
  mockedAxiosGet.mockResolvedValue({ data: [{ count: '1' }] } as never);
}

/** Every request a call made, as the base URL and path it addressed. */
function recordedRequests(): string[] {
  return [
    ...mockedFetch.mock.calls.map(([path, params, baseUrl]) => `${String(baseUrl)}${path} ${JSON.stringify(params ?? {})}`),
    ...mockedAxiosGet.mock.calls.map(([url, config]) => `${String(url)} ${JSON.stringify(config ?? {})}`)
  ];
}

function hostsAddressed(): string[] {
  return [
    ...mockedFetch.mock.calls.map(([, , baseUrl]) => String(baseUrl)),
    ...mockedAxiosGet.mock.calls.map(([url]) => String(url))
  ].map((url) => new URL(url).hostname);
}

type JsonRpcResponse = {
  jsonrpc: '2.0';
  id: number;
  result?: { content?: Array<{ type: string; text: string }>; isError?: boolean };
  error?: { code: number; message: string; data?: unknown };
};

/** A raw JSON-RPC client on the real server's handlers: what goes out and comes back is the envelope. */
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
    clientInfo: { name: 'no-default-portal', version: '1.0.0' }
  });
  await clientSide.send({ jsonrpc: '2.0', method: 'notifications/initialized' } as JSONRPCMessage);
  return {
    callTool: (shape: Shape) => request('tools/call', { name: shape.tool, arguments: shape.args }),
    close: async () => {
      await clientSide.close();
      await server.close();
    }
  };
}

describe('tools/call through the real handlers', () => {
  let rpc: Awaited<ReturnType<typeof connectRaw>>;
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
    // The record cache is keyed by dataset and row id, not by portal, so a row cached by one
    // shape would answer the same identifier in the next without a request. Cleared so each
    // shape's recorded requests are its own. (That the key carries no portal is a separate
    // defect, reported with this change rather than fixed in it.)
    documentCache.clear();
    answerLikeAPortal();
  });

  describe('DATA_PORTAL_URL unset: no default portal', () => {
    beforeEach(() => {
      delete process.env.DATA_PORTAL_URL;
    });

    for (const shape of PORTAL_LESS) {
      it(`${shape.label}: a JSON-RPC error (-32602) with a message, no result, and no request made`, async () => {
        const response = await rpc.callTool(shape);
        expect({
          hasResult: 'result' in response,
          code: response.error?.code,
          messageIsText: typeof response.error?.message === 'string' && response.error.message.trim().length > 0,
          requests: recordedRequests()
        }).toEqual({ hasResult: false, code: -32602, messageIsText: true, requests: [] });
      });

      it(`${shape.label}: the refusal says how to name a portal and asserts no outage`, async () => {
        const message = (await rpc.callTool(shape)).error?.message ?? '';
        expect(message).toContain('names no portal');
        expect(message).toContain(shape.nextStep);
        const misleading = MISCLASSIFYING_WORDS.filter((word) => message.toLowerCase().includes(word));
        expect(misleading, message).toEqual([]);
      });
    }

    for (const shape of NAMING_A_PORTAL) {
      it(`${shape.label}: answers, against the portal the call named`, async () => {
        const response = await rpc.callTool(shape);
        expect(response.error, JSON.stringify(response.error)).toBeUndefined();
        expect(response.result?.isError).toBe(false);
        expect(hostsAddressed().length).toBeGreaterThan(0);
        expect([...new Set(hostsAddressed())]).toEqual([NAMED_HOST]);
      });
    }
  });

  describe(`DATA_PORTAL_URL set to ${CONFIGURED_URL}: the configured default, unchanged`, () => {
    beforeEach(() => {
      process.env.DATA_PORTAL_URL = CONFIGURED_URL;
    });

    for (const shape of PORTAL_LESS) {
      it(`${shape.label}: answers against the configured portal, and only it`, async () => {
        const response = await rpc.callTool(shape);
        expect(response.error, JSON.stringify(response.error)).toBeUndefined();
        expect(response.result?.isError).toBe(false);
        expect(hostsAddressed().length).toBeGreaterThan(0);
        expect([...new Set(hostsAddressed())]).toEqual([CONFIGURED_HOST]);
        expect(recordedRequests().join('\n')).not.toContain(OLD_FALLBACK_HOST);
      });
    }

    it('search attributes each result to the configured portal it came from', async () => {
      const response = await rpc.callTool(PORTAL_LESS.find((s) => s.tool === 'search')!);
      const payload = JSON.parse(response.result?.content?.[0].text ?? '{}');
      expect(payload.results.map((r: { id: string; url: string }) => [r.id, r.url])).toEqual([
        [`dataset:${CONFIGURED_HOST}:abcd-1234`, `https://${CONFIGURED_HOST}/dataset/abcd-1234`]
      ]);
    });

    for (const shape of NAMING_A_PORTAL) {
      it(`${shape.label}: reaches the portal the call named, not the configured one`, async () => {
        const response = await rpc.callTool(shape);
        expect(response.error, JSON.stringify(response.error)).toBeUndefined();
        expect([...new Set(hostsAddressed())]).toEqual([NAMED_HOST]);
      });
    }
  });
});

// The red instrument from draft PR #66, kept verbatim in substance: the three portal-less shapes,
// called on the handlers directly, below any transport.
describe('no DATA_PORTAL_URL configured: a call naming no portal is refused, and no request is made for it', () => {
  let saved: string | undefined;

  beforeEach(() => {
    saved = process.env.DATA_PORTAL_URL;
    delete process.env.DATA_PORTAL_URL;
    vi.clearAllMocks();
    mockedFetch.mockResolvedValue({ results: [] } as never);
  });

  afterAll(() => {
    if (saved === undefined) delete process.env.DATA_PORTAL_URL;
    else process.env.DATA_PORTAL_URL = saved;
  });

  const shapes: Array<[string, () => Promise<unknown>]> = [
    ['get_data catalog with no domain', () => handleSocrataTool({ type: 'catalog', query: 'noise' })],
    ['fetch of a bare dataset id', () => handleFetchTool({ id: 'abcd-1234' })],
    ['search', () => handleSearchTool({ query: 'noise' })]
  ];

  for (const [name, call] of shapes) {
    it(`${name}: refused, with no request made on the caller's behalf`, async () => {
      let refused = false;
      try {
        await call();
      } catch {
        refused = true;
      }
      const recorded = mockedFetch.mock.calls.map((args) => JSON.stringify(args));
      expect({ refused, recordedRequests: recorded }).toEqual({ refused: true, recordedRequests: [] });
    });
  }
});
