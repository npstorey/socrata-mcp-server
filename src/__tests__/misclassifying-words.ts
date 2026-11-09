import type { Server } from 'node:http';

/**
 * Words the website's failure classifier reads as "the source was unreachable, slow or
 * rate-limited" (civic-ai-tools-website `src/lib/streaming.ts` `classifyStreamError`, at
 * ea1164c), plus `parse`, which its client's SSE branch (`src/lib/mcp/client.ts`) treats as a
 * parse failure and replaces. A refusal is none of those things, so its text carries none of
 * them. The website's own classifier is the authority; this copy is a local early warning.
 *
 * Shared by every test that pins a refusal's wording.
 */
export const MISCLASSIFYING_WORDS = [
  'unavailable', 'mcp server', 'mcp tool', 'initialization failed', 'econnrefused', 'enotfound',
  'fetch failed', '502', '503', '504', 'failed to connect', 'no response body', 'network',
  'connection', 'timed out', 'timeout', 'did not respond within', 'rate limit', '429',
  'socrata_mcp_url', 'no model api key', 'missing credentials', 'invalid api key',
  'incorrect api key', 'parse'
];

/** The words of `MISCLASSIFYING_WORDS` a message carries, matched case-insensitively. */
export function misclassifyingWordsIn(message: string): string[] {
  const lower = message.toLowerCase();
  return MISCLASSIFYING_WORDS.filter((word) => lower.includes(word));
}

/**
 * Listens `server` on the first free loopback port from 42901 to 42999 and returns the port. Each
 * of those ports spells `429`, a listed word. Some refusals name the portal's host, and a test
 * origin's host is `127.0.0.1:<port>`, so a random port can put a listed word in a refusal whose
 * own words carry none (#102). A case on one of these ports keeps that from deciding a word check.
 */
export async function listenOnAPortSpelling429(server: Server): Promise<number> {
  for (let port = 42_901; port <= 42_999; port++) {
    const listening = await new Promise<boolean>((resolve, reject) => {
      const onError = (error: NodeJS.ErrnoException) => {
        server.off('listening', onListening);
        if (error.code === 'EADDRINUSE') resolve(false);
        else reject(error);
      };
      const onListening = () => {
        server.off('error', onError);
        resolve(true);
      };
      server.once('error', onError);
      server.once('listening', onListening);
      server.listen(port, '127.0.0.1');
    });
    if (listening) return port;
  }
  throw new Error('no free loopback port from 42901 to 42999');
}
