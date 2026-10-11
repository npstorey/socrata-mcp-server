/**
 * A blank string in an optional get_data field reads as absent (#76).
 *
 * MEASURED 2026-10-11 by the website's model evaluation (civic-ai-tools-website #573), against
 * the hosted server at 0.9.1. Two models fill every optional argument they are shown, and leave
 * the ones they do not need as "": `openai/gpt-6.1-sol`, and `openai/gpt-5.4`, which the website
 * offers. The site's get_data definition has ten properties, only `type` required and no minimum
 * length, but the server's schema had `query: z.string().min(1)`, so every metadata, metrics and
 * query call those models made was refused (gpt-5.4: 41 of 41). Their catalog calls carried a
 * real `query` and passed.
 *
 * THE FIXTURE IS THE EVALUATION'S OWN ARGUMENTS: one recorded call for each distinct argument
 * shape the two models sent (13 shapes across 75 calls), copied verbatim from the evaluation's
 * result files for civic-ai-tools-website #573 (eval-results-probe-20261011T192824Z,
 * eval-results-run-20261011T193446Z and eval-results-run-20261011T195739Z). `failedAt091` is
 * what the evaluation recorded for that call.
 *
 * Each call is sent as raw JSON-RPC through the real `createServer()` handlers, with the portal
 * client mocked so every request a call would make is recorded rather than sent.
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
import { createServer } from '../index.js';

const mockedFetch = vi.mocked(fetchFromSocrataApi);
const mockedAxiosGet = vi.mocked(axios.get);

type Recorded = { model: string; source: string; failedAt091: boolean; args: Record<string, unknown> };

const RECORDED: Recorded[] = [
  { model: 'openai/gpt-6.1-sol', source: 'probe-20261011T192824Z Q1', failedAt091: true,
    args: { type: 'query', portal: 'data.cityofnewyork.us', query: '', dataset_id: 'erm2-nwe9', limit: 1, offset: 0, select: '*', where: '', order: '', group: '' } },
  { model: 'openai/gpt-6.1-sol', source: 'probe-20261011T192824Z Q1', failedAt091: true,
    args: { type: 'metadata', portal: 'data.cityofnewyork.us', query: '', dataset_id: 'erm2-nwe9', limit: 1, offset: 0, select: '', where: '', order: '', group: '' } },
  { model: 'openai/gpt-5.4', source: 'run-20261011T193446Z Q1', failedAt091: true,
    args: { type: 'query', portal: 'data.cityofnewyork.us', query: '', dataset_id: 'erm2-nwe9', limit: 1, offset: 0, select: '', where: '', order: '', group: '' } },
  { model: 'openai/gpt-5.4', source: 'run-20261011T193446Z Q1', failedAt091: true,
    args: { type: 'query', portal: 'data.cityofnewyork.us', query: '', dataset_id: 'erm2-nwe9', limit: 1, offset: 0, select: 'COUNT(*) as complaint_count', where: "created_date >= '2026-09-01' AND created_date < '2026-10-01'", order: '', group: '' } },
  { model: 'openai/gpt-5.4', source: 'run-20261011T193446Z Q1', failedAt091: true,
    args: { type: 'query', portal: 'data.cityofnewyork.us', query: '', dataset_id: 'erm2-nwe9', limit: 3, offset: 0, select: '*', where: '', order: 'created_date DESC', group: '' } },
  { model: 'openai/gpt-5.4', source: 'run-20261011T193446Z Q1', failedAt091: true,
    args: { type: 'metrics', portal: 'data.cityofnewyork.us', query: '', dataset_id: 'erm2-nwe9', limit: 10, offset: 0, select: '', where: '', order: '', group: '' } },
  { model: 'openai/gpt-5.4', source: 'run-20261011T193446Z Q2', failedAt091: true,
    args: { type: 'query', portal: 'data.cityofchicago.org', query: '', dataset_id: '4ijn-s7e5', limit: 5, offset: 0, select: '*', where: '', order: '', group: '' } },
  { model: 'openai/gpt-5.4', source: 'run-20261011T193446Z Q2', failedAt091: true,
    args: { type: 'metadata', portal: 'data.cityofchicago.org', query: '', dataset_id: '4ijn-s7e5', limit: 10, offset: 0, select: '', where: '', order: '', group: '' } },
  { model: 'openai/gpt-5.4', source: 'run-20261011T193446Z Q4', failedAt091: true,
    args: { type: 'query', portal: 'data.cityofnewyork.us', query: '', dataset_id: 'erm2-nwe9', limit: 10, offset: 0, select: 'complaint_type, count(*) as count', where: "created_date >= '2026-01-01' AND created_date < '2026-10-12'", order: 'count DESC', group: 'complaint_type' } },
  { model: 'openai/gpt-5.4', source: 'run-20261011T193446Z Q7', failedAt091: false,
    args: { type: 'catalog', portal: 'data.cityofnewyork.us', query: 'restaurant inspections grade borough inspection date NYC', dataset_id: '', limit: 5, offset: 0, select: '', where: '', order: '', group: '' } },
  { model: 'openai/gpt-5.4', source: 'run-20261011T193446Z Q8', failedAt091: true,
    args: { type: 'query', portal: 'data.cityofchicago.org', query: '', dataset_id: 'exe4-wf95', limit: 5, offset: 0, select: 'name, job_titles, department, annual_salary', where: 'annual_salary IS NOT NULL', order: 'annual_salary DESC', group: '' } },
  { model: 'openai/gpt-6.1-sol', source: 'run-20261011T195739Z Q6', failedAt091: false,
    args: { type: 'catalog', portal: 'data.seattle.gov', query: 'building permits', dataset_id: '', limit: 3, offset: 0, select: '', where: '', order: '', group: '' } },
  { model: 'openai/gpt-6.1-sol', source: 'run-20261011T195739Z Q6', failedAt091: true,
    args: { type: 'query', portal: 'data.seattle.gov', query: '', dataset_id: '76t5-zqzr', limit: 100, offset: 0, select: 'permitclass, count(*) AS total_permits, count(estprojectcost) AS permits_with_cost, avg(estprojectcost) AS avg_project_cost', where: "issueddate >= '2026-04-14T00:00:00' AND issueddate < '2026-10-11T00:00:00'", order: 'avg_project_cost DESC', group: 'permitclass' } }
];

/** Answers each request shape the handlers make, enough for every branch to run to a result. */
function answerLikeAPortal(): void {
  mockedFetch.mockImplementation((async (path: string, params: Record<string, unknown> = {}) => {
    if (path.startsWith('/api/catalog/v1')) {
      return { results: [{ resource: { id: 'abcd-1234', name: 'A dataset', description: 'About permits' } }] };
    }
    if (path.startsWith('/api/views/')) return { name: 'A dataset', columns: [] };
    if (path.startsWith('/resource/')) {
      return params.$select === 'count(*)' ? [{ count: '1' }] : [{ ':id': 'row-1', status: 'open' }];
    }
    return {};
  }) as never);
  mockedAxiosGet.mockResolvedValue({ data: [{ count: '1' }] } as never);
}

/** Every parameter value the call's requests carried, as `name=value`. */
function requestParams(): string[] {
  return mockedFetch.mock.calls.flatMap(([, params]) =>
    Object.entries((params ?? {}) as Record<string, unknown>).map(([name, value]) => `${name}=${String(value)}`)
  );
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
    clientInfo: { name: 'blank-optional-fields', version: '1.0.0' }
  });
  await clientSide.send({ jsonrpc: '2.0', method: 'notifications/initialized' } as JSONRPCMessage);
  return {
    getData: (args: Record<string, unknown>) => request('tools/call', { name: 'get_data', arguments: args }),
    close: async () => {
      await clientSide.close();
      await server.close();
    }
  };
}

describe('get_data with blank optional fields, as two models send them', () => {
  let rpc: Awaited<ReturnType<typeof connectRaw>>;

  beforeAll(async () => {
    rpc = await connectRaw();
  });

  afterAll(async () => {
    await rpc?.close();
  });

  beforeEach(() => {
    vi.clearAllMocks();
    answerLikeAPortal();
  });

  it('the fixture covers the shapes it claims: 13, all four operation types, 11 refused at 0.9.1', () => {
    expect(RECORDED).toHaveLength(13);
    expect(new Set(RECORDED.map((r) => r.args.type))).toEqual(new Set(['catalog', 'metadata', 'query', 'metrics']));
    expect(RECORDED.filter((r) => r.failedAt091)).toHaveLength(11);
  });

  for (const recorded of RECORDED) {
    const blanks = Object.keys(recorded.args).filter((name) => recorded.args[name] === '');
    it(`${recorded.model} ${recorded.args.type} (${recorded.source}), blank: ${blanks.join(', ')}: answers, and sends no blank`, async () => {
      const response = await rpc.getData(recorded.args);
      expect(response.error, JSON.stringify(response.error)).toBeUndefined();
      expect(response.result?.isError).toBe(false);
      expect(mockedFetch.mock.calls.length).toBeGreaterThan(0);
      // A blank field is absent from every request, not sent as an empty clause or search.
      expect(requestParams().filter((p) => /=\s*$/.test(p))).toEqual([]);
      if (recorded.args.type === 'query') {
        expect(requestParams().some((p) => p.startsWith('$q='))).toBe(false);
      }
    });
  }

  it('whitespace reads as blank too, in every optional field', async () => {
    const response = await rpc.getData({
      type: 'query', portal: 'data.cityofnewyork.us', dataset_id: 'erm2-nwe9',
      query: ' ', domain: '  ', limit: ' ', offset: ' ', select: ' ', where: '\t', order: ' ', group: ' ', having: ' ', q: ' '
    });
    expect(response.error, JSON.stringify(response.error)).toBeUndefined();
    expect(requestParams().filter((p) => /=\s*$/.test(p))).toEqual([]);
  });

  it('a blank limit and offset take their defaults (10 and 0), not zero', async () => {
    await rpc.getData({ type: 'query', portal: 'data.cityofnewyork.us', dataset_id: 'erm2-nwe9', limit: '', offset: '' });
    const dataRequest = mockedFetch.mock.calls.find(([, params]) => (params as Record<string, unknown>).$select !== 'count(*)');
    expect(dataRequest?.[1]).toMatchObject({ $limit: 10, $offset: 0 });
  });

  it('the required field is still required: type "" is refused, and no request is made', async () => {
    const response = await rpc.getData({ type: '', portal: 'data.cityofnewyork.us', dataset_id: 'erm2-nwe9' });
    expect(response.result).toBeUndefined();
    expect(response.error?.message).toMatch(/type/);
    expect(mockedFetch).not.toHaveBeenCalled();
  });

  it('a value that is present is still checked: limit 0 is refused', async () => {
    const response = await rpc.getData({ type: 'query', portal: 'data.cityofnewyork.us', dataset_id: 'erm2-nwe9', limit: 0 });
    expect(response.result).toBeUndefined();
    expect(mockedFetch).not.toHaveBeenCalled();
  });
});
