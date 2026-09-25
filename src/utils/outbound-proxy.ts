// The egress proxy for portal calls.
//
// WHAT THIS IS FOR. On a network where outbound traffic must leave through an
// egress proxy, every portal call this server makes has to be told about that
// proxy. The conventional way an operator says so is `HTTP_PROXY` /
// `HTTPS_PROXY` / `NO_PROXY`.
//
// AXIOS READS THOSE VARIABLES, AND GETS THEM WRONG FOR HTTPS. Measured at axios
// 1.9.0 against a loopback proxy that admits HTTPS only through `CONNECT` (the
// usual egress-proxy setup): with `HTTPS_PROXY` set, axios sends
// `GET https://portal/...` to the proxy as a plain absolute-form request and
// never opens a tunnel (`node_modules/axios/lib/adapters/http.js`, `setProxy`:
// the request's protocol becomes the proxy's `http:` and its path the full
// portal URL). The proxy refuses with 405 and every portal call fails. And with
// only `HTTP_PROXY` set, axios ignores the proxy for `https://` destinations
// altogether (proxy-from-env falls back to `all_proxy`, never to `http_proxy`).
// So the routing decision, the tunnel and the fallback all have to be ours.
//
// HOW. Two agents, one per destination protocol, whose `createConnection`
// decides per connection whether the destination is exempt (`NO_PROXY`) and
// otherwise opens a `CONNECT` tunnel through the proxy, wrapping TLS over it for
// `https://`. They are installed as the default instance's `httpAgent` and
// `httpsAgent`, with axios's own proxy handling switched off (`proxy: false`),
// so every call site that uses the default instance is covered and none has to
// know. The decision lives in the agent rather than in a per-request hook so
// that a redirect to another host is decided again for that host.
//
// THE SAME CONVENTION AS THE APPLICATION IN FRONT OF THIS SERVER. The
// resolver, the `NO_PROXY` matcher and the tunnel are ported from the website's
// `src/lib/outbound-proxy.ts` and `src/lib/signin-proxy.ts`, so an operator
// who has configured one has configured the other: lower-case spelling wins,
// `https://` destinations fall back to `HTTP_PROXY`, loopback is always exempt,
// and `NO_PROXY` entries are exact or suffix (`.` / `*` prefix) matches with an
// optional `:port`. The website's fetch path installs an undici dispatcher; this
// server makes no `fetch` call, so that path has nothing to govern here, and
// its `node:http(s)` path is the one followed. No new dependency: what a proxy
// package would add is the tunnel below, and none carries this `NO_PROXY`
// matcher.
//
// DEFAULTS OFF. With none of the variables set, `installOutboundProxy` leaves
// axios exactly as it found it: no agent, no interceptor, no log line. Every
// request then takes the path and reaches the host it did before this existed.
//
// A PROXY ADDRESS MAY CARRY A USER AND PASSWORD (`http://user:pass@proxy`).
// They are sent as `Proxy-Authorization` on the `CONNECT` and never logged:
// this module prints variable NAMES only.

import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import type { Duplex } from 'node:stream';
import tls from 'node:tls';
import axios, { type AxiosInstance } from 'axios';

/** Variable naming the proxy for `http://` destinations. */
export const HTTP_PROXY_ENV_NAME = 'HTTP_PROXY';

/** Variable naming the proxy for `https://` destinations. */
export const HTTPS_PROXY_ENV_NAME = 'HTTPS_PROXY';

/** Variable naming the destinations that must NOT go through the proxy. */
export const NO_PROXY_ENV_NAME = 'NO_PROXY';

/** All three, in the order the documentation lists them. */
export const PROXY_ENV_NAMES = [HTTP_PROXY_ENV_NAME, HTTPS_PROXY_ENV_NAME, NO_PROXY_ENV_NAME] as const;

/**
 * Destinations that stay direct whatever the operator sets. Loopback only, and
 * spelled the way a URL's `host` carries it: an IPv6 literal keeps its brackets.
 */
export const DEFAULT_NO_PROXY_HOSTS = ['localhost', '127.0.0.1', '[::1]'] as const;

/** How long the proxy has to answer `CONNECT`; the portal request has its own timeout. */
const CONNECT_TIMEOUT_MS = 30_000;

type EnvRecord = Record<string, string | undefined>;

/** What the environment asks for, resolved; no value is ever logged. */
export interface ProxySettings {
  /** True when at least one proxy address is configured. */
  enabled: boolean;
  /** Proxy for `http://` destinations; `''` when unset. */
  httpProxy: string;
  /** Proxy for `https://` destinations; `''` when unset, and then `httpProxy` is used. */
  httpsProxy: string;
  /** The exemption list actually applied: the loopback defaults, then the operator's entries. */
  noProxy: string;
  /** Names (never values) of the variables that carried something. */
  honoured: string[];
}

/**
 * Resolve the three variables. Lower-case spelling wins over upper-case, which
 * is what curl and the rest of the convention do; the upper-case names are the
 * documented ones because they are the ones an operator writes.
 */
export function resolveProxySettings(env: EnvRecord = process.env): ProxySettings {
  const httpProxy = (env.http_proxy ?? env.HTTP_PROXY ?? '').trim();
  const httpsProxy = (env.https_proxy ?? env.HTTPS_PROXY ?? '').trim();
  const noProxyConfigured = (env.no_proxy ?? env.NO_PROXY ?? '').trim();

  const honoured: string[] = [];
  if (httpProxy) honoured.push(HTTP_PROXY_ENV_NAME);
  if (httpsProxy) honoured.push(HTTPS_PROXY_ENV_NAME);
  if (noProxyConfigured) honoured.push(NO_PROXY_ENV_NAME);

  const noProxy = [...DEFAULT_NO_PROXY_HOSTS, noProxyConfigured].filter(entry => entry.length > 0).join(',');

  return {
    enabled: Boolean(httpProxy || httpsProxy),
    httpProxy,
    httpsProxy,
    noProxy,
    honoured
  };
}

/** Ports a destination is understood to be on when its URL names none. */
const DEFAULT_PORTS: Record<string, number> = { 'http:': 80, 'https:': 443 };

/**
 * Does this destination go through the proxy, given the exemption list
 * `resolveProxySettings` composed? The rules are the website's (a port of
 * undici's `EnvHttpProxyAgent` matcher, at 6.28.0):
 *
 *   - the host is taken with its port stripped and lower-cased, and an IPv6
 *     literal keeps its brackets;
 *   - an empty list proxies everything;
 *   - an entry beginning `.` or `*` is a SUFFIX match, anything else is exact;
 *   - an entry carrying `:port` applies only on that port;
 *   - `*` alone exempts everything.
 */
export function shouldProxyDestination(url: URL, noProxy: string): boolean {
  const hostname = url.host.replace(/:\d*$/, '').toLowerCase();
  const port = Number.parseInt(url.port, 10) || DEFAULT_PORTS[url.protocol] || 0;

  const entries = noProxy
    .split(/[,\s]/)
    .filter(entry => entry.length > 0)
    .map(entry => {
      const parsed = /^(.+):(\d+)$/.exec(entry);
      return {
        hostname: (parsed ? parsed[1] : entry).toLowerCase(),
        port: parsed ? Number.parseInt(parsed[2], 10) : 0
      };
    });

  if (entries.length === 0) return true;
  if (noProxy === '*') return false;

  for (const entry of entries) {
    if (entry.port && entry.port !== port) continue;
    if (!/^[.*]/.test(entry.hostname)) {
      if (hostname === entry.hostname) return false;
    } else if (hostname.endsWith(entry.hostname.replace(/^\*/, ''))) {
      return false;
    }
  }

  return true;
}

/**
 * The proxy a destination on this protocol goes through, or `''` for none: an
 * `http://` destination uses `HTTP_PROXY` or goes direct, and an `https://`
 * destination uses `HTTPS_PROXY`, falling back to `HTTP_PROXY`.
 */
export function proxyUrlFor(protocol: string, settings: ProxySettings): string {
  if (protocol === 'https:') return settings.httpsProxy || settings.httpProxy;
  return settings.httpProxy;
}

/** A CONNECT authority: an IPv6 literal is bracketed, everything else is not. */
function authorityOf(host: string, port: number): string {
  const bare = host.replace(/^\[|\]$/g, '');
  return bare.includes(':') ? `[${bare}]:${port}` : `${bare}:${port}`;
}

/**
 * Open a `CONNECT` tunnel to `target` through `proxy` and hand back the socket.
 * `CONNECT` is used for both destination protocols, which is what the website
 * does on both of its paths; one code path rather than two.
 */
function openTunnel(proxy: URL, target: { host: string; port: number }, timeout: number): Promise<net.Socket> {
  return new Promise((resolve, reject) => {
    const proxyIsSecure = proxy.protocol === 'https:';
    const proxyPort = Number(proxy.port) || (proxyIsSecure ? 443 : 80);
    const socket: net.Socket = proxyIsSecure
      ? tls.connect({ host: proxy.hostname, port: proxyPort, servername: proxy.hostname })
      : net.connect({ host: proxy.hostname, port: proxyPort });

    let settled = false;
    const fail = (error: Error) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      reject(error);
    };

    const onError = (error: Error) => fail(error);
    const onTimeout = () => fail(new Error('the egress proxy did not answer CONNECT before the request timeout'));
    const onClose = () => fail(new Error('the egress proxy closed the connection before answering CONNECT'));

    socket.on('error', onError);
    socket.on('close', onClose);
    socket.setTimeout(timeout);
    socket.on('timeout', onTimeout);

    // `latin1` is a byte-for-byte round trip, so whatever follows the blank
    // line survives being sliced back out and pushed in front of the stream.
    let banner = '';
    const onData = (chunk: Buffer) => {
      banner += chunk.toString('latin1');
      const end = banner.indexOf('\r\n\r\n');
      if (end === -1) {
        if (banner.length > 16384) {
          fail(new Error('the egress proxy sent an oversized response to CONNECT'));
        }
        return;
      }

      const status = Number(/^HTTP\/1\.[01] (\d{3})/.exec(banner)?.[1]);
      if (status !== 200) {
        fail(
          new Error(
            `the egress proxy refused CONNECT to ${authorityOf(target.host, target.port)} with ` +
              `${status ? `status ${status}` : 'an unreadable status line'}`
          )
        );
        return;
      }

      settled = true;
      socket.removeListener('data', onData);
      socket.removeListener('error', onError);
      socket.removeListener('close', onClose);
      socket.removeListener('timeout', onTimeout);
      socket.setTimeout(0);

      const head = Buffer.from(banner.slice(end + 4), 'latin1');
      if (head.length > 0) socket.unshift(head);
      resolve(socket);
    };
    socket.on('data', onData);

    const authority = authorityOf(target.host, target.port);
    const authorization = proxy.username
      ? 'Proxy-Authorization: Basic ' +
        Buffer.from(`${decodeURIComponent(proxy.username)}:${decodeURIComponent(proxy.password)}`).toString('base64') +
        '\r\n'
      : '';

    // Once, and on the right event: a `tls.connect` socket emits `connect`
    // before `secureConnect`, so listening for both would send the request
    // line twice to a proxy reached over TLS.
    socket.once(proxyIsSecure ? 'secureConnect' : 'connect', () => {
      socket.write(`CONNECT ${authority} HTTP/1.1\r\nHost: ${authority}\r\n${authorization}\r\n`);
    });
  });
}

/** Where a connection is really going, read off the options Node hands the agent. */
function targetOf(options: http.ClientRequestArgs, defaultPort: number): { host: string; port: number } {
  return {
    host: options.host ?? options.hostname ?? '',
    port: Number(options.port) || defaultPort
  };
}

type ConnectionCallback = (err: Error | null, stream: Duplex) => void;

/**
 * Whether this connection tunnels, and through which proxy. `''` means direct:
 * the destination is exempt, or no proxy is configured for its protocol.
 */
function tunnelFor(protocol: 'http:' | 'https:', target: { host: string; port: number }, settings: ProxySettings): string {
  const destination = new URL(`${protocol}//${authorityOf(target.host, target.port)}`);
  if (!shouldProxyDestination(destination, settings.noProxy)) return '';
  return proxyUrlFor(protocol, settings);
}

/**
 * `http://` destinations. Extends `http.Agent` so `protocol` and `defaultPort`
 * are the ones `http.request` expects; only the socket underneath changes, and
 * only for a destination that is not exempt.
 */
class ProxyTunnelAgent extends http.Agent {
  private readonly settings: ProxySettings;

  constructor(settings: ProxySettings, options?: http.AgentOptions) {
    super(options);
    this.settings = settings;
  }

  createConnection(options: http.ClientRequestArgs, callback?: ConnectionCallback): Duplex | null | undefined {
    const target = targetOf(options, 80);
    const proxyUrl = tunnelFor('http:', target, this.settings);
    if (!proxyUrl) {
      // Direct, exactly as `http.Agent` itself would connect.
      return super.createConnection(options, callback);
    }
    openTunnel(new URL(proxyUrl), target, options.timeout ?? CONNECT_TIMEOUT_MS).then(
      socket => callback?.(null, socket),
      (error: Error) => callback?.(error, null as unknown as Duplex)
    );
    return undefined;
  }
}

/**
 * `https://` destinations: the same tunnel, then TLS over it. Extends
 * `https.Agent` for the same reason: `defaultPort` 443 and `protocol` `https:`
 * are what `https.request` reads before the agent is ever consulted. TLS
 * verification stays on Node's defaults, so a proxy that re-signs traffic with
 * a private authority is trusted the way Node trusts it anywhere else, through
 * `NODE_EXTRA_CA_CERTS`.
 */
class SecureProxyTunnelAgent extends https.Agent {
  private readonly settings: ProxySettings;

  constructor(settings: ProxySettings, options?: https.AgentOptions) {
    super(options);
    this.settings = settings;
  }

  createConnection(options: https.RequestOptions, callback?: ConnectionCallback): Duplex | null | undefined {
    const target = targetOf(options, 443);
    const proxyUrl = tunnelFor('https:', target, this.settings);
    if (!proxyUrl) {
      // Direct, exactly as `https.Agent` itself would connect.
      return super.createConnection(options, callback);
    }
    openTunnel(new URL(proxyUrl), target, options.timeout ?? CONNECT_TIMEOUT_MS).then(
      socket => {
        const secured = tls.connect({
          socket,
          servername: options.servername || target.host.replace(/^\[|\]$/g, ''),
          ca: options.ca,
          cert: options.cert,
          crl: options.crl,
          key: options.key,
          passphrase: options.passphrase,
          pfx: options.pfx
        });
        secured.once('error', () => socket.destroy());
        callback?.(null, secured);
      },
      (error: Error) => callback?.(error, null as unknown as Duplex)
    );
    return undefined;
  }
}

export interface InstallResult {
  /** Whether the agents were installed on this call. */
  installed: boolean;
  /** Names of the variables honoured; empty when nothing is configured. */
  honoured: string[];
}

interface Installation {
  fingerprint: string;
  previous: { httpAgent: unknown; httpsAgent: unknown; proxy: unknown };
}

const installations = new WeakMap<AxiosInstance, Installation>();

/**
 * Install the two agents on an axios instance (the default one unless told
 * otherwise), once. Idempotent: a second call with the same resolved settings
 * changes nothing. With no proxy configured it restores whatever the instance
 * had before a previous install, so a process that was proxied and is no
 * longer is left exactly as axios shipped it.
 *
 * Nothing is printed unless a proxy is configured, and what is printed is
 * variable NAMES only. This server logs to stderr: on the stdio transport
 * stdout is the protocol channel.
 */
export function installOutboundProxy(env: EnvRecord = process.env, instance: AxiosInstance = axios): InstallResult {
  const settings = resolveProxySettings(env);
  const existing = installations.get(instance);

  if (!settings.enabled) {
    if (existing) {
      instance.defaults.httpAgent = existing.previous.httpAgent;
      instance.defaults.httpsAgent = existing.previous.httpsAgent;
      instance.defaults.proxy = existing.previous.proxy as typeof instance.defaults.proxy;
      installations.delete(instance);
    }
    return { installed: false, honoured: [] };
  }

  const fingerprint = JSON.stringify([settings.httpProxy, settings.httpsProxy, settings.noProxy]);
  if (existing?.fingerprint === fingerprint) return { installed: false, honoured: settings.honoured };

  const previous = existing?.previous ?? {
    httpAgent: instance.defaults.httpAgent,
    httpsAgent: instance.defaults.httpsAgent,
    proxy: instance.defaults.proxy
  };

  // `keepAlive` matches Node's own global agents, which is what axios uses
  // when no agent is set; a kept tunnel is reused only for the same destination.
  instance.defaults.httpAgent = new ProxyTunnelAgent(settings, { keepAlive: true });
  instance.defaults.httpsAgent = new SecureProxyTunnelAgent(settings, { keepAlive: true });
  // Off, so axios's own reading of the same variables (the absolute-form
  // request measured above) never runs alongside the tunnel.
  instance.defaults.proxy = false;
  installations.set(instance, { fingerprint, previous });

  console.error(
    `[outbound-proxy] portal calls honour ${settings.honoured.join(', ')}; ` +
      `${DEFAULT_NO_PROXY_HOSTS.join(', ')} stay direct`
  );
  return { installed: true, honoured: settings.honoured };
}
