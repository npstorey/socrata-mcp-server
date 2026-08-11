/**
 * Protocol-ceiling regression guard (#47).
 *
 * The 2026-07/08 outage class: the deployed SDK's SUPPORTED_PROTOCOL_VERSIONS
 * ceiling fell behind what current clients negotiate, so the hosted /mcp
 * endpoint answered every current-client POST with
 *   400 "Unsupported protocol version (supported versions: ...)"
 * while unit tests stayed green (the version gate lives inside the SDK's HTTP
 * transport, which most tests never execute).
 *
 * Two guards here:
 *  1. The SDK's supported-version list includes 2025-11-25 (v1's terminal
 *     ceiling - what current clients fall back to) plus the eras of known
 *     legacy consumers.
 *  2. A wire-level test that drives real HTTP requests through the production
 *     middleware chain (Accept shim -> express.text -> OpenAICompatibleTransport
 *     -> SDK transport) WITHOUT binding a socket, so it runs in sandboxes where
 *     `listen` is blocked (the EPERM artifact that keeps openai-initialize.test.ts
 *     red in restricted environments). A client declaring
 *     MCP-Protocol-Version: 2025-11-25 must complete initialize and a follow-up
 *     tools/list. At SDK 1.15.1 the tools/list request fails with the exact
 *     outage-class 400; at 1.30.0 it must succeed.
 */
import { describe, test, expect } from 'vitest';
import http from 'http';
import { Socket } from 'net';
import express from 'express';
import crypto from 'crypto';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import {
  SUPPORTED_PROTOCOL_VERSIONS,
  ListToolsRequestSchema
} from '@modelcontextprotocol/sdk/types.js';
import { OpenAICompatibleTransport } from '../openai-compatible-transport.js';

describe('SDK protocol ceiling constant', () => {
  test('includes 2025-11-25 (current-client fallback era; the #47 bump)', () => {
    expect(SUPPORTED_PROTOCOL_VERSIONS).toContain('2025-11-25');
  });

  test('still includes the eras of known legacy consumers', () => {
    // The website's hand-rolled client pins 2024-11-05; pre-outage SDK-based
    // clients negotiated up to 2025-06-18.
    expect(SUPPORTED_PROTOCOL_VERSIONS).toContain('2024-11-05');
    expect(SUPPORTED_PROTOCOL_VERSIONS).toContain('2025-06-18');
  });
});

/** Response captured by the socketless dispatcher. */
interface InjectedResponse {
  status: number;
  headers: Record<string, string | number | string[] | undefined>;
  body: string;
}

/**
 * Dispatch a request through an Express app without binding a socket.
 * Builds a real IncomingMessage/ServerResponse pair on an unconnected
 * net.Socket and captures writes, so no `listen` permission is needed.
 */
function injectRequest(
  app: express.Application,
  opts: {
    method: string;
    url: string;
    headers: Record<string, string>;
    body?: string;
  }
): Promise<InjectedResponse> {
  return new Promise((resolve, reject) => {
    const socket = new Socket();
    const req = new http.IncomingMessage(socket);
    req.method = opts.method;
    req.url = opts.url;
    // Populate BOTH header views a real request carries. The SDK's 1.30.0
    // Node transport converts to a web Request via @hono/node-server, which
    // reads req.rawHeaders (not req.headers); express.text() skips bodies
    // without a Content-Length (type-is hasBody()); and hono needs Host to
    // build the request URL. Real HTTP clients always send all of these.
    const headers: Record<string, string> = {
      host: 'localhost',
      ...(opts.body !== undefined
        ? { 'content-length': String(Buffer.byteLength(opts.body)) }
        : {}),
      ...Object.fromEntries(
        Object.entries(opts.headers).map(([k, v]) => [k.toLowerCase(), v])
      )
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
      resolve({
        status: res.statusCode,
        headers: res.getHeaders(),
        body: Buffer.concat(chunks).toString('utf8')
      });
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
      // hono's Node adapter writes Uint8Array chunks (Buffer is a subclass).
      if (chunk instanceof Uint8Array) {
        chunks.push(Buffer.from(chunk));
      } else if (typeof chunk === 'string') {
        chunks.push(Buffer.from(chunk));
      }
    };

    const originalWrite = res.write.bind(res);
    res.write = ((chunk: unknown, encoding?: unknown, cb?: unknown) => {
      captureChunk(chunk);
      const callback = typeof encoding === 'function' ? encoding : cb;
      if (typeof callback === 'function') (callback as () => void)();
      return true;
    }) as typeof res.write;
    void originalWrite; // header writes are captured via res.getHeaders()

    res.end = ((chunk?: unknown, encoding?: unknown, cb?: unknown) => {
      captureChunk(chunk);
      const callback =
        typeof chunk === 'function'
          ? chunk
          : typeof encoding === 'function'
            ? encoding
            : cb;
      if (typeof callback === 'function') (callback as () => void)();
      // Give any SSE post-end bookkeeping a tick before resolving.
      setImmediate(finish);
      return res;
    }) as typeof res.end;

    // Hand the pair to Express, then feed the body.
    (app as unknown as (rq: http.IncomingMessage, rs: http.ServerResponse) => void)(req, res);
    if (opts.body !== undefined) {
      req.push(opts.body);
    }
    req.push(null);
  });
}

/**
 * Minimal replica of the production /mcp middleware chain from src/index.ts:
 * Accept-header shim, text body parser, OpenAICompatibleTransport, Server.
 * (index.ts wires the chain inside startApp(), which binds a port at import
 * time, so the chain is rebuilt here the same way openai-initialize.test.ts
 * does.)
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

  const server = new Server(
    { name: 'protocol-ceiling-test', version: '0.0.0' },
    { capabilities: { tools: {} } }
  );
  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: [] }));
  await server.connect(transport);

  app.all('/mcp', async (req, res) => {
    await transport.handleRequest(req, res);
  });

  return app;
}

/** Extract the JSON payload from a direct-JSON or SSE-framed response body. */
function parseRpcBody(body: string): Record<string, unknown> {
  const dataLines = body
    .split('\n')
    .filter((line) => line.startsWith('data:'))
    .map((line) => line.slice(5).trim());
  const payload = dataLines.length > 0 ? dataLines[dataLines.length - 1] : body;
  return JSON.parse(payload) as Record<string, unknown>;
}

describe('wire-level: 2025-11-25 client against the production transport chain', () => {
  test('initialize and tools/list succeed with MCP-Protocol-Version: 2025-11-25', async () => {
    const app = await buildMcpApp();

    const initResponse = await injectRequest(app, {
      method: 'POST',
      url: '/mcp',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
        'mcp-protocol-version': '2025-11-25'
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: {
          protocolVersion: '2025-11-25',
          capabilities: {},
          clientInfo: { name: 'ceiling-probe', version: '0.0.0' }
        }
      })
    });

    expect(initResponse.status).toBe(200);
    const initRpc = parseRpcBody(initResponse.body);
    expect(initRpc.error).toBeUndefined();
    const initResult = initRpc.result as Record<string, unknown>;
    expect(initResult.protocolVersion).toBe('2025-11-25');

    const sessionId = initResponse.headers['mcp-session-id'];
    expect(typeof sessionId).toBe('string');

    // The follow-up request is the outage-class probe: a non-initialize POST
    // carrying MCP-Protocol-Version goes through the SDK's version gate.
    // At 1.15.1 this returned the E1-observed 400 "Unsupported protocol
    // version"; at >=1.30.0 it must succeed.
    const listResponse = await injectRequest(app, {
      method: 'POST',
      url: '/mcp',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
        'mcp-protocol-version': '2025-11-25',
        'mcp-session-id': String(sessionId)
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 2,
        method: 'tools/list',
        params: {}
      })
    });

    expect(listResponse.status).toBe(200);
    const listRpc = parseRpcBody(listResponse.body);
    expect(listRpc.error).toBeUndefined();
    expect((listRpc.result as Record<string, unknown>).tools).toEqual([]);
  });
});
