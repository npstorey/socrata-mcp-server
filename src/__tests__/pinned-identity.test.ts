/**
 * The identity this server reports is held to a committed file: `pinned-identity.json`.
 *
 * WHAT IS PINNED. The real `createServer()` over an in-memory transport, one raw `initialize`
 * and one `tools/list`. The `serverInfo.name` and `serverInfo.version` that `initialize` answers,
 * and each listed tool's `mcpToolSchemaSha256` (`./mcp-tool-schema-sha256.ts`), equal the file's
 * values, and the listed tool set equals the file's set. A change that moves any of them, or adds
 * or removes a tool, fails here until the file is edited.
 *
 * THE STAGE. A move lands in one stage, in this order (npstorey/civic-ai-tools#317): capture the
 * new values at the pull request's head, release a pack that lists both pins (the old and the
 * new), deploy the site, then merge. Every failure message below says so.
 *
 * CAPTURE. `PINNED_IDENTITY_CAPTURE=1 npx vitest run src/__tests__/pinned-identity.test.ts`
 * rewrites the file from the server at the working tree, then checks it. The file is never
 * written by hand.
 *
 * THE WIRE FORM. The hash is of the tool as a client receives it. `InMemoryTransport` (SDK
 * 1.32.2) hands the handler's result over by reference: measured 2026-11-12, the received
 * `inputSchema` is the very object `socrata-tools.ts` exports, with its description getters
 * intact. So each message is passed through `JSON.parse(JSON.stringify(...))` on arrival, as a
 * serializing transport would.
 *
 * NOT PINNED. Tool `title` and `description`, and every schema's `title` and `description`: the
 * hash rule removes them, and several are getters that read the environment
 * (`DATA_PORTAL_URL`, `MAX_RAW_ROWS`), so the pins hold under any configuration.
 * `server-version.test.ts` holds the reported version to package.json; this file holds it to a
 * value that only an edit here moves.
 */
import { describe, test, expect, beforeAll } from 'vitest';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { Implementation, JSONRPCMessage } from '@modelcontextprotocol/sdk/types.js';
import { createServer } from '../index.js';
import { canonicalJson, mcpToolSchemaCanonical, mcpToolSchemaSha256 } from './mcp-tool-schema-sha256.js';

const PIN_FILE = fileURLToPath(new URL('./pinned-identity.json', import.meta.url));
const CAPTURE = process.env.PINNED_IDENTITY_CAPTURE === '1';

const STAGE =
  'To move a pin: capture the new values at the pull request\'s head ' +
  '(PINNED_IDENTITY_CAPTURE=1 npx vitest run src/__tests__/pinned-identity.test.ts), ' +
  'release a pack that lists both pins, deploy the site, then merge.';

type Pinned = { serverName: string; serverVersion: string; tools: Record<string, string> };
type WireTool = { name: string; inputSchema: Parameters<typeof mcpToolSchemaSha256>[0]['inputSchema'] };
type RpcResponse = {
  id: number;
  result?: { serverInfo?: Implementation; tools?: WireTool[] };
  error?: unknown;
};

/** `initialize`, then `tools/list`, over the real server; both responses in their wire form. */
async function readIdentity(): Promise<{ serverInfo?: Implementation; tools: WireTool[] }> {
  const server = await createServer();
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  await server.connect(serverSide);
  const waiting = new Map<number, (response: RpcResponse) => void>();
  clientSide.onmessage = (message) => {
    const envelope = JSON.parse(JSON.stringify(message)) as RpcResponse;
    waiting.get(envelope.id)?.(envelope);
  };
  const request = (id: number, method: string, params: Record<string, unknown>) => {
    const response = new Promise<RpcResponse>((resolve) => waiting.set(id, resolve));
    return clientSide.send({ jsonrpc: '2.0', id, method, params } as JSONRPCMessage).then(() => response);
  };
  try {
    await clientSide.start();
    const init = await request(1, 'initialize', {
      protocolVersion: '2025-11-25',
      capabilities: {},
      clientInfo: { name: 'pinned-identity-test', version: '0.0.0' }
    });
    expect(init.error, 'initialize answered an error').toBeUndefined();
    const list = await request(2, 'tools/list', {});
    expect(list.error, 'tools/list answered an error').toBeUndefined();
    return { serverInfo: init.result?.serverInfo, tools: list.result?.tools ?? [] };
  } finally {
    await clientSide.close();
    await server.close();
  }
}

// A first capture runs before the file exists; any other run without it fails here, on the read.
const pinned: Pinned = CAPTURE && !existsSync(PIN_FILE)
  ? { serverName: '', serverVersion: '', tools: {} }
  : (JSON.parse(readFileSync(PIN_FILE, 'utf8')) as Pinned);

describe('the server identity is the pinned identity (pinned-identity.json)', () => {
  let reported: { serverInfo?: Implementation; tools: WireTool[] };
  let hashes: Record<string, string>;
  let file: Pinned = pinned;

  beforeAll(async () => {
    reported = await readIdentity();
    hashes = Object.fromEntries(reported.tools.map((tool) => [tool.name, mcpToolSchemaSha256(tool)]));
    if (CAPTURE) {
      file = {
        serverName: reported.serverInfo?.name ?? '',
        serverVersion: reported.serverInfo?.version ?? '',
        tools: hashes
      };
      writeFileSync(PIN_FILE, `${JSON.stringify(file, null, 2)}\n`);
    }
  });

  test('serverInfo.name is the pinned serverName', () => {
    const name = reported.serverInfo?.name;
    expect(name, `serverName moved: the server reports ${name}, the file pins ${file.serverName}. ${STAGE}`)
      .toBe(file.serverName);
  });

  test('serverInfo.version is the pinned serverVersion', () => {
    const version = reported.serverInfo?.version;
    expect(
      version,
      `serverVersion moved: the server reports ${version}, the file pins ${file.serverVersion}. ${STAGE}`
    ).toBe(file.serverVersion);
  });

  test('the listed tool set is the pinned tool set', () => {
    const listed = Object.keys(hashes).sort();
    const pins = Object.keys(file.tools).sort();
    const added = listed.filter((name) => !pins.includes(name));
    const removed = pins.filter((name) => !listed.includes(name));
    expect(
      listed,
      `the tool set moved: added [${added.join(', ')}], removed [${removed.join(', ')}]. ${STAGE}`
    ).toEqual(pins);
  });

  test.each(Object.keys(pinned.tools))('%s: its mcpToolSchemaSha256 is the pinned hash', (name) => {
    const hash = hashes[name];
    expect(
      hash,
      hash === undefined
        ? `tool ${name} moved: tools/list no longer lists it. ${STAGE}`
        : `tool ${name} moved: its mcpToolSchemaSha256 is ${hash}, the file pins ${file.tools[name]}. ${STAGE}`
    ).toBe(file.tools[name]);
  });
});

// The sprint contract's worked example (npstorey/civic-ai-tools#317). The hub router's copy of
// the rule reproduces the same numbers; a difference here is a finding, not an edit to them.
const CASE_1 = {
  name: 'v',
  inputSchema: {
    type: 'object',
    title: 'T',
    description: 'D',
    properties: {
      description: { type: 'string', description: 'an argument named description' },
      n: { type: 'integer', minimum: 1, description: 'x' },
      flag: { type: 'boolean', default: false },
      tags: { type: 'array', items: { type: 'string', description: 'y' } }
    },
    required: ['description'],
    additionalProperties: false
  }
};
const OPTS = {
  type: 'object',
  description: 'z',
  default: { description: 'data, not a keyword' },
  anyOf: [{ type: 'object', title: 'a subschema\'s title' }]
};
const CASE_2 = {
  name: 'v',
  inputSchema: { ...CASE_1.inputSchema, properties: { ...CASE_1.inputSchema.properties, opts: OPTS } }
};

const CASE_1_TEXT =
  '{"inputSchema":{"additionalProperties":false,"properties":{"description":{"type":"string"},' +
  '"flag":{"default":false,"type":"boolean"},"n":{"minimum":1,"type":"integer"},' +
  '"tags":{"items":{"type":"string"},"type":"array"}},"required":["description"],"type":"object"},"name":"v"}';
const CASE_2_TEXT =
  '{"inputSchema":{"additionalProperties":false,"properties":{"description":{"type":"string"},' +
  '"flag":{"default":false,"type":"boolean"},"n":{"minimum":1,"type":"integer"},' +
  '"opts":{"anyOf":[{"type":"object"}],"default":{"description":"data, not a keyword"},"type":"object"},' +
  '"tags":{"items":{"type":"string"},"type":"array"}},"required":["description"],"type":"object"},"name":"v"}';
const CASE_1_SHA = '7d059d0a5564530b86cd74e9c72269f9d507e1a93eb26979666a89eb8e8455eb';
const CASE_2_SHA = 'd79d93f1d11b85e4fc07d6c4b73fd7c4880bca58555c159bed96e30a57984852';
const STRIPPED_INSIDE_DEFAULT_SHA = '2ab850b0a2234575312daea5512685b5f2e620d47fa17723909f34cf390a792a';
const ANYOF_NOT_WALKED_SHA = '1aff7763977b498874f890f3ad91bd35e437c7c8a80d8812b8add338a06b15e7';

/** Case 2's correct canonical form, with `opts` replaced: the shape a wrong walk produces. */
function case2With(opts: Record<string, unknown>) {
  const correct = JSON.parse(CASE_2_TEXT) as { inputSchema: { properties: Record<string, unknown> } };
  correct.inputSchema.properties.opts = opts;
  return correct as Parameters<typeof canonicalJson>[0];
}
const sha256 = (text: string) => createHash('sha256').update(text, 'utf8').digest('hex');

describe('mcpToolSchemaSha256 reproduces the worked example', () => {
  test('case 1: canonical text and hash', () => {
    expect(mcpToolSchemaCanonical(CASE_1)).toBe(CASE_1_TEXT);
    expect(mcpToolSchemaSha256(CASE_1)).toBe(CASE_1_SHA);
  });

  test('case 2: an argument named description is kept, default is data, anyOf is walked', () => {
    expect(mcpToolSchemaCanonical(CASE_2)).toBe(CASE_2_TEXT);
    expect(mcpToolSchemaSha256(CASE_2)).toBe(CASE_2_SHA);
  });

  test('wrong walk: stripping inside default gives the other hash, which the helper does not', () => {
    const wrong = canonicalJson(case2With({ anyOf: [{ type: 'object' }], default: {}, type: 'object' }));
    expect(sha256(wrong)).toBe(STRIPPED_INSIDE_DEFAULT_SHA);
    expect(mcpToolSchemaSha256(CASE_2)).not.toBe(STRIPPED_INSIDE_DEFAULT_SHA);
  });

  test('wrong walk: not walking anyOf gives the other hash, which the helper does not', () => {
    const wrong = canonicalJson(case2With({
      anyOf: [{ type: 'object', title: 'a subschema\'s title' }],
      default: { description: 'data, not a keyword' },
      type: 'object'
    }));
    expect(sha256(wrong)).toBe(ANYOF_NOT_WALKED_SHA);
    expect(mcpToolSchemaSha256(CASE_2)).not.toBe(ANYOF_NOT_WALKED_SHA);
  });
});
