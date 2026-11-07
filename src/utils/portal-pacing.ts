/**
 * Spacing between requests to one portal, and reading a portal's `Retry-After`.
 *
 * Socrata publishes no request-rate number. Its app-token page says token traffic is not
 * throttled "unless those requests are determined to be abusive or malicious", asks clients to
 * remember the platform is shared, and says a throttled client gets 429
 * (https://dev.socrata.com/docs/app-tokens). Even so, on 2026-11-06 a client sending about 83
 * back-to-back aggregate queries to data.cityofnewyork.us, with an app token, drew 27 429s and
 * 15 503s in about 50 minutes, and no `Retry-After` header.
 *
 * So an operator can ask this server to leave a gap between the requests it sends to one portal
 * host: `SOCRATA_MIN_REQUEST_INTERVAL_MS`. It is off (0) unless set. On a hosted server the gap is
 * shared by every user's calls to that portal, so it becomes a queue that spends each call's 40 s
 * limit (./call-budget.ts); on a single-user stdio server it costs only that user's own bursts.
 * A turn is taken only when it starts inside the call's limit.
 */
export const MIN_INTERVAL_ENV = 'SOCRATA_MIN_REQUEST_INTERVAL_MS';

/** The longest gap the setting may ask for. A larger value would leave no time inside a call. */
export const MAX_INTERVAL_MS = 10_000;

// Read per request, not at import: src/index.ts loads .env after every module is imported.
export function minIntervalMs(): number {
  const raw = process.env[MIN_INTERVAL_ENV];
  if (raw === undefined || raw.trim() === '') return 0;
  const value = Number(raw);
  if (!Number.isFinite(value) || value <= 0) return 0;
  return Math.min(Math.trunc(value), MAX_INTERVAL_MS);
}

/** When the next request to each portal host may start. */
const nextStartByHost = new Map<string, number>();

/**
 * Takes the next turn to send a request to `host` and returns how long to wait for it, in ms.
 * Returns `null`, taking no turn, when the turn would start at or after `deadline`.
 */
export function takeTurn(host: string, deadline: number, now: number = Date.now()): number | null {
  const interval = minIntervalMs();
  if (interval === 0) return 0;
  const start = Math.max(now, nextStartByHost.get(host) ?? 0);
  if (start >= deadline) return null;
  nextStartByHost.set(host, start + interval);
  return start - now;
}

/** Forgets every portal's turns. For tests. */
export function resetPacing(): void {
  nextStartByHost.clear();
}

/**
 * The wait a `Retry-After` header asks for, in ms, or `undefined` when there is none or it cannot
 * be read. RFC 9110 section 10.2.3 allows a number of seconds or an HTTP date.
 */
export function retryAfterMs(header: unknown, now: number = Date.now()): number | undefined {
  if (typeof header !== 'string') return undefined;
  const text = header.trim();
  if (text === '') return undefined;
  if (/^\d+$/.test(text)) return Number(text) * 1000;
  const when = Date.parse(text);
  if (Number.isNaN(when)) return undefined;
  return Math.max(0, when - now);
}
