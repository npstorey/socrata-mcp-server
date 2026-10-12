import { AsyncLocalStorage } from 'node:async_hooks';

/**
 * How long one tool call may wait on a portal (#79).
 *
 * Each portal request used to be given 30 s, and one that ran past it was sent up to three more
 * times, so a slow query held a call for about two minutes and the portal ran it four times. A
 * call's requests also run one after another (`get_data` asks for a count, then the data), each
 * with its own 30 s. The website's MCP client gives a call 45 s (civic-ai-tools-website
 * src/lib/mcp/client.ts:12), and today that timer stops once this server's response headers
 * arrive, which they do at once, so nothing but this server bounds a call.
 *
 * So a call has one limit across all of its portal requests, and each request is given the
 * shorter of 30 s and the call's time left. `get_data` calls on data.lacity.org answered in up
 * to 26.6 s in the website's October evaluation, so the per-request 30 s stays.
 *
 * The limit is carried by AsyncLocalStorage from the tool handler (src/index.ts) to every request
 * the call makes, so no handler passes it along by hand.
 */
export const REQUEST_LIMIT_MS = 30_000;
export const CALL_LIMIT_MS = 40_000;

export type CallBudget = { start: number; deadline: number };

const current = new AsyncLocalStorage<CallBudget>();

/** Runs one tool call's work under its limit. `limitMs` is for tests. */
export function withCallLimit<T>(fn: () => Promise<T>, limitMs: number = CALL_LIMIT_MS): Promise<T> {
  const start = Date.now();
  return current.run({ start, deadline: start + limitMs }, fn);
}

/** The limit of the call running now, if any. */
export function currentCall(): CallBudget | undefined {
  return current.getStore();
}

/** The limit a request is held to: its call's, or, outside any call, one of its own. */
export function callBudget(): CallBudget {
  const budget = current.getStore();
  if (budget) return budget;
  const start = Date.now();
  return { start, deadline: start + CALL_LIMIT_MS };
}

/** How long the next request may take: the shorter of 30 s and the call's time left. */
export function allowanceMs(budget: CallBudget = callBudget()): number {
  return Math.min(REQUEST_LIMIT_MS, budget.deadline - Date.now());
}

/**
 * The time bounds a request is sent with. Axios's `timeout` measures only silence on the socket,
 * so a portal that sends a byte now and then is never stopped by it; the signal bounds the total.
 */
export function timeBounds(allowedMs: number): { timeout: number; signal: AbortSignal } {
  return { timeout: allowedMs, signal: AbortSignal.timeout(allowedMs) };
}
