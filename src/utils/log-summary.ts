/**
 * A result as one log line: its size and shape, never its content (#77).
 *
 * Every result used to be logged whole and pretty-printed, twice for a tool call (the handler's
 * own line in src/index.ts and the wrapper around every request handler), so a large answer cost
 * its size again in the log, and a portal's records went to the log with it. What a reader of the
 * log needs is how big the answer was: `rows=… columns=… bytes=…` for rows, `content=… bytes=…`
 * for a tool result's content items, and `bytes=…` for anything else. A portal request that ran
 * past its time is logged the same way (`summarizeRequest`).
 *
 * A request is logged by the same rule (#81): a tool call by its tool, portal, dataset and the
 * length of each text argument (`summarizeCall`), a protocol message by its method, id and size
 * (`summarizeMessage`), and an error by its class and codes (`summarizeError`). A reader's
 * question reaches a request as text in `where`, `$q`, `select` or a prompt's arguments, and a
 * portal's refusal of a query quotes the query back, so none of that text is written to the log.
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

/** A name the log may show as it is: a parameter, method or tool name, never free text. */
const NAME = /^[A-Za-z_$][\w$./-]{0,63}$/;
const HOST = /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/i;
const NUMBER_TEXT = /^\d{1,15}$/;
/** Arguments whose value is one of a fixed set; any other value is logged by its length. */
const FIXED_VALUES: Record<string, readonly string[]> = {
  type: ['catalog', 'metadata', 'query', 'metrics'],
  modality: ['web', 'local']
};
/** Arguments logged as a number (#81: `limit` and `offset`), or `limit=all`. */
const NUMBER_ARGS = new Set(['limit', 'offset']);

function nameOf(key: string): string {
  return NAME.test(key) ? key : `{name}:${key.length}`;
}

/** A name a client supplied (a prompt's or tool's), as it is when name-shaped, else by its length. */
export function logName(name: unknown): string {
  return typeof name === 'string' ? nameOf(name) : `{name}:${typeof name}`;
}

function hostOf(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const bare = value.trim().replace(/^https?:\/\//i, '').replace(/\/+$/, '');
  return HOST.test(bare) ? bare.toLowerCase() : undefined;
}

function argPart(key: string, value: unknown): string {
  const name = nameOf(key);
  if (typeof value === 'number' && Number.isFinite(value)) return `${name}=${value}`;
  if (typeof value === 'boolean') return `${name}=${value}`;
  if (typeof value === 'string') {
    if (NUMBER_ARGS.has(key) && (NUMBER_TEXT.test(value) || value === 'all')) return `${name}=${value}`;
    if (FIXED_VALUES[key]?.includes(value)) return `${name}=${value}`;
    return `${name}:${value.length}`;
  }
  if (value === null || value === undefined) return `${name}:none`;
  return `${name}:${Array.isArray(value) ? 'array' : typeof value}`;
}

/**
 * Arguments as `name:length` for text and `name=value` for a number, a boolean or a value from a
 * fixed set (`type`, `modality`). Never an argument's text.
 */
export function summarizeArgs(args: unknown): string {
  if (args === undefined || args === null) return 'none';
  if (typeof args !== 'object' || Array.isArray(args)) return `{args}:${Array.isArray(args) ? 'array' : typeof args}`;
  const entries = Object.entries(args as Record<string, unknown>);
  return entries.length > 0 ? entries.map(([key, value]) => argPart(key, value)).join(',') : 'none';
}

/**
 * A tool call as one log line: the tool, the portal host, the dataset id when it has the
 * four-by-four form, and its arguments by `summarizeArgs`. The portal is the one the call names
 * (`domain`, `portal`, or the host inside a `fetch` id); a call that names none shows the
 * configured default, given as `defaultPortal`, or `none`.
 */
export function summarizeCall(tool: unknown, args: unknown, defaultPortal?: string): string {
  const parts = [`tool=${logName(tool)}`];
  const record = args && typeof args === 'object' && !Array.isArray(args) ? (args as Record<string, unknown>) : {};

  let portal = hostOf(record.domain) ?? hostOf(record.portal);
  let dataset = typeof record.dataset_id === 'string' && DATASET_ID.test(record.dataset_id.trim()) ? record.dataset_id.trim() : undefined;
  if (typeof record.id === 'string') {
    for (const segment of record.id.trim().split(/[:/]/)) {
      portal ??= hostOf(segment);
      if (!dataset && DATASET_ID.test(segment)) dataset = segment;
    }
  }
  parts.push(`portal=${portal ?? hostOf(defaultPortal) ?? 'none'}`);
  if (dataset) parts.push(`dataset=${dataset.toLowerCase()}`);
  parts.push(`args=${summarizeArgs(args)}`);
  return parts.join(' ');
}

/** A JSON-RPC id as a log field: a number as it is, a string by its length unless it is name-shaped. */
function idOf(id: unknown): string {
  if (typeof id === 'number' && Number.isFinite(id)) return `${id}`;
  if (typeof id === 'string') return /^[\w-]{1,64}$/.test(id) ? id : `{id}:${id.length}`;
  return 'none';
}

function messagePart(message: unknown): string {
  if (!message || typeof message !== 'object' || Array.isArray(message)) return `{message}:${Array.isArray(message) ? 'array' : typeof message}`;
  const m = message as { method?: unknown; id?: unknown; result?: unknown; error?: { code?: unknown } };
  const parts: string[] = [];
  if (typeof m.method === 'string') parts.push(`method=${nameOf(m.method)}`);
  if ('id' in m) parts.push(`id=${idOf(m.id)}`);
  if ('result' in m) parts.push('result');
  if (m.error && typeof m.error === 'object') {
    parts.push(typeof m.error.code === 'number' ? `error=${m.error.code}` : 'error');
  }
  return parts.length > 0 ? parts.join(' ') : '{message}:object';
}

/**
 * A JSON-RPC message (or a batch of them) as one log line: method, id, whether it is a result or
 * an error and the error's code, and its size. Accepts the message parsed or as the text it
 * arrived in; text that does not parse is logged by its size alone.
 */
export function summarizeMessage(message: unknown): string {
  let parsed = message;
  let bytes: number | undefined;
  if (typeof message === 'string' || Buffer.isBuffer(message)) {
    const text = message.toString();
    bytes = Buffer.byteLength(text);
    try {
      parsed = JSON.parse(text);
    } catch {
      return `unparsed bytes=${bytes}`;
    }
  }
  if (bytes === undefined) {
    const serialized = JSON.stringify(parsed);
    bytes = serialized === undefined ? 0 : Buffer.byteLength(serialized);
  }
  const body = Array.isArray(parsed) ? `batch=${parsed.length} ${parsed.map(messagePart).join('; ')}` : messagePart(parsed);
  return `${body} bytes=${bytes}`;
}

const ERROR_CODE = /^[A-Z][A-Z0-9_]{1,63}$/;

type ErrorFields = { code?: unknown; status?: unknown; response?: { status?: unknown }; cause?: unknown };

function classOf(error: object): string {
  const name = (error as { constructor?: { name?: unknown } }).constructor?.name;
  return typeof name === 'string' && NAME.test(name) ? name : 'Error';
}

/**
 * The first stack frame, read from below the end of the message in the stack's header, so no part
 * of the message is ever taken for a frame. A stack whose header does not hold the message as it
 * now reads (a message changed after the error was made) gives no frame.
 */
function firstFrame(error: Error): string | undefined {
  const stack = error.stack;
  if (typeof stack !== 'string') return undefined;
  let below: string;
  if (error.message === '') {
    const newline = stack.indexOf('\n');
    below = newline < 0 ? '' : stack.slice(newline);
  } else {
    const at = stack.indexOf(error.message);
    if (at < 0 || at > 200) return undefined;
    below = stack.slice(at + error.message.length);
  }
  const frame = below.split('\n').find((line) => /^\s+at /.test(line));
  return frame?.trim().replace(/^at /, '').replace(/\s+/g, ' ');
}

/**
 * An error as one log line, for an operator to diagnose without its text (#81): its class, the
 * MCP (JSON-RPC) code, the portal's HTTP status, Node's or axios's error code (`ECONNRESET`,
 * `ETIMEDOUT`, `ERR_BAD_REQUEST`), the message's length, and where it was thrown. A wrapped
 * error's `cause` supplies the status and code the wrapper lacks and is named by its class.
 * Never the message: a portal's refusal of a query quotes the query back, and src/utils/api.ts
 * carries that answer in the message it throws.
 */
export function summarizeError(error: unknown): string {
  if (!(error instanceof Error)) {
    return `class=${typeof error}${typeof error === 'string' ? ` message_chars=${error.length}` : ''}`;
  }
  const chain: Array<Error & ErrorFields> = [error];
  const cause = (error as ErrorFields).cause;
  if (cause instanceof Error) chain.push(cause as Error & ErrorFields);

  const parts = [`class=${classOf(error)}`];
  const mcpCode = chain.map((e) => e.code).find((c) => typeof c === 'number' && Number.isSafeInteger(c));
  if (mcpCode !== undefined) parts.push(`mcp_code=${mcpCode}`);
  const status = chain
    .map((e) => (typeof e.response?.status === 'number' ? e.response.status : e.status))
    .find((s) => typeof s === 'number');
  if (status !== undefined) parts.push(`status=${status}`);
  const code = chain.map((e) => e.code).find((c) => typeof c === 'string' && ERROR_CODE.test(c));
  if (code !== undefined) parts.push(`code=${code}`);
  parts.push(`message_chars=${error.message.length}`);
  if (chain.length > 1) parts.push(`cause=${classOf(chain[1])}`);
  const at = firstFrame(error);
  if (at) parts.push(`at=${at}`);
  return parts.join(' ');
}

/** Zod issues as `path:code` pairs. Never a message: an enum's message quotes the value it was given. */
export function summarizeZodIssues(issues: ReadonlyArray<{ path: ReadonlyArray<PropertyKey>; code: string }>): string {
  if (issues.length === 0) return 'none';
  return issues
    .map((issue) => {
      const path = issue.path.map((p) => (typeof p === 'number' ? `${p}` : nameOf(String(p)))).join('.') || '{root}';
      return `${path}:${issue.code}`;
    })
    .join(',');
}
