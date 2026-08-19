#!/usr/bin/env node
/**
 * Deployed-endpoint smoke: does the LIVE hosted /mcp still speak MCP at the
 * current protocol revision? (socrata-mcp-server#44, suggested fix 2.)
 *
 * WHY THIS EXISTS — the breakage class this catches is Render-side drift, which
 * is invisible to the unit suite by construction and uncorrelated with commits
 * to this repo:
 *   - #44: the deployed SDK's SUPPORTED_PROTOCOL_VERSIONS ceiling fell behind
 *     what current clients negotiate, so hosted /mcp answered current-client
 *     POSTs with 400 "Unsupported protocol version". No commit here caused it;
 *     clients moved.
 *   - #47: Render's NODE_VERSION sat on the 18 line, so every POST /mcp
 *     returned `-32700 Parse error: ReferenceError: crypto is not defined`.
 *     A dashboard env var outranks the committed .node-version, so no in-repo
 *     file could have protected it.
 * Both went unnoticed until a human tried a query. This script is the machine
 * that tries the query.
 *
 * RELATIONSHIP TO THE IN-REPO TESTS — deliberately separate, not a duplicate:
 *   - `src/__tests__/protocol-ceiling.test.ts` drives the SAME handshake shape
 *     (initialize at 2025-11-25, then a tools/list carrying the
 *     MCP-Protocol-Version header) through the production middleware chain
 *     IN PROCESS, socketless. It guards the CODE on this branch.
 *   - This script drives that handshake OVER THE WIRE against a DEPLOYED
 *     instance. It guards the RUNNING SERVICE — SDK version actually shipped,
 *     Node version actually running, proxy/CDN in front of it, env actually set.
 *   - `npm run test:integration` (RUN_INTEGRATION=1) is a third thing again: a
 *     local vitest run against the live Socrata API, testing upstream data
 *     access, not this server's transport. None of the three subsumes another.
 *
 * NO CREDENTIALS. This server requires no authentication by design: src/index.ts
 * has no auth middleware, never returns 401, and answers the OAuth discovery
 * ladder with a 404 + "connect without credentials" body (the #47 honest
 * no-auth signal). So this script reads no secret and CI needs no secrets store.
 *
 * ZERO DEPENDENCIES. Plain outbound HTTPS via global fetch on the repo's Node
 * floor (>=22, see .node-version / package.json engines). No `npm ci`, no
 * build, no port binding — so it runs in a restricted sandbox, and a broken
 * build or a registry outage can never make this monitor go red for a reason
 * that has nothing to do with the endpoint.
 *
 * Usage:
 *   node scripts/smoke-deployed-endpoint.mjs
 *   SMOKE_MCP_URL=https://example.invalid/mcp node scripts/smoke-deployed-endpoint.mjs
 *
 * Exit codes: 0 = the deployed endpoint speaks MCP at PROTOCOL_VERSION. 1 = it
 * does not, or could not be reached. Everything needed to diagnose a failure is
 * printed to stdout — what was sent, what came back — so a 3am scheduled
 * failure is readable from the log alone with no local reproduction.
 */

/** The reference deployment. Override with SMOKE_MCP_URL to probe a fork. */
const DEFAULT_ENDPOINT = 'https://socrata-mcp.civicaitools.org/mcp';

/**
 * The revision the smoke negotiates. This is LATEST_PROTOCOL_VERSION in
 * @modelcontextprotocol/sdk 1.30.0 (node_modules/@modelcontextprotocol/sdk/
 * dist/esm/types.js) — i.e. what a current client asks for.
 *
 * WHERE THE SKEW ACTUALLY SHOWS UP ON THIS SERVER — measured, not assumed:
 * initialize is NOT the probe. src/index.ts registers its own
 * InitializeRequestSchema handler that overrides the SDK's, and it BLIND-ECHOES
 * the requested revision:
 *     const protocolVersion = request.params.protocolVersion || '2025-01-01';
 *     ... response.protocolVersion = protocolVersion
 * There is no negotiation step to observe. Verified against the live deployment
 * 2026-08-19: an initialize asking for the nonsense revision `2099-01-01` came
 * back HTTP 200 with `"protocolVersion":"2099-01-01"` — a revision that exists
 * at no MCP spec version and that the server itself rejects one request later.
 *
 * So an initialize-only smoke would have been GREEN for the entire #44 outage.
 * The gate lives in the SDK's HTTP transport and fires on the NEXT request; the
 * tools/list step below is what actually catches skew. The echo assertion on
 * initialize is kept as a cheap consistency check, not as the anti-skew check.
 *
 * When the SDK's ceiling moves, bump this and the matching constant in
 * src/__tests__/protocol-ceiling.test.ts together.
 */
const PROTOCOL_VERSION = '2025-11-25';

const REQUEST_TIMEOUT_MS = 30_000;
/** Whole-handshake attempts. Retries cover TRANSPORT flakes only — see attempt(). */
const MAX_ATTEMPTS = 3;
const RETRY_BACKOFF_MS = 5_000;
/** Cap on echoed response bodies, so one HTML error page can't bury the log. */
const MAX_BODY_CHARS = 2_000;

const USER_AGENT = 'socrata-mcp-deployed-smoke/1 (+https://github.com/npstorey/socrata-mcp-server)';

const endpoint = (process.env.SMOKE_MCP_URL ?? '').trim() || DEFAULT_ENDPOINT;

/**
 * A failure with the evidence attached. `retryable` marks transport-level
 * failures (connection refused, DNS, timeout, 5xx, 429) — conditions that are
 * genuinely intermittent. Protocol assertion failures are NEVER retryable:
 * they are deterministic, and retrying one would only delay a true red.
 */
class SmokeFailure extends Error {
  constructor(message, { retryable = false, detail = [] } = {}) {
    super(message);
    this.name = 'SmokeFailure';
    this.retryable = retryable;
    this.detail = detail;
  }
}

function log(line = '') {
  console.log(line === '' ? '' : `[smoke] ${line}`);
}

function truncate(text) {
  if (typeof text !== 'string') return String(text);
  if (text.length <= MAX_BODY_CHARS) return text;
  return `${text.slice(0, MAX_BODY_CHARS)}\n… [truncated; ${text.length} chars total]`;
}

/** Header lines worth printing on failure. */
function describeHeaders(headers) {
  const interesting = [
    'content-type',
    'mcp-session-id',
    'mcp-protocol-version',
    'www-authenticate',
    'retry-after',
    'server',
    'x-render-routing',
    'rndr-id',
    'cf-ray',
  ];
  return interesting
    .map((name) => [name, headers.get(name)])
    .filter(([, value]) => value !== null && value !== undefined)
    .map(([name, value]) => `      ${name}: ${value}`);
}

/**
 * One HTTP round trip. Returns the raw response plus timing; converts network
 * errors into a retryable SmokeFailure carrying the request that provoked them.
 */
async function send({ method, headers, body, label }) {
  const started = Date.now();
  const sentDetail = [
    '  sent:',
    `    ${method} ${endpoint}`,
    ...Object.entries(headers).map(([k, v]) => `      ${k}: ${v}`),
    ...(body === undefined ? [] : ['    body:', `      ${body}`]),
  ];

  let response;
  try {
    response = await fetch(endpoint, {
      method,
      headers,
      body,
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      redirect: 'manual',
    });
  } catch (error) {
    throw new SmokeFailure(
      `${label}: could not reach the endpoint (${error?.name ?? 'Error'}: ${error?.message ?? error})`,
      {
        retryable: true,
        detail: [
          ...sentDetail,
          '  received:',
          `    nothing — the request failed after ${Date.now() - started}ms`,
          `    ${error?.name ?? 'Error'}: ${error?.message ?? String(error)}`,
          ...(error?.cause ? [`    cause: ${error.cause}`] : []),
        ],
      }
    );
  }

  const rawBody = await response.text();
  const ms = Date.now() - started;
  const receivedDetail = [
    '  received:',
    `    HTTP ${response.status} ${response.statusText} (${ms}ms)`,
    '    headers:',
    ...describeHeaders(response.headers),
    `    body (${rawBody.length} chars):`,
    ...truncate(rawBody)
      .split('\n')
      .map((line) => `      ${line}`),
  ];

  return { response, rawBody, ms, sentDetail, receivedDetail };
}

/**
 * Unwrap a JSON-RPC payload from either a direct JSON body or an SSE-framed
 * one. The deployed transport answers POST /mcp with `content-type:
 * text/event-stream` (verified live 2026-08-19), so SSE is the normal path;
 * plain JSON is accepted too since the SDK may negotiate either.
 * Mirrors parseRpcBody() in src/__tests__/protocol-ceiling.test.ts.
 */
function parseRpcBody(rawBody, { label, sentDetail, receivedDetail }) {
  const dataLines = rawBody
    .split('\n')
    .filter((line) => line.startsWith('data:'))
    .map((line) => line.slice(5).trim());
  const payload = dataLines.length > 0 ? dataLines[dataLines.length - 1] : rawBody;
  try {
    return JSON.parse(payload);
  } catch (error) {
    throw new SmokeFailure(`${label}: response body is not valid JSON-RPC (${error.message})`, {
      detail: [...sentDetail, ...receivedDetail],
    });
  }
}

/** Assert, attaching the full exchange so the log explains itself. */
function check(condition, message, exchange) {
  if (!condition) {
    throw new SmokeFailure(message, {
      detail: [...exchange.sentDetail, ...exchange.receivedDetail],
    });
  }
}

/** A non-2xx that is worth retrying (server/edge wobble) rather than failing on. */
function isRetryableStatus(status) {
  return status === 429 || status >= 500;
}

/**
 * One full handshake attempt: initialize → tools/list → DELETE.
 * Returns a short summary line on success; throws SmokeFailure otherwise.
 */
async function attempt() {
  // ---- Step 1: initialize --------------------------------------------------
  log(`→ POST initialize (protocolVersion=${PROTOCOL_VERSION})`);
  const initBody = JSON.stringify({
    jsonrpc: '2.0',
    id: 1,
    method: 'initialize',
    params: {
      protocolVersion: PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: { name: 'deployed-endpoint-smoke', version: '1.0.0' },
    },
  });
  const init = await send({
    method: 'POST',
    label: 'initialize',
    headers: {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      'mcp-protocol-version': PROTOCOL_VERSION,
      'user-agent': USER_AGENT,
    },
    body: initBody,
  });

  if (init.response.status !== 200 && isRetryableStatus(init.response.status)) {
    throw new SmokeFailure(
      `initialize: HTTP ${init.response.status} ${init.response.statusText} (transport-level; retryable)`,
      { retryable: true, detail: [...init.sentDetail, ...init.receivedDetail] }
    );
  }
  check(
    init.response.status === 200,
    `initialize: expected HTTP 200, got ${init.response.status} ${init.response.statusText}`,
    init
  );
  log(
    `← 200 in ${init.ms}ms; content-type=${init.response.headers.get('content-type') ?? '(none)'}`
  );

  const initRpc = parseRpcBody(init.rawBody, { label: 'initialize', ...init });
  check(
    initRpc.jsonrpc === '2.0',
    `initialize: expected jsonrpc "2.0", got ${JSON.stringify(initRpc.jsonrpc)}`,
    init
  );
  check(
    initRpc.id === 1,
    `initialize: response id ${JSON.stringify(initRpc.id)} does not match request id 1`,
    init
  );
  check(
    initRpc.error === undefined,
    `initialize: server returned a JSON-RPC error: ${JSON.stringify(initRpc.error)}`,
    init
  );
  check(
    initRpc.result !== null && typeof initRpc.result === 'object',
    'initialize: response carries no result object',
    init
  );

  // Consistency check, NOT the anti-skew check — see the PROTOCOL_VERSION note:
  // this server's own initialize handler echoes back whatever revision it was
  // sent, so agreement here proves only that the echo path is intact. A
  // disagreement would mean the handler changed shape, which is worth a red.
  check(
    initRpc.result.protocolVersion === PROTOCOL_VERSION,
    `initialize: sent protocolVersion ${PROTOCOL_VERSION}, ` +
      `got ${JSON.stringify(initRpc.result.protocolVersion)} back. ` +
      'src/index.ts echoes the requested revision verbatim, so a mismatch here ' +
      'means the initialize handler itself changed — inspect it before anything else.',
    init
  );

  const sessionId = init.response.headers.get('mcp-session-id');
  check(
    typeof sessionId === 'string' && sessionId.length > 0,
    'initialize: no mcp-session-id response header — the server allocated no session',
    init
  );

  const serverInfo = initRpc.result.serverInfo ?? {};
  check(
    typeof serverInfo.name === 'string' && serverInfo.name.length > 0,
    'initialize: result.serverInfo.name is missing or empty',
    init
  );

  log(
    `  protocolVersion in result = ${initRpc.result.protocolVersion} ` +
      '(echoed back verbatim — proves nothing about skew; tools/list below is the real probe)'
  );
  log(`  serverInfo = ${serverInfo.name} ${serverInfo.version ?? '(no version)'}`);
  log(`  mcp-session-id = ${sessionId}`);

  // ---- Step 2: tools/list — THE outage-class probe -------------------------
  // This is the step that catches protocol skew. It is not optional garnish.
  //
  // #44 did NOT surface on initialize. The SDK's protocol-version gate lives in
  // the HTTP transport and fires on a NON-initialize POST carrying the
  // MCP-Protocol-Version header — at SDK 1.15.1 that request returned the
  // observed 400 "Unsupported protocol version".
  // src/__tests__/protocol-ceiling.test.ts records the same finding in process.
  //
  // Confirmed end-to-end against the live deployment 2026-08-19 by asking for a
  // revision the server cannot serve: initialize returned 200 and happily
  // echoed it (see the PROTOCOL_VERSION note), and THIS request returned
  //   400 {"code":-32000,"message":"Bad Request: Unsupported protocol version:
  //        2099-01-01 (supported versions: 2025-11-25, 2025-06-18, 2025-03-26,
  //        2024-11-05, 2024-10-07)"}
  // — the exact #44 wire shape, and incidentally a live readout of the deployed
  // SDK's ceiling. Drop this step and the smoke stops testing what it is for.
  //
  // It also proves the allocated session actually works, not merely that one
  // was handed out.
  log(`→ POST tools/list (MCP-Protocol-Version: ${PROTOCOL_VERSION}, session ${sessionId})`);
  const list = await send({
    method: 'POST',
    label: 'tools/list',
    headers: {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      'mcp-protocol-version': PROTOCOL_VERSION,
      'mcp-session-id': sessionId,
      'user-agent': USER_AGENT,
    },
    body: JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} }),
  });

  if (list.response.status !== 200 && isRetryableStatus(list.response.status)) {
    throw new SmokeFailure(
      `tools/list: HTTP ${list.response.status} ${list.response.statusText} (transport-level; retryable)`,
      { retryable: true, detail: [...list.sentDetail, ...list.receivedDetail] }
    );
  }
  check(
    list.response.status === 200,
    `tools/list: expected HTTP 200, got ${list.response.status} ${list.response.statusText}. ` +
      'A 400 "Unsupported protocol version" here is the socrata-mcp-server#44 outage class.',
    list
  );

  const listRpc = parseRpcBody(list.rawBody, { label: 'tools/list', ...list });
  check(
    listRpc.error === undefined,
    `tools/list: server returned a JSON-RPC error: ${JSON.stringify(listRpc.error)}`,
    list
  );
  const tools = listRpc.result?.tools;
  check(
    Array.isArray(tools) && tools.length > 0,
    `tools/list: expected a non-empty tools array, got ${JSON.stringify(listRpc.result)?.slice(0, 300)}`,
    list
  );
  log(`← 200 in ${list.ms}ms; ${tools.length} tool(s): ${tools.map((t) => t.name).join(', ')}`);

  // ---- Step 3: close the session -------------------------------------------
  // The server DOES allocate per-session state: src/index.ts keeps a module-level
  // `transports` Map keyed by session id, and the SDK transport's
  // `onsessionclosed` callback deletes the entry and runs cleanup(). Verified
  // live 2026-08-19: DELETE with a valid mcp-session-id returns 200, and a
  // second DELETE for the same id returns 400 "No valid session ID provided" —
  // i.e. the close really landed. Without this, every run would leak one
  // transport+Server pair into that Map until the next Render deploy.
  //
  // Deliberately a WARNING, not a failure: a cleanup that did not land is a
  // slow resource leak, not an outage, and the endpoint is still serving. This
  // monitor's red must mean "the endpoint is broken".
  log(`→ DELETE session ${sessionId}`);
  try {
    const close = await send({
      method: 'DELETE',
      label: 'session close',
      headers: {
        accept: 'application/json, text/event-stream',
        'mcp-protocol-version': PROTOCOL_VERSION,
        'mcp-session-id': sessionId,
        'user-agent': USER_AGENT,
      },
    });
    if (close.response.status === 200) {
      log(`← 200 in ${close.ms}ms (session closed)`);
    } else {
      log(
        `← WARNING: session close returned HTTP ${close.response.status} ${close.response.statusText}; the session may leak until the next deploy`
      );
      for (const line of close.receivedDetail) log(line);
    }
  } catch (error) {
    log(
      `← WARNING: session close failed (${error.message}); the session may leak until the next deploy`
    );
  }

  return `${serverInfo.name} ${serverInfo.version ?? ''} speaks MCP ${PROTOCOL_VERSION}`.trim();
}

async function main() {
  log(`target   : ${endpoint}${endpoint === DEFAULT_ENDPOINT ? ' (default)' : ' (SMOKE_MCP_URL)'}`);
  log(`protocol : ${PROTOCOL_VERSION}`);
  log(`node     : ${process.version}`);
  log(`started  : ${new Date().toISOString()}`);
  log();

  let lastFailure;
  for (let n = 1; n <= MAX_ATTEMPTS; n++) {
    log(`attempt ${n}/${MAX_ATTEMPTS}`);
    try {
      const summary = await attempt();
      log();
      log(`PASS — ${summary}`);
      return 0;
    } catch (error) {
      if (!(error instanceof SmokeFailure)) throw error;
      lastFailure = error;
      if (error.retryable && n < MAX_ATTEMPTS) {
        log(`attempt ${n} failed (retryable): ${error.message}`);
        log(`retrying in ${RETRY_BACKOFF_MS / 1000}s…`);
        await new Promise((resolve) => setTimeout(resolve, RETRY_BACKOFF_MS));
        log();
        continue;
      }
      break;
    }
  }

  log();
  log(`FAIL — ${lastFailure.message}`);
  log();
  for (const line of lastFailure.detail) log(line);
  log();
  log(`endpoint  : ${endpoint}`);
  log(
    `protocol  : ${PROTOCOL_VERSION} (LATEST_PROTOCOL_VERSION in @modelcontextprotocol/sdk 1.30.0)`
  );
  log('background: socrata-mcp-server#44 (protocol skew) and #47 (Node floor) are');
  log('            the two Render-side drifts this smoke exists to catch. Check the');
  log("            deployed service's SDK version and NODE_VERSION in the Render");
  log('            dashboard before assuming a code problem — the code on main is');
  log('            guarded separately by src/__tests__/protocol-ceiling.test.ts.');
  return 1;
}

main()
  .then((code) => {
    process.exitCode = code;
  })
  .catch((error) => {
    log();
    log(`FAIL — unexpected error in the smoke itself: ${error?.stack ?? error}`);
    process.exitCode = 1;
  });
