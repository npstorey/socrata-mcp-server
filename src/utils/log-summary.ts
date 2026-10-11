/**
 * A result as one log line: its size and shape, never its content (#77).
 *
 * Every result used to be logged whole and pretty-printed, twice for a tool call (the handler's
 * own line in src/index.ts and the wrapper around every request handler), so a large answer cost
 * its size again in the log, and a portal's records went to the log with it. What a reader of the
 * log needs is how big the answer was: `rows=… columns=… bytes=…` for rows, `content=… bytes=…`
 * for a tool result's content items, and `bytes=…` for anything else.
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
