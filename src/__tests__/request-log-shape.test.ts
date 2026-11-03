/**
 * A request is logged by its shape, never its text (#81).
 *
 * A reader's question reaches this server as words in a tool call's `where`, `q`, `select` and
 * `query`, a search phrase, a fetch id, and a prompt's arguments. The server used to log each
 * request whole: the SDK handler wrapper, the CallTool handler, each tool's arguments and parsed
 * parameters, the HTTP layer's request body, and the response bodies, which carry a portal's
 * refusal of a query with the query quoted back (measured 2026-11-03 against a public portal: a
 * malformed `$where` is answered 400 with the query in `message` and in `data.query`). On the
 * hosted server those lines go to the hosting provider's logs.
 *
 * This drives the real HTTP app (`startApp`, the Express handler and its response interceptors,
 * OpenAICompatibleTransport, the SDK transport, every request handler) on a port of its own, with
 * axios's adapter standing in for the portal, and puts a marker in every place a reader's text can
 * go. Every line written through `console` or to stdout and stderr is captured, and no marker may
 * appear in any of them, read as written or with a logged byte list decoded (`readable`). What a caller receives is checked to be what it was: the rows of a
 * query, and a portal's refusal quoting the query.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import axios, { AxiosError, type AxiosAdapter, type AxiosResponse, type InternalAxiosRequestConfig } from 'axios';
import { format } from 'node:util';
import { request as httpRequest, type Server as HttpServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { LATEST_PROTOCOL_VERSION } from '@modelcontextprotocol/sdk/types.js';
import { startApp } from '../index.js';

const PORTAL = 'portal.example.test';
const DATASET = 'abcd-1234';
/** Every marker starts with this, so one pattern finds any of them in a captured line. */
const MARKER = /M81[A-Z]/;
/**
 * A chunk the SDK's HTTP adapter writes is a Uint8Array, and `String(chunk)` of one is its bytes
 * as decimal numbers (`101,118,101,...`), which is the response's text, encoded. A line is read
 * with every such list decoded, so a response written to the log that way is found too.
 */
const BYTE_LIST = /\d{1,3}(?:,\d{1,3}){15,}/g;
function readable(line: string): string {
  const lists = line.match(BYTE_LIST) ?? [];
  return [line, ...lists.map((list) => Buffer.from(list.split(',').map(Number)).toString())].join('\n');
}
/** A query holding this is refused by the fake portal, which quotes the query back as Socrata does. */
const REFUSE = 'M81REFUSE';

// ---------------------------------------------------------------------------------------------
// The portal: axios's adapter, answering the endpoints the tools call.
// ---------------------------------------------------------------------------------------------

const portalRequests: string[] = [];

function answer(config: InternalAxiosRequestConfig, status: number, data: unknown): AxiosResponse {
  return { data, status, statusText: status === 200 ? 'OK' : 'Bad Request', headers: {}, config };
}

const fakePortal: AxiosAdapter = async (config) => {
  const url = new URL(config.url ?? '', config.baseURL);
  const body = typeof config.data === 'string' ? config.data : JSON.stringify(config.data ?? '');
  portalRequests.push(`${config.method} ${url.pathname}${url.search} ${body} ${JSON.stringify(config.params ?? {})}`);

  if (/\/api\/v3\/views\/[\w-]+\/query\.json$/.test(url.pathname)) {
    const query = String(JSON.parse(body).query ?? '');
    if (query.includes(REFUSE)) {
      const refusal = answer(config, 400, {
        code: 'query.compiler.malformed',
        error: true,
        message: `Could not parse SoQL query "${query}" at line 1 character 7`,
        data: { query, position: {} }
      });
      throw new AxiosError('Request failed with status code 400', AxiosError.ERR_BAD_REQUEST, config, {}, refusal);
    }
    return answer(config, 200, [{ ':id': 'row-1', name: 'first' }, { ':id': 'row-2', name: 'second' }]);
  }
  if (url.pathname.startsWith('/api/catalog/v1')) {
    return answer(config, 200, { results: [], resultSetSize: 0 });
  }
  if (/^\/api\/views\/[\w-]+\/columns$/.test(url.pathname)) {
    return answer(config, 200, [{ name: 'name', fieldName: 'name', dataTypeName: 'text' }]);
  }
  if (/^\/api\/views\/[\w-]+$/.test(url.pathname)) {
    return answer(config, 200, { id: DATASET, name: 'Fake dataset', columns: [{ name: 'name', fieldName: 'name', dataTypeName: 'text' }] });
  }
  throw new AxiosError('Request failed with status code 404', AxiosError.ERR_BAD_REQUEST, config, {}, answer(config, 404, { error: true }));
};

// ---------------------------------------------------------------------------------------------
// The log: every console call and every write to stdout and stderr, as the text it would print.
// ---------------------------------------------------------------------------------------------

const logLines: string[] = [];

function capture(): () => void {
  const restores: Array<() => void> = [];
  for (const method of ['log', 'error', 'warn', 'info', 'debug'] as const) {
    const spy = vi.spyOn(console, method).mockImplementation((...args: unknown[]) => {
      logLines.push(format(...args));
    });
    restores.push(() => spy.mockRestore());
  }
  for (const stream of [process.stdout, process.stderr]) {
    const original = stream.write.bind(stream);
    const spy = vi.spyOn(stream, 'write').mockImplementation(((chunk: unknown, ...rest: unknown[]) => {
      logLines.push(typeof chunk === 'string' ? chunk : Buffer.from(chunk as Uint8Array).toString());
      return (original as (...a: unknown[]) => boolean)(chunk, ...rest);
    }) as typeof stream.write);
    restores.push(() => spy.mockRestore());
  }
  return () => restores.forEach((restore) => restore());
}

// ---------------------------------------------------------------------------------------------
// The client: JSON-RPC over the HTTP app.
// ---------------------------------------------------------------------------------------------

type Rpc = { id?: number; result?: Record<string, unknown>; error?: { code: number; message: string } };

let server: HttpServer;
let base: string;
let sessionId = '';
let nextId = 1;

function parseRpc(text: string): Rpc[] {
  const trimmed = text.trim();
  if (trimmed === '') return [];
  if (trimmed.startsWith('{') || trimmed.startsWith('[')) return [].concat(JSON.parse(trimmed));
  return trimmed
    .split('\n')
    .filter((line) => line.startsWith('data:'))
    .map((line) => JSON.parse(line.slice('data:'.length).trim()));
}

/**
 * One request on a connection of its own (`agent: false`), so a reply's framing cannot reach the
 * next exchange. The server's reply to a body that is not JSON declares the length of one body
 * (89 bytes) and sends the parse error's text, which is longer or shorter (measured 2026-11-03,
 * on main as on this branch); on a kept-alive connection its stray bytes failed the next request.
 */
function send(method: 'POST' | 'DELETE', body?: string): Promise<{ status: number; text: string; session: string | null }> {
  return new Promise((resolve, reject) => {
    const req = httpRequest(
      `${base}/mcp`,
      {
        method,
        agent: false,
        headers: {
          'content-type': 'application/json',
          accept: 'application/json, text/event-stream',
          'mcp-protocol-version': LATEST_PROTOCOL_VERSION,
          ...(sessionId ? { 'mcp-session-id': sessionId } : {})
        }
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (chunk: Buffer) => chunks.push(chunk));
        res.on('error', reject);
        res.on('end', () => {
          const session = res.headers['mcp-session-id'];
          resolve({ status: res.statusCode ?? 0, text: Buffer.concat(chunks).toString(), session: typeof session === 'string' ? session : null });
        });
      }
    );
    req.on('error', reject);
    req.end(body);
  });
}

function post(body: string) {
  return send('POST', body);
}

async function call(method: string, params: Record<string, unknown>): Promise<Rpc> {
  const id = nextId++;
  const { text } = await post(JSON.stringify({ jsonrpc: '2.0', id, method, params }));
  const reply = parseRpc(text).find((message) => message.id === id);
  if (!reply) throw new Error(`no reply to ${method} (id ${id}): ${text.slice(0, 200)}`);
  return reply;
}

function contentText(reply: Rpc): string {
  const content = (reply.result?.content ?? []) as Array<{ text?: string }>;
  return content.map((item) => item.text ?? '').join('\n');
}

// ---------------------------------------------------------------------------------------------

const savedAdapter = axios.defaults.adapter;
const savedPortal = process.env.DATA_PORTAL_URL;
let restoreConsole: () => void = () => {};
/** The signal handlers startApp adds; removed after, so the worker's own exit is not a shutdown. */
const addedSignalHandlers: Array<[NodeJS.Signals, (...args: unknown[]) => void]> = [];

beforeAll(async () => {
  axios.defaults.adapter = fakePortal;
  // `search` and a prompt use the configured default portal (read per call).
  process.env.DATA_PORTAL_URL = `https://${PORTAL}`;
  restoreConsole = capture();
  const before = { SIGTERM: process.listeners('SIGTERM'), SIGINT: process.listeners('SIGINT') };
  server = await startApp(0);
  for (const signal of ['SIGTERM', 'SIGINT'] as const) {
    for (const handler of process.listeners(signal)) {
      if (!before[signal].includes(handler)) addedSignalHandlers.push([signal, handler as (...args: unknown[]) => void]);
    }
  }
  if (!server.listening) await new Promise((resolve) => server.once('listening', resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  const init = await post(
    JSON.stringify({
      jsonrpc: '2.0',
      id: nextId++,
      method: 'initialize',
      params: { protocolVersion: LATEST_PROTOCOL_VERSION, capabilities: {}, clientInfo: { name: 'log-shape-test', version: '1.0.0' } }
    })
  );
  expect(init.status).toBe(200);
  sessionId = init.session ?? '';
  expect(sessionId).not.toBe('');
  await post(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }));
}, 30_000);

afterAll(async () => {
  if (sessionId) await send('DELETE');
  for (const [signal, handler] of addedSignalHandlers) process.removeListener(signal, handler);
  restoreConsole();
  axios.defaults.adapter = savedAdapter;
  if (savedPortal === undefined) delete process.env.DATA_PORTAL_URL;
  else process.env.DATA_PORTAL_URL = savedPortal;
  server?.closeAllConnections();
  await new Promise((resolve) => server?.close(resolve));
});

describe('a request is logged by its shape, never its text (#81)', () => {
  const replies: Record<string, Rpc> = {};

  beforeAll(async () => {
    replies.query = await call('tools/call', {
      name: 'get_data',
      arguments: {
        type: 'query',
        domain: PORTAL,
        dataset_id: DATASET,
        select: 'name, M81SELECT',
        where: "name = 'M81WHERE'",
        q: 'M81QPHRASE',
        order: 'M81ORDER',
        limit: 5,
        offset: 0
      }
    });
    replies.refused = await call('tools/call', {
      name: 'get_data',
      arguments: { type: 'query', domain: PORTAL, dataset_id: DATASET, select: 'M81SELECT', where: `name = '${REFUSE}'`, q: 'M81QPHRASE' }
    });
    replies.soql = await call('tools/call', {
      name: 'get_data',
      arguments: { type: 'query', domain: PORTAL, dataset_id: DATASET, query: "SELECT name WHERE name = 'M81SOQL'" }
    });
    replies.catalog = await call('tools/call', {
      name: 'get_data',
      arguments: { type: 'catalog', domain: PORTAL, query: 'M81CATALOG' }
    });
    replies.badType = await call('tools/call', {
      name: 'get_data',
      arguments: { type: 'M81ENUM', domain: PORTAL, where: 'M81WHERE' }
    });
    replies.search = await call('tools/call', { name: 'search', arguments: { query: 'M81SEARCH' } });
    replies.fetch = await call('tools/call', { name: 'fetch', arguments: { id: `record:${PORTAL}:${DATASET}:M81RECORD` } });
    replies.badFetch = await call('tools/call', { name: 'fetch', arguments: { id: 'M81FETCHID' } });
    replies.prompt = await call('prompts/get', { name: 'find_dataset', arguments: { description: 'M81PROMPT' } });
    replies.skill = await call('prompts/get', { name: 'skill-guidance', arguments: { modality: 'M81MODALITY' } });
    // A body that is not JSON: a parse error's message quotes the text it failed on. Only the log
    // is read here; the reply's framing is mismatched (see `send`), so the client may refuse it.
    await post('{"jsonrpc":"2.0","id":99,"method":"tools/call","params":{"name":"get_data","arguments":{"where":"M81PARSE" oops').catch(() => undefined);
  }, 60_000);

  it('the markers reached the portal, so they were in play', () => {
    const sent = portalRequests.join('\n');
    // `q` is not among them: the data path's SoQL body (src/utils/api.ts, buildSoda3QueryString)
    // carries no `$q`, so a `q` argument is logged (its shape is checked below) but never sent.
    for (const marker of ['M81SELECT', 'M81WHERE', 'M81ORDER', 'M81SOQL', 'M81CATALOG', 'M81SEARCH', 'M81RECORD', REFUSE]) {
      expect(sent).toContain(marker);
    }
  });

  it('no line written to the console, stdout or stderr carries a marker', () => {
    expect(logLines.length).toBeGreaterThan(0);
    const leaked = logLines.filter((line) => MARKER.test(readable(line)));
    expect(leaked, `lines carrying a marker:\n${leaked.map((line) => line.slice(0, 300)).join('\n---\n')}`).toEqual([]);
  });

  it('a tool call is logged by its shape: tool, portal, dataset, each text argument by length, limit and offset as numbers', () => {
    const shape = `[Server] CallTool: tool=get_data portal=${PORTAL} dataset=${DATASET} args=type=query,domain:${PORTAL.length},dataset_id:${DATASET.length},select:${'name, M81SELECT'.length},where:${"name = 'M81WHERE'".length},q:${'M81QPHRASE'.length},order:${'M81ORDER'.length},limit=5,offset=0`;
    expect(logLines).toContain(shape);
  });

  it("the HTTP layer's request and response lines ran, and name a message by its shape", () => {
    expect(logLines.some((l) => /^\[Express\] Request body: method=tools\/call id=\d+ bytes=\d+$/.test(l))).toBe(true);
    expect(logLines.some((l) => /^\[OpenAICompatibleTransport\] Request body: method=tools\/call id=\d+ bytes=\d+$/.test(l))).toBe(true);
    expect(logLines.some((l) => /^\[Transport\] onmessage fired! method=tools\/call id=\d+ bytes=\d+$/.test(l))).toBe(true);
    expect(logLines.some((l) => l.startsWith('[Express] Response.write called, data length:'))).toBe(true);
    expect(logLines.some((l) => l.startsWith('[OpenAICompatibleTransport] Failed to parse body: class=SyntaxError message_chars='))).toBe(true);
  });

  it('a refused query is logged by class, codes and status, and its text is not', () => {
    const line = logLines.find((l) => l.startsWith('[Tool] Error: ') && l.includes('status=400'));
    expect(line).toMatch(/^\[Tool\] Error: class=Error status=400 code=ERR_BAD_REQUEST message_chars=\d+ cause=AxiosError/);
  });

  it('what a caller receives is unchanged: the rows, and the portal refusal quoting the query', () => {
    expect(replies.query.error).toBeUndefined();
    expect(contentText(replies.query)).toContain('row-2');
    expect(replies.refused.error?.message).toContain('API request failed: 400');
    expect(replies.refused.error?.message).toContain(REFUSE);
    expect(replies.badType.error?.code).toBeDefined();
    expect(replies.prompt.error).toBeUndefined();
  });
});
