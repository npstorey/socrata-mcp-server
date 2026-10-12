/**
 * A result as one log line: its size and shape, never its content (#77).
 *
 * Every result used to be logged whole and pretty-printed, twice for a tool call (the handler's
 * own line in src/index.ts and the wrapper around every request handler), so a large answer cost
 * its size again in the log, and a portal's records went to the log with it. What a reader of the
 * log needs is how big the answer was: `rows=… columns=… bytes=…` for rows, `content=… bytes=…`
 * for a tool result's content items, and `bytes=…` for anything else. A portal request that ran
 * past its time is logged the same way (`summarizeRequest`).
 */

type ContentItem = { text?: unknown };

function rowsOf(result: unknown): unknown[] | undefined {
  if (Array.isArray(result)) return result;
  if (result && typeof result === 'object') {
    const data = (result as { data?: unknown }).data;
    if (Array.isArray(data)) return data;
  }
  return undefined;
}

function contentOf(result: unknown): ContentItem[] | undefined {
  if (result && typeof result === 'object' && !Array.isArray(result)) {
    const content = (result as { content?: unknown }).content;
    if (Array.isArray(content)) return content as ContentItem[];
  }
  return undefined;
}

/** Distinct field names across the rows that are objects. */
function columnCount(rows: unknown[]): number {
  const names = new Set<string>();
  for (const row of rows) {
    if (row && typeof row === 'object' && !Array.isArray(row)) {
      for (const name of Object.keys(row)) names.add(name);
    }
  }
  return names.size;
}

function byteCount(result: unknown, text: string | undefined, content: ContentItem[] | undefined): number {
  if (text !== undefined) return Buffer.byteLength(text);
  if (content) {
    return content.reduce((total, item) => total + (typeof item?.text === 'string' ? Buffer.byteLength(item.text) : 0), 0);
  }
  const serialized = JSON.stringify(result);
  return serialized === undefined ? 0 : Buffer.byteLength(serialized);
}

/**
 * `text`, when given, is the text the result is sent as, and its bytes are the ones counted.
 * Without it, a tool result's bytes are its content items' text, and anything else is measured
 * as JSON.
 */
export function summarizeResult(result: unknown, text?: string): string {
  const parts: string[] = [];
  const rows = rowsOf(result);
  if (rows) parts.push(`rows=${rows.length}`, `columns=${columnCount(rows)}`);
  const content = rows ? undefined : contentOf(result);
  if (content) parts.push(`content=${content.length}`);
  parts.push(`bytes=${byteCount(result, text, content)}`);
  return parts.join(' ');
}

/**
 * A portal request as one log line, by the same rule: where it went and its shape, never its text
 * (#79). A clause can carry a reader's words (a `$q` phrase, a `where` on an address or a name),
 * so each parameter is logged as its name and its length in characters, and only a number
 * (`limit`, `offset`) as its value. The portal's host and a dataset id are public identifiers.
 * `dataset_id` reaches a request path unchecked, so a path segment outside the fixed words of the
 * Socrata API is shown as `{id}`, and `dataset=` appears only for a segment shaped like an id.
 */
const PATH_WORDS = new Set(['api', 'v1', 'v3', 'views', 'catalog', 'columns', 'resource', 'query.json', 'domain_categories', 'domain_tags']);
const DATASET_ID = /^\w{4}-\w{4}$/;

export function summarizeRequest(url: string, params: Record<string, unknown> = {}): string {
  const { host, pathname } = new URL(url);
  const segments = pathname.split('/');
  const parts = [`portal=${host}`, `endpoint=${segments.map((s) => (s === '' || PATH_WORDS.has(s) ? s : '{id}')).join('/')}`];
  const dataset = segments.map((s) => s.replace(/\.json$/, '')).find((s) => DATASET_ID.test(s));
  if (dataset) parts.push(`dataset=${dataset}`);

  const clauses: string[] = [];
  const numbers: string[] = [];
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === null) continue;
    const name = key.replace(/^\$/, '');
    if (typeof value === 'number') numbers.push(`${name}=${value}`);
    else clauses.push(`${name}:${String(value).length}`);
  }
  parts.push(`clauses=${clauses.length > 0 ? clauses.join(',') : 'none'}`, ...numbers);
  return parts.join(' ');
}
