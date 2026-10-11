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
