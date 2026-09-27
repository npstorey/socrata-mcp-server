/**
 * `initialize` answers a protocol version this server supports (socrata-mcp-server#70).
 *
 * WHAT WAS WRONG. `src/index.ts` replaces the SDK's `initialize` handler with its own (to add
 * the non-standard body `sessionId` member for the OpenAI-connector handshake), and that
 * handler answered whatever `protocolVersion` the client sent, substituting `2025-01-01` for an
 * empty one. A client that asked for a revision the installed SDK does not know was told "agreed",
 * and its next request carrying that version was refused by the SDK's HTTP transport:
 *   400 -32000 "Bad Request: Unsupported protocol version: 2026-07-28 (supported versions: ...)"
 * The lifecycle page of the 2025-11-25 specification says a server that does not support the
 * requested version answers with another version it does support. The SDK's own handler does
 * exactly that: the requested version when it is in `SUPPORTED_PROTOCOL_VERSIONS`, otherwise
 * `LATEST_PROTOCOL_VERSION`.
 *
 * WHAT THIS DRIVES — the real handler, not a copy of it.
 *  1. The real `createServer()` from `src/index.ts` over an in-memory transport, one raw
 *     JSON-RPC `initialize` per row of the table. Each answer is compared with the table and
 *     with what a stock SDK `Server` answers to the same request (the oracle is the SDK's own
 *     handler, run, not its rule re-typed here).
 *  2. The real `createServer(transport)` behind `OpenAICompatibleTransport` over the SDK's
 *     Streamable HTTP transport, dispatched without binding a socket, wired the way
 *     `startApp()` wires `/mcp` (Accept shim, `express.text`, the raw text body handed on as
 *     `parsedBody`). For each row: `initialize`, then `tools/list` carrying
 *     `MCP-Protocol-Version` equal to the version the server answered, which must be 200 — the
 *     step that caught #70. Plus the website's own handshake: `initialize` at `2024-11-05` and
 *     no `MCP-Protocol-Version` header on any request.
 *
 * WHY NOT THE EXISTING TESTS. `protocol-ceiling.test.ts` builds a stock `Server` behind the
 * transport (a replica of the chain, not this server's handler), and `openai-initialize.test.ts`
 * holds its own copy of the old version line. Both are pinned by earlier waves and stay unedited;
 * `no-default-portal.test.ts` sends `initialize` through the real handler but never reads the
 * version it answers.
 *
 * STATED BLIND SPOTS.
 *  1. The HTTP chain here is rebuilt from `startApp()`, which is not exported and binds a port;
 *     its per-session `transports` map, logging wrappers and response interceptors are not
 *     exercised. `scripts/smoke-deployed-endpoint.mjs` drives the deployed chain over the wire.
 *  2. The table's expectations are SDK 1.30.0's constants, stated as literals. The premise block
 *     fails first, and says so, if a dependency bump moves them.
 */
import { describe, test, expect, afterEach } from 'vitest';
import http from 'http';
import { Socket } from 'net';
import express from 'express';
import crypto from 'crypto';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import {
  LATEST_PROTOCOL_VERSION,
  SUPPORTED_PROTOCOL_VERSIONS,
  type JSONRPCMessage
} from '@modelcontextprotocol/sdk/types.js';
import { createServer } from '../index.js';
import { OpenAICompatibleTransport } from '../openai-compatible-transport.js';

/** The version this server falls back to under SDK 1.30.0 (its LATEST_PROTOCOL_VERSION). */
const FALLBACK = '2025-11-25';

type Row = { requested: string; answered: string; why: string };

const UNSUPPORTED: Row[] = [
  { requested: '2026-07-28', answered: FALLBACK, why: 'a later revision this SDK does not implement' },
  { requested: '1900-01-01', answered: FALLBACK, why: 'a date that is no protocol revision' },
  { requested: '', answered: FALLBACK, why: 'empty (the old handler substituted 2025-01-01)' }
];

const SUPPORTED: Row[] = [
  { requested: '2024-11-05', answered: '2024-11-05', why: "the website client's handshake" },
  { requested: '2025-06-18', answered: '2025-06-18', why: 'a supported earlier revision' },
  { requested: '2025-11-25', answered: '2025-11-25', why: 'the latest supported revision' }
];

const ROWS: Row[] = [...UNSUPPORTED, ...SUPPORTED];

const label = (row: Row) => `${JSON.stringify(row.requested)} (${row.why})`;

function initializeParams(protocolVersion: string) {
  return {
    protocolVersion,
    capabilities: {},
    clientInfo: { name: 'initialize-version-test', version: '0.0.0' }
  };
}

describe('premises the table rests on (SDK 1.30.0 constants)', () => {
  test(`LATEST_PROTOCOL_VERSION is ${FALLBACK}`, () => {
    expect(LATEST_PROTOCOL_VERSION).toBe(FALLBACK);
  });

  test('every "unsupported" row is outside SUPPORTED_PROTOCOL_VERSIONS, every "supported" row inside', () => {
    for (const row of UNSUPPORTED) expect(SUPPORTED_PROTOCOL_VERSIONS).not.toContain(row.requested);
    for (const row of SUPPORTED) expect(SUPPORTED_PROTOCOL_VERSIONS).toContain(row.requested);
  });
});

// ---------------------------------------------------------------------------
// 1. The real handler, over an in-memory transport
// ---------------------------------------------------------------------------

type RpcResponse = {
  jsonrpc: '2.0';
  id: number;
  result?: Record<string, unknown>;
  error?: { code: number; message: string; data?: unknown };
};

/** Sends one raw `initialize` to `server` and returns the JSON-RPC response envelope. */
async function initializeOver(server: Server, protocolVersion: string): Promise<RpcResponse> {
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  await server.connect(serverSide);
  try {
    const response = new Promise<RpcResponse>((resolve) => {
      clientSide.onmessage = (message) => {
        const envelope = message as RpcResponse;
        if (envelope.id === 1) resolve(envelope);
      };
    });
    await clientSide.start();
    await clientSide.send({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: initializeParams(protocolVersion)
    } as JSONRPCMessage);
    return await response;
  } finally {
    await clientSide.close();
    await server.close();
  }
}

describe('initialize: the real createServer() handler', () => {
  test.each(ROWS)('requested $requested is answered $answered', async (row) => {
    const response = await initializeOver(await createServer(), row.requested);
    expect(response.error, label(row)).toBeUndefined();
    // Proves this is this server's handler, not a stock one.
    expect((response.result?.serverInfo as { name?: string } | undefined)?.name).toBe('socrata-mcp-server');
    expect(response.result?.protocolVersion, label(row)).toBe(row.answered);
  });

  test.each(ROWS)('requested $requested: agrees with the stock SDK handler', async (row) => {
    const stock = new Server({ name: 'stock-sdk-oracle', version: '0.0.0' }, { capabilities: { tools: {} } });
    const oracle = await initializeOver(stock, row.requested);
    const ours = await initializeOver(await createServer(), row.requested);
    expect(oracle.result?.protocolVersion, `stock SDK, ${label(row)}`).toBe(row.answered);
    expect(ours.result?.protocolVersion, label(row)).toBe(oracle.result?.protocolVersion);
  });
});

// ---------------------------------------------------------------------------
// 2. The next request, through OpenAICompatibleTransport, socketless
// ---------------------------------------------------------------------------

/** Response captured by the socketless dispatcher. */
interface InjectedResponse {
  status: number;
  headers: Record<string, string | number | string[] | undefined>;
  body: string;
}

/**
 * Dispatch a request through an Express app without binding a socket: a real
 * IncomingMessage/ServerResponse pair on an unconnected net.Socket, with writes captured.
 * Copied from `protocol-ceiling.test.ts`, which keeps its own unexported copy and is pinned.
 */
function injectRequest(
  app: express.Application,
  opts: { method: string; url: string; headers: Record<string, string>; body?: string }
): Promise<InjectedResponse> {
  return new Promise((resolve, reject) => {
    const socket = new Socket();
    const req = new http.IncomingMessage(socket);
    req.method = opts.method;
    req.url = opts.url;
    // Both header views: the SDK's Node transport reads req.rawHeaders (via @hono/node-server),
    // express.text() needs a Content-Length, and hono needs Host to build the URL.
    const headers: Record<string, string> = {
      host: 'localhost',
      ...(opts.body !== undefined ? { 'content-length': String(Buffer.byteLength(opts.body)) } : {}),
      ...Object.fromEntries(Object.entries(opts.headers).map(([k, v]) => [k.toLowerCase(), v]))
    };
    for (const [name, value] of Object.entries(headers)) {
      req.headers[name] = value;
      req.rawHeaders.push(name, value);
    }

    const res = new http.ServerResponse(req);
    const chunks: Buffer[] = [];
    let settled = false;

    const finish = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ status: res.statusCode, headers: res.getHeaders(), body: Buffer.concat(chunks).toString('utf8') });
    };

    const timer = setTimeout(() => {
      if (!settled) {
        settled = true;
        reject(
          new Error(
            `injectRequest timed out; status so far ${res.statusCode}, body so far: ${Buffer.concat(chunks).toString('utf8')}`
          )
        );
      }
    }, 5000);

    const captureChunk = (chunk: unknown) => {
      if (chunk instanceof Uint8Array) chunks.push(Buffer.from(chunk));
      else if (typeof chunk === 'string') chunks.push(Buffer.from(chunk));
    };

    res.write = ((chunk: unknown, encoding?: unknown, cb?: unknown) => {
      captureChunk(chunk);
      const callback = typeof encoding === 'function' ? encoding : cb;
      if (typeof callback === 'function') (callback as () => void)();
      return true;
    }) as typeof res.write;

    res.end = ((chunk?: unknown, encoding?: unknown, cb?: unknown) => {
      captureChunk(chunk);
      const callback = typeof chunk === 'function' ? chunk : typeof encoding === 'function' ? encoding : cb;
      if (typeof callback === 'function') (callback as () => void)();
      setImmediate(finish);
      return res;
    }) as typeof res.end;

    (app as unknown as (rq: http.IncomingMessage, rs: http.ServerResponse) => void)(req, res);
    if (opts.body !== undefined) req.push(opts.body);
    req.push(null);
  });
}

/** The JSON-RPC payload of a direct-JSON or SSE-framed response body. */
function parseRpcBody(body: string): RpcResponse {
  const dataLines = body
    .split('\n')
    .filter((line) => line.startsWith('data:'))
    .map((line) => line.slice(5).trim());
  const payload = dataLines.length > 0 ? dataLines[dataLines.length - 1] : body;
  return JSON.parse(payload) as RpcResponse;
}

const openTransports: OpenAICompatibleTransport[] = [];

afterEach(async () => {
  while (openTransports.length > 0) await openTransports.pop()?.close();
});

/**
 * This server's `/mcp` chain as `startApp()` wires it: Accept shim, text body parser,
 * `OpenAICompatibleTransport`, the real `createServer(transport)`, and the raw text body handed
 * to `handleRequest` as `parsedBody` (what `createTransportAndServer()` does).
 */
async function buildMcpApp(): Promise<express.Application> {
  const app = express();
  app.use('/mcp', (req, _res, next) => {
    const h = req.headers.accept ?? '';
    if (!h.includes('text/event-stream')) {
      req.headers.accept = h ? `${h}, text/event-stream` : 'text/event-stream';
    }
    next();
  });
  app.use('/mcp', express.text({ type: '*/*' }));

  const transport = new OpenAICompatibleTransport({
    sessionIdGenerator: () => crypto.randomBytes(16).toString('hex')
  });
  openTransports.push(transport);
  const server = await createServer(transport);
  await server.connect(transport);

  app.all('/mcp', async (req, res) => {
    await transport.handleRequest(req, res, req.body);
  });
  return app;
}

const JSON_AND_SSE = { 'content-type': 'application/json', accept: 'application/json, text/event-stream' };

async function postInitialize(app: express.Application, protocolVersion: string) {
  const response = await injectRequest(app, {
    method: 'POST',
    url: '/mcp',
    headers: { ...JSON_AND_SSE },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: initializeParams(protocolVersion) })
  });
  const rpc = parseRpcBody(response.body);
  return { response, rpc, sessionId: response.headers['mcp-session-id'] };
}

async function postToolsList(app: express.Application, sessionId: string, protocolVersionHeader?: string) {
  return injectRequest(app, {
    method: 'POST',
    url: '/mcp',
    headers: {
      ...JSON_AND_SSE,
      'mcp-session-id': sessionId,
      ...(protocolVersionHeader !== undefined ? { 'mcp-protocol-version': protocolVersionHeader } : {})
    },
    body: JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} })
  });
}

function toolNames(rpc: RpcResponse): string[] {
  const tools = rpc.result?.tools;
  return Array.isArray(tools) ? tools.map((tool) => (tool as { name?: string }).name ?? '') : [];
}

describe('the next request: OpenAICompatibleTransport over the SDK Streamable HTTP transport, socketless', () => {
  test.each(ROWS)(
    'initialize at $requested, then tools/list at the answered version, is 200',
    async (row) => {
      const app = await buildMcpApp();
      const init = await postInitialize(app, row.requested);
      expect(init.response.status, init.response.body).toBe(200);
      expect(init.rpc.error, init.response.body).toBeUndefined();
      const answered = String(init.rpc.result?.protocolVersion);
      const sessionId = init.sessionId;
      expect(typeof sessionId).toBe('string');

      // The body `sessionId` the custom handler exists to add is still there, and is the
      // session the transport allocated.
      expect(init.rpc.result?.sessionId).toBe(sessionId);

      // The step #70 fails at: the SDK transport's version gate on the NEXT request.
      const list = await postToolsList(app, String(sessionId), answered);
      expect(list.status, `${label(row)}: answered ${answered}; tools/list body: ${list.body}`).toBe(200);
      const listRpc = parseRpcBody(list.body);
      expect(listRpc.error, list.body).toBeUndefined();
      expect(toolNames(listRpc)).toContain('get_data');

      expect(answered, label(row)).toBe(row.answered);
    }
  );

  test("the website's handshake: initialize at 2024-11-05, no MCP-Protocol-Version on any request", async () => {
    const app = await buildMcpApp();
    const init = await postInitialize(app, '2024-11-05');
    expect(init.response.status, init.response.body).toBe(200);
    expect(init.rpc.result?.protocolVersion).toBe('2024-11-05');
    expect(typeof init.sessionId).toBe('string');

    const list = await postToolsList(app, String(init.sessionId));
    expect(list.status, list.body).toBe(200);
    expect(toolNames(parseRpcBody(list.body))).toContain('get_data');
  });
});
