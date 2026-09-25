/**
 * Portal calls behind an egress proxy (src/utils/outbound-proxy.ts).
 *
 * Three cases drive the behaviour, not the API: a tunnel when a proxy is set, the direct path when
 * none is, and `NO_PROXY` honoured. The proxy here is a loopback forward proxy that admits a
 * destination ONLY through `CONNECT`, which is the shape of the egress proxy this exists for:
 * measured at axios 1.9.0, a plain absolute-form request is what axios sends on its own, and this
 * proxy refuses it with 405 exactly as the real one would.
 *
 * Every request goes through the default axios instance, which is what all three call sites in
 * src use (`axios(config)` in src/utils/api.ts, `axios.get` in src/tools/socrata-tools.ts and
 * src/mcp/tools/socrata.ts), so what is measured here is what those calls do.
 *
 * The `https://` case is measured up to the TLS handshake: the tunnel's far end reads the
 * ClientHello, records its server name and closes, because a loopback origin cannot present a
 * certificate for a portal's name without a certificate generator this suite does not depend on.
 * A full `https://` portal call through a CONNECT-only proxy is measured by the container-image
 * job in .github/workflows/ci.yml, against a live portal, from a network with no other way out.
 */

import { describe, it, expect, afterEach, beforeAll, afterAll } from 'vitest';
import http from 'node:http';
import net from 'node:net';
import axios from 'axios';
import {
  DEFAULT_NO_PROXY_HOSTS,
  installOutboundProxy,
  proxyUrlFor,
  resolveProxySettings,
  shouldProxyDestination
} from '../utils/outbound-proxy.js';

/** A destination name that resolves nowhere: only a tunnel can reach it. */
const PORTAL = 'portal-probe.invalid';

/**
 * A loopback address that is NOT in the default exemption list. `connect()` to it reaches this
 * host on Linux and macOS, so a request to it can complete on the direct path, which is what the
 * `NO_PROXY` case needs: a destination that goes through the proxy unless the operator exempts it.
 */
const NON_DEFAULT_LOOPBACK = '0.0.0.0';

const PROXY_VARIABLES = ['HTTP_PROXY', 'http_proxy', 'HTTPS_PROXY', 'https_proxy', 'NO_PROXY', 'no_proxy'] as const;

interface Origin {
  port: number;
  seen: { line: string; host: string | undefined }[];
  close: () => void;
}

/** A plain loopback origin that records what reaches it and answers 200. */
async function loopbackOrigin(): Promise<Origin> {
  const seen: Origin['seen'] = [];
  const server = http.createServer((req, res) => {
    seen.push({ line: `${req.method} ${req.url}`, host: req.headers.host });
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ via: 'origin', path: req.url }));
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  return { port: (server.address() as net.AddressInfo).port, seen, close: () => server.close() };
}

interface TlsFarEnd {
  port: number;
  hellos: { serverName: string | null; firstByte: number }[];
  close: () => void;
}

/**
 * Read the server name out of a TLS ClientHello. Just enough of the record to find the SNI
 * extension; anything unexpected yields `null` rather than a throw.
 */
function serverNameOf(hello: Buffer): string | null {
  try {
    if (hello[0] !== 0x16 || hello[5] !== 0x01) return null;
    let offset = 43; // record header (5) + handshake header (4) + version (2) + random (32)
    offset += 1 + hello[offset]; // session id
    offset += 2 + hello.readUInt16BE(offset); // cipher suites
    offset += 1 + hello[offset]; // compression methods
    const extensionsEnd = offset + 2 + hello.readUInt16BE(offset);
    offset += 2;
    while (offset + 4 <= extensionsEnd) {
      const type = hello.readUInt16BE(offset);
      const length = hello.readUInt16BE(offset + 2);
      if (type === 0) {
        const nameLength = hello.readUInt16BE(offset + 7);
        return hello.subarray(offset + 9, offset + 9 + nameLength).toString('ascii');
      }
      offset += 4 + length;
    }
    return null;
  } catch {
    return null;
  }
}

/** The far end of an `https://` tunnel: records the ClientHello's server name, then closes. */
async function tlsFarEnd(): Promise<TlsFarEnd> {
  const hellos: TlsFarEnd['hellos'] = [];
  const server = net.createServer(socket => {
    socket.once('data', chunk => {
      hellos.push({ serverName: serverNameOf(chunk), firstByte: chunk[0] });
      socket.destroy();
    });
    socket.on('error', () => undefined);
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  return { port: (server.address() as net.AddressInfo).port, hellos, close: () => server.close() };
}

interface Proxy {
  port: number;
  url: string;
  tunnels: { authority: string; headers: http.IncomingHttpHeaders }[];
  plain: string[];
  close: () => void;
}

/**
 * A loopback forward proxy that admits a destination only through `CONNECT`. A `CONNECT` to port
 * 443 is tunnelled to `tls.port`, anything else to `origin.port`; a plain request is refused with
 * 405 and recorded, which is the failure this module exists to prevent. With `refuseConnect` the
 * proxy answers every `CONNECT` with 403, for the case where the proxy itself says no.
 */
async function loopbackProxy(
  origin: Origin,
  tls: TlsFarEnd,
  options: { refuseConnect?: boolean } = {}
): Promise<Proxy> {
  const tunnels: Proxy['tunnels'] = [];
  const plain: string[] = [];
  const server = http.createServer((req, res) => {
    plain.push(`${req.method} ${req.url}`);
    res.writeHead(405, { 'content-type': 'text/plain' });
    res.end('this proxy admits a destination only through CONNECT\n');
  });
  server.on('connect', (req, clientSocket, head) => {
    tunnels.push({ authority: req.url ?? '', headers: req.headers });
    if (options.refuseConnect) {
      clientSocket.end('HTTP/1.1 403 Forbidden\r\nContent-Length: 0\r\n\r\n');
      return;
    }
    const port = (req.url ?? '').endsWith(':443') ? tls.port : origin.port;
    const upstream = net.connect(port, '127.0.0.1', () => {
      clientSocket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      if (head.length > 0) upstream.write(head);
      upstream.pipe(clientSocket);
      clientSocket.pipe(upstream);
    });
    upstream.on('error', () => clientSocket.destroy());
    clientSocket.on('error', () => upstream.destroy());
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as net.AddressInfo).port;
  return { port, url: `http://127.0.0.1:${port}`, tunnels, plain, close: () => server.close() };
}

let origin: Origin;
let tls: TlsFarEnd;
let proxy: Proxy;
const shellEnv: Partial<Record<(typeof PROXY_VARIABLES)[number], string | undefined>> = {};

beforeAll(async () => {
  origin = await loopbackOrigin();
  tls = await tlsFarEnd();
  proxy = await loopbackProxy(origin, tls);
  // axios reads the same variables on its own when `proxy` is not switched off; a developer's
  // shell must not decide what "unset" means here.
  for (const name of PROXY_VARIABLES) {
    shellEnv[name] = process.env[name];
    delete process.env[name];
  }
});

afterAll(() => {
  proxy.close();
  tls.close();
  origin.close();
  for (const name of PROXY_VARIABLES) {
    if (shellEnv[name] !== undefined) process.env[name] = shellEnv[name];
  }
});

afterEach(() => {
  installOutboundProxy({}, axios);
  origin.seen.length = 0;
  tls.hellos.length = 0;
  proxy.tunnels.length = 0;
  proxy.plain.length = 0;
});

const swallow = async (fn: () => Promise<unknown>): Promise<unknown> => {
  try {
    return await fn();
  } catch (error) {
    return error;
  }
};

describe('resolveProxySettings', () => {
  it('is disabled with nothing set, and the exemption list is the loopback defaults', () => {
    const settings = resolveProxySettings({});
    expect(settings.enabled).toBe(false);
    expect(settings.honoured).toEqual([]);
    expect(settings.noProxy).toBe(DEFAULT_NO_PROXY_HOSTS.join(','));
  });

  it('names the variables it honours, never their values, and prepends loopback to NO_PROXY', () => {
    const settings = resolveProxySettings({
      HTTPS_PROXY: 'http://user:secret@proxy.internal:3128',
      NO_PROXY: '.internal.example,portal.city'
    });
    expect(settings.enabled).toBe(true);
    expect(settings.honoured).toEqual(['HTTPS_PROXY', 'NO_PROXY']);
    expect(settings.noProxy).toBe(`${DEFAULT_NO_PROXY_HOSTS.join(',')},.internal.example,portal.city`);
    expect(JSON.stringify(settings.honoured)).not.toContain('secret');
  });

  it('lower-case spelling wins over upper-case', () => {
    const settings = resolveProxySettings({ HTTP_PROXY: 'http://upper:1', http_proxy: 'http://lower:2' });
    expect(settings.httpProxy).toBe('http://lower:2');
  });

  it('an https destination falls back to HTTP_PROXY when HTTPS_PROXY is unset', () => {
    const settings = resolveProxySettings({ HTTP_PROXY: 'http://proxy.internal:3128' });
    expect(proxyUrlFor('https:', settings)).toBe('http://proxy.internal:3128');
    expect(proxyUrlFor('http:', settings)).toBe('http://proxy.internal:3128');
    const both = resolveProxySettings({ HTTP_PROXY: 'http://a:1', HTTPS_PROXY: 'http://b:2' });
    expect(proxyUrlFor('https:', both)).toBe('http://b:2');
  });
});

describe('shouldProxyDestination', () => {
  const defaults = DEFAULT_NO_PROXY_HOSTS.join(',');
  const cases: [string, string, boolean][] = [
    ['https://data.cityofnewyork.us/api', defaults, true],
    ['http://localhost:8000/healthz', defaults, false],
    ['http://127.0.0.1:8000/healthz', defaults, false],
    ['http://[::1]:8000/healthz', defaults, false],
    ['https://data.cityofnewyork.us/api', `${defaults},data.cityofnewyork.us`, false],
    ['https://data.cityofnewyork.us/api', `${defaults},.cityofnewyork.us`, false],
    ['https://data.cityofnewyork.us/api', `${defaults},*.cityofnewyork.us`, false],
    ['https://data.cityofnewyork.us/api', `${defaults},cityofnewyork.us`, true],
    ['https://data.cityofnewyork.us/api', `${defaults},data.cityofnewyork.us:8443`, true],
    ['https://data.cityofnewyork.us:8443/api', `${defaults},data.cityofnewyork.us:8443`, false],
    ['https://DATA.CityOfNewYork.us/api', `${defaults},data.cityofnewyork.us`, false],
    ['https://data.cityofnewyork.us/api', `${defaults},*`, false],
    ['https://data.cityofnewyork.us/api', '*', false],
    ['https://data.cityofnewyork.us/api', '', true]
  ];
  for (const [url, noProxy, expected] of cases) {
    it(`${url} with NO_PROXY="${noProxy}" -> ${expected ? 'proxied' : 'direct'}`, () => {
      expect(shouldProxyDestination(new URL(url), noProxy)).toBe(expected);
    });
  }
});

describe('with a proxy set, a portal call is tunnelled through CONNECT', () => {
  it('an http destination: CONNECT at the proxy, the request at the far end, the answer back', async () => {
    expect(installOutboundProxy({ HTTP_PROXY: proxy.url }, axios).installed).toBe(true);
    const response = await axios.get(`http://${PORTAL}:${origin.port}/api/catalog/v1`, { params: { q: 'x' } });
    expect(response.status).toBe(200);
    expect(response.data).toEqual({ via: 'origin', path: '/api/catalog/v1?q=x' });
    expect(proxy.tunnels.map(t => t.authority)).toEqual([`${PORTAL}:${origin.port}`]);
    expect(proxy.plain).toEqual([]);
    expect(origin.seen).toEqual([{ line: 'GET /api/catalog/v1?q=x', host: `${PORTAL}:${origin.port}` }]);
  });

  it('an https destination: CONNECT to :443, then a TLS handshake for the portal name through the tunnel', async () => {
    installOutboundProxy({ HTTPS_PROXY: proxy.url }, axios);
    await swallow(() => axios.get(`https://${PORTAL}/api/views/abcd-1234.json`));
    expect(proxy.tunnels.map(t => t.authority)).toEqual([`${PORTAL}:443`]);
    expect(proxy.plain).toEqual([]);
    expect(tls.hellos).toEqual([{ serverName: PORTAL, firstByte: 0x16 }]);
  });

  it('an https destination with only HTTP_PROXY set is still tunnelled, not sent direct', async () => {
    installOutboundProxy({ HTTP_PROXY: proxy.url }, axios);
    await swallow(() => axios.get(`https://${PORTAL}/api/views/abcd-1234.json`));
    expect(proxy.tunnels.map(t => t.authority)).toEqual([`${PORTAL}:443`]);
    expect(tls.hellos.map(h => h.serverName)).toEqual([PORTAL]);
  });

  it('a POST body goes through the tunnel intact (the SODA3 query path)', async () => {
    installOutboundProxy({ HTTP_PROXY: proxy.url }, axios);
    const response = await axios({
      method: 'post',
      url: `http://${PORTAL}:${origin.port}/api/v3/views/abcd-1234/query.json`,
      data: { query: 'SELECT * LIMIT 1' },
      headers: { 'Content-Type': 'application/json' }
    });
    expect(response.status).toBe(200);
    expect(origin.seen.map(s => s.line)).toEqual(['POST /api/v3/views/abcd-1234/query.json']);
  });

  it('a proxy address carrying a user and password reaches the tunnel as Proxy-Authorization', async () => {
    installOutboundProxy({ HTTP_PROXY: `http://user:p%40ss@127.0.0.1:${proxy.port}` }, axios);
    await axios.get(`http://${PORTAL}:${origin.port}/api/catalog/v1`);
    expect(proxy.tunnels).toHaveLength(1);
    expect(proxy.tunnels[0].headers['proxy-authorization']).toBe(
      `Basic ${Buffer.from('user:p@ss').toString('base64')}`
    );
  });

  it("a CONNECT the proxy refuses fails the call with the proxy's status, and nothing else is tried", async () => {
    const refusing = await loopbackProxy(origin, tls, { refuseConnect: true });
    try {
      installOutboundProxy({ HTTP_PROXY: refusing.url }, axios);
      const error = (await swallow(() => axios.get(`http://${PORTAL}:${origin.port}/api/catalog/v1`))) as Error;
      expect(error).toBeInstanceOf(Error);
      expect(error.message).toMatch(/refused CONNECT to portal-probe\.invalid:\d+ with status 403/);
      expect(refusing.plain).toEqual([]);
      expect(origin.seen).toEqual([]);
    } finally {
      refusing.close();
    }
  });
});

describe('with no proxy set, every call is direct and axios is untouched', () => {
  it('installs nothing and leaves the defaults as axios shipped them', async () => {
    const before = { http: axios.defaults.httpAgent, https: axios.defaults.httpsAgent, proxy: axios.defaults.proxy };
    expect(installOutboundProxy({}, axios)).toEqual({ installed: false, honoured: [] });
    expect(axios.defaults.httpAgent).toBe(before.http);
    expect(axios.defaults.httpsAgent).toBe(before.https);
    expect(axios.defaults.proxy).toBe(before.proxy);

    const response = await axios.get(`http://127.0.0.1:${origin.port}/direct`);
    expect(response.data).toEqual({ via: 'origin', path: '/direct' });
    expect(origin.seen).toEqual([{ line: 'GET /direct', host: `127.0.0.1:${origin.port}` }]);
    expect(proxy.tunnels).toEqual([]);
    expect(proxy.plain).toEqual([]);
  });

  it('a proxied process that is no longer proxied gets its previous defaults back', () => {
    const before = { http: axios.defaults.httpAgent, https: axios.defaults.httpsAgent, proxy: axios.defaults.proxy };
    installOutboundProxy({ HTTPS_PROXY: proxy.url }, axios);
    expect(axios.defaults.proxy).toBe(false);
    expect(axios.defaults.httpsAgent).not.toBe(before.https);
    expect(installOutboundProxy({ HTTPS_PROXY: proxy.url }, axios)).toEqual({
      installed: false,
      honoured: ['HTTPS_PROXY']
    });
    installOutboundProxy({}, axios);
    expect(axios.defaults.httpAgent).toBe(before.http);
    expect(axios.defaults.httpsAgent).toBe(before.https);
    expect(axios.defaults.proxy).toBe(before.proxy);
  });
});

describe('NO_PROXY is honoured', () => {
  it('a destination the operator exempts goes direct; the same destination unexempted goes through the proxy', async () => {
    installOutboundProxy({ HTTP_PROXY: proxy.url }, axios);
    await swallow(() => axios.get(`http://${NON_DEFAULT_LOOPBACK}:${origin.port}/exempt`));
    expect(proxy.tunnels.map(t => t.authority)).toEqual([`${NON_DEFAULT_LOOPBACK}:${origin.port}`]);
    proxy.tunnels.length = 0;
    origin.seen.length = 0;

    installOutboundProxy({ HTTP_PROXY: proxy.url, NO_PROXY: NON_DEFAULT_LOOPBACK }, axios);
    const response = await axios.get(`http://${NON_DEFAULT_LOOPBACK}:${origin.port}/exempt`);
    expect(response.data).toEqual({ via: 'origin', path: '/exempt' });
    expect(proxy.tunnels).toEqual([]);
    expect(proxy.plain).toEqual([]);
    expect(origin.seen).toEqual([{ line: 'GET /exempt', host: `${NON_DEFAULT_LOOPBACK}:${origin.port}` }]);
  });

  it('a suffix entry exempts every host under it', async () => {
    installOutboundProxy({ HTTPS_PROXY: proxy.url, NO_PROXY: '.invalid' }, axios);
    await swallow(() => axios.get(`https://${PORTAL}/api/views/abcd-1234.json`));
    expect(proxy.tunnels).toEqual([]);
    expect(tls.hellos).toEqual([]);
  });

  it('loopback is exempt by default, so a service beside this one stays direct', async () => {
    installOutboundProxy({ HTTP_PROXY: proxy.url, HTTPS_PROXY: proxy.url }, axios);
    for (const host of ['127.0.0.1', 'localhost']) {
      const response = await axios.get(`http://${host}:${origin.port}/local`);
      expect(response.data).toEqual({ via: 'origin', path: '/local' });
    }
    expect(proxy.tunnels).toEqual([]);
    expect(proxy.plain).toEqual([]);
    expect(origin.seen.map(s => s.line)).toEqual(['GET /local', 'GET /local']);
  });
});
