/**
 * One resolver for "the portal this server is configured for".
 *
 * This used to be a module-local arrow function in `src/tools/socrata-tools.ts`,
 * which meant `src/index.ts` could not reach it and re-declared the portal's
 * name as literal text instead (server#61). It lives here rather than in
 * `portal-info.ts` because that module pulls in axios and fetches the portal
 * homepage; this one is pure and reads only the environment, so anything that
 * needs to *name* the portal can import it without taking a network dependency.
 *
 * ALWAYS CALL IT, NEVER SNAPSHOT IT. `src/index.ts` calls `dotenv.config()` in
 * its module body, which runs after every import that module makes. A caller
 * that resolves the domain at module-load time therefore reads the environment
 * before dotenv has populated it. Callers that need the domain inside a string
 * expose that string through a getter or build it per request.
 */

/**
 * The portal used when `DATA_PORTAL_URL` is unset.
 *
 * This is a code default naming one deployment, and it is inconsistent with the
 * rest of the tree: `src/utils/portal-info.ts` throws `DATA_PORTAL_URL must be
 * set`, `src/utils/api.ts` throws `DATA_PORTAL_URL is not configured`, and
 * `CLAUDE.md` documents the variable as required. Removing it would change
 * bring-up behaviour — tool calls that silently work today would start
 * throwing — so it is named and left in place here rather than dropped as a
 * side effect of a text change. See the phase report on Wave N10 P-S1.
 */
export const FALLBACK_PORTAL_URL = 'https://data.cityofnewyork.us';

/**
 * The bare host of the configured portal, e.g. `data.cityofchicago.org`.
 * Every default `domain` a handler uses, and every advertised string that names
 * the portal, resolves through this function.
 */
export function getDefaultDomain(): string {
  const url = process.env.DATA_PORTAL_URL || FALLBACK_PORTAL_URL;
  return url.replace(/^https?:\/\//, '');
}
