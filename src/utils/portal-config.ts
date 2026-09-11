/**
 * One resolver for "the portal this server is configured for", including the case where it is
 * configured for none.
 *
 * `DATA_PORTAL_URL` is optional (server#63). Set, it is the default portal for a call that names
 * none. Unset, there is no default: this server does not choose a portal on a caller's behalf,
 * and a call that names no portal is refused, per call (`resolvePortalDomain`). Absence is a
 * legitimate configuration rather than a startup failure, because a deployment may front more
 * than one portal and answer whichever one a call names.
 *
 * The refusal is an `McpError`, which the SDK turns into a JSON-RPC `error` carrying its code
 * (-32602, invalid params). It is never a tool result carrying `isError: true`: a client that
 * records only the error path as a rejected call would read such a result as an answer.
 *
 * This module is pure and reads only the environment, so anything that needs to *name* the
 * portal can import it without taking a network dependency.
 *
 * ALWAYS CALL IT, NEVER SNAPSHOT IT. `src/index.ts` calls `dotenv.config()` in its module body,
 * which runs after every import that module makes. A caller that resolves the domain at
 * module-load time therefore reads the environment before dotenv has populated it. Callers that
 * need the domain inside a string expose that string through a getter or build it per request.
 * `src/__tests__/portal-default-guard.test.ts` fails on a load-time read anywhere in the tree.
 */

import { McpError, ErrorCode } from './mcp-errors.js';

/** The words every advertised surface uses when there is no default portal. */
export const NO_DEFAULT_PORTAL = 'no default portal configured';

/**
 * The bare host of the configured default portal, e.g. `data.cityofchicago.org`, or `undefined`
 * when `DATA_PORTAL_URL` is unset or blank. Every default `domain` a handler uses and every
 * advertised string that names the portal resolves through this function.
 */
export function getDefaultDomain(): string | undefined {
  const url = process.env.DATA_PORTAL_URL?.trim();
  if (!url) return undefined;
  return url.replace(/^https?:\/\//, '');
}

/**
 * The portal a call addresses: the one it names, else the configured default. With neither,
 * the call is refused, and `howToNameOne` says, in the terms of the tool that was called, what
 * to do instead.
 *
 * Clients classify failures by their wording, so the refusal text is never empty and avoids
 * words that would assert something false about the call: that a source was unreachable, slow
 * or rate-limited. It is none of those; it is a call that did not say which portal it meant.
 */
export function resolvePortalDomain(named: string | undefined, howToNameOne: string): string {
  const domain = named || getDefaultDomain();
  if (domain) return domain;
  throw new McpError(
    ErrorCode.InvalidParams,
    `This call names no portal, and this server has ${NO_DEFAULT_PORTAL}, so it will not choose one on your behalf. ${howToNameOne} (An operator can set a default portal with DATA_PORTAL_URL.)`
  );
}

/**
 * How advertised prose names the portal: the configured default, or a statement that there is
 * none. Never a portal the server is not configured for.
 */
export function describeConfiguredPortal(): string {
  const domain = getDefaultDomain();
  return domain
    ? `the open data portal this server is configured for (${domain})`
    : `a Socrata open data portal named in each call (this server has ${NO_DEFAULT_PORTAL})`;
}
