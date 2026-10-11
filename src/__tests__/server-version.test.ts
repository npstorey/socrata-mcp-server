/**
 * The version this server reports is the version it is published as.
 *
 * WHAT WAS WRONG. `src/index.ts` states `serverInfo` twice: once to the SDK `Server` constructor,
 * and once in its own `initialize` handler, which replaces the SDK's and is the one a client
 * reads. Both were the literal `'0.1.5'`, and neither moved when package.json did not, so a
 * build of any later tree would still have introduced itself as 0.1.5.
 *
 * WHAT THIS DRIVES. package.json is the oracle; each check reads it rather than restating it.
 *  1. The real `createServer()` over an in-memory transport, one raw `initialize`: its
 *     `serverInfo` carries package.json's name and version.
 *  2. The `Server` that `createServer()` builds: the info it was constructed with carries the
 *     same. That is the first literal, which no `initialize` reaches while the handler is ours.
 *  3. package-lock.json's two root version fields equal package.json's (a hand-edited bump
 *     moves package.json alone; `npm version` moves all three).
 *
 * STATED BLIND SPOTS. Check 2 reads the SDK's private `_serverInfo` field (SDK 1.30.0); if a
 * dependency bump renames it, that check fails on its premise, and says so. Nothing here reads
 * the version a published tarball reports: the publish kit's start check does that.
 */
import { describe, test, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { Implementation, JSONRPCMessage } from '@modelcontextprotocol/sdk/types.js';
import { createServer } from '../index.js';

const readJson = (relative: string) =>
  JSON.parse(readFileSync(fileURLToPath(new URL(relative, import.meta.url)), 'utf8'));

const pkg = readJson('../../package.json') as { name: string; version: string };
const lock = readJson('../../package-lock.json') as {
  version: string;
  packages: Record<string, { version?: string }>;
};

type RpcResponse = { id: number; result?: { serverInfo?: Implementation }; error?: unknown };

/** Sends one raw `initialize` to `server` and returns the JSON-RPC response envelope. */
async function initializeOver(server: Server): Promise<RpcResponse> {
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
      params: {
        protocolVersion: '2025-11-25',
        capabilities: {},
        clientInfo: { name: 'server-version-test', version: '0.0.0' }
      }
    } as JSONRPCMessage);
    return await response;
  } finally {
    await clientSide.close();
    await server.close();
  }
}

describe('the version the server reports is package.json version', () => {
  test(`initialize answers serverInfo ${pkg.name} ${pkg.version}`, async () => {
    const response = await initializeOver(await createServer());
    expect(response.error).toBeUndefined();
    expect(response.result?.serverInfo).toEqual({ name: pkg.name, version: pkg.version });
  });

  test('the Server createServer() builds is constructed with the same info', async () => {
    const server = await createServer();
    const info = (server as unknown as { _serverInfo?: Implementation })._serverInfo;
    expect(info, 'premise: SDK Server keeps its constructor info in _serverInfo').toBeDefined();
    expect(info).toEqual({ name: pkg.name, version: pkg.version });
  });

  test('package-lock.json root versions equal package.json version', () => {
    expect(lock.version).toBe(pkg.version);
    expect(lock.packages['']?.version).toBe(pkg.version);
  });
});
