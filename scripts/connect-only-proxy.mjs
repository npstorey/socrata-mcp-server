#!/usr/bin/env node
/**
 * A forward proxy that admits a destination ONLY through `CONNECT`: the shape
 * of the egress proxy a deployment on a private network puts in front of this
 * server. A plain absolute-form request (`GET https://portal/...`), which is
 * what axios sends on its own (see src/utils/outbound-proxy.ts), is refused
 * with 405 and logged. A `CONNECT` is tunnelled to the authority it names.
 *
 * Zero dependencies. Used by the container-image job in
 * .github/workflows/ci.yml, where it is the only way out of the network the
 * server container is on, and usable locally for the same measurement:
 *
 *   node scripts/connect-only-proxy.mjs &
 *   HTTPS_PROXY=http://127.0.0.1:3128 npm run dev
 *
 * Every line it prints is one request it saw, prefixed so a log can be counted:
 *   [connect-only-proxy] CONNECT <portal-host>:443
 *   [connect-only-proxy] refused GET https://<portal-host>/...
 *
 * Environment:
 *   PROXY_PORT   port to listen on (default 3128)
 *   PROXY_BIND   address to bind (default 127.0.0.1; a container uses 0.0.0.0)
 */

import http from 'node:http';
import net from 'node:net';

const PREFIX = '[connect-only-proxy]';
const port = Number(process.env.PROXY_PORT) || 3128;
const bind = process.env.PROXY_BIND || '127.0.0.1';

const log = (line) => process.stdout.write(`${PREFIX} ${line}\n`);

const server = http.createServer((req, res) => {
  log(`refused ${req.method} ${req.url}`);
  res.writeHead(405, { 'content-type': 'text/plain' });
  res.end('this proxy admits a destination only through CONNECT\n');
});

server.on('connect', (req, clientSocket, head) => {
  const authority = req.url ?? '';
  const match = /^(\[[^\]]+\]|[^:]+):(\d+)$/.exec(authority);
  if (!match) {
    log(`refused CONNECT ${authority} (unreadable authority)`);
    clientSocket.end('HTTP/1.1 400 Bad Request\r\nContent-Length: 0\r\n\r\n');
    return;
  }
  const host = match[1].replace(/^\[|\]$/g, '');
  const targetPort = Number(match[2]);
  log(`CONNECT ${authority}`);

  const upstream = net.connect(targetPort, host, () => {
    clientSocket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
    if (head.length > 0) upstream.write(head);
    upstream.pipe(clientSocket);
    clientSocket.pipe(upstream);
  });
  upstream.on('error', (error) => {
    log(`upstream ${authority} failed: ${error.code ?? error.message}`);
    clientSocket.end('HTTP/1.1 502 Bad Gateway\r\nContent-Length: 0\r\n\r\n');
  });
  clientSocket.on('error', () => upstream.destroy());
});

server.listen(port, bind, () => {
  log(`listening on ${bind}:${port}`);
});

for (const signal of ['SIGTERM', 'SIGINT']) {
  process.on(signal, () => {
    server.close();
    process.exit(0);
  });
}
