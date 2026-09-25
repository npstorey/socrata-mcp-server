#!/usr/bin/env node
/**
 * One portal call through a running instance of this server, over MCP: an
 * `initialize`, then `tools/call get_data` with `type: "catalog"` against the
 * portal named on the command line. Exit 0 when the call returns datasets,
 * 1 otherwise, with the exchange printed so a failure is readable from the log.
 *
 * What this measures is that the SERVER reached the PORTAL from wherever it is
 * running. The container-image job in .github/workflows/ci.yml runs it from a
 * network whose only way out is a CONNECT-only proxy, so a green there means
 * the server's portal calls went through that proxy's tunnel. It is not a
 * transport probe (scripts/smoke-deployed-endpoint.mjs is that) and not a
 * unit test.
 *
 * Zero dependencies; global fetch on the repo's Node floor (>=22).
 *
 * Usage:
 *   node scripts/mcp-portal-call.mjs <mcp-url> <portal-host>
 *   node scripts/mcp-portal-call.mjs http://127.0.0.1:8000/mcp <portal-host>
 */

const [endpoint, portalHost] = process.argv.slice(2);
if (!endpoint || !portalHost) {
  console.error('usage: node scripts/mcp-portal-call.mjs <mcp-url> <portal-host>');
  process.exit(2);
}

/** LATEST_PROTOCOL_VERSION in @modelcontextprotocol/sdk 1.30.0. */
const PROTOCOL_VERSION = '2025-11-25';
const REQUEST_TIMEOUT_MS = 90_000;

const log = (line) => console.log(`[portal-call] ${line}`);

/** A JSON-RPC payload from a direct JSON body or an SSE-framed one. */
function parseRpcBody(rawBody) {
  const dataLines = rawBody
    .split('\n')
    .filter((line) => line.startsWith('data:'))
    .map((line) => line.slice(5).trim());
  return JSON.parse(dataLines.length > 0 ? dataLines[dataLines.length - 1] : rawBody);
}

async function post(body, sessionId) {
  const headers = {
    'content-type': 'application/json',
    accept: 'application/json, text/event-stream',
    'mcp-protocol-version': PROTOCOL_VERSION,
    ...(sessionId ? { 'mcp-session-id': sessionId } : {}),
  };
  const response = await fetch(endpoint, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  const rawBody = await response.text();
  log(`${body.method}: HTTP ${response.status} (${rawBody.length} chars)`);
  if (response.status !== 200) {
    throw new Error(`${body.method}: expected HTTP 200, got ${response.status}: ${rawBody.slice(0, 500)}`);
  }
  const rpc = parseRpcBody(rawBody);
  if (rpc.error) {
    throw new Error(`${body.method}: JSON-RPC error ${JSON.stringify(rpc.error).slice(0, 1000)}`);
  }
  return { rpc, sessionId: response.headers.get('mcp-session-id') ?? sessionId };
}

try {
  log(`endpoint ${endpoint}; portal ${portalHost}`);
  const init = await post({
    jsonrpc: '2.0',
    id: 1,
    method: 'initialize',
    params: {
      protocolVersion: PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: { name: 'mcp-portal-call', version: '1.0.0' },
    },
  });
  if (!init.sessionId) throw new Error('initialize: no mcp-session-id header');

  const call = await post(
    {
      jsonrpc: '2.0',
      id: 2,
      method: 'tools/call',
      params: {
        name: 'get_data',
        arguments: { type: 'catalog', domain: portalHost, query: 'data', limit: 1 },
      },
    },
    init.sessionId,
  );
  const result = call.rpc.result;
  const text = result?.content?.find((item) => item.type === 'text')?.text ?? '';
  if (result?.isError) throw new Error(`tools/call: isError with content ${text.slice(0, 500)}`);
  const datasets = JSON.parse(text);
  if (!Array.isArray(datasets) || datasets.length === 0) {
    throw new Error(`tools/call: expected a non-empty dataset list, got ${text.slice(0, 500)}`);
  }
  log(`OK: ${portalHost} answered with ${datasets.length} dataset(s); first: ${JSON.stringify(datasets[0].name)}`);

  await fetch(endpoint, {
    method: 'DELETE',
    headers: { 'mcp-session-id': init.sessionId, 'mcp-protocol-version': PROTOCOL_VERSION },
    signal: AbortSignal.timeout(10_000),
  }).catch(() => undefined);
  process.exit(0);
} catch (error) {
  log(`FAILED: ${error?.message ?? error}`);
  if (error?.cause) log(`cause: ${error.cause}`);
  process.exit(1);
}
