import axios, { AxiosError, AxiosRequestConfig, AxiosResponse } from 'axios';
import { McpError, ErrorCode } from './mcp-errors.js';
import { allowanceMs, callBudget, timeBounds, type CallBudget } from './call-budget.js';
import { summarizeRequest } from './log-summary.js';

// No default portal lives here. Every request names the portal of the call it serves: callers
// pass `baseUrl`, built from the domain their own call resolved (src/utils/portal-config.ts).
// This module used to snapshot DATA_PORTAL_URL at load as a fallback base URL — a second
// default-portal layer, read before src/index.ts had run dotenv.config() (server#63).
const MISSING_BASE_URL =
  'No portal base URL was given for this request; the caller must pass the base URL of the portal its call names.';

const DATASET_PATH_REGEX = /\/resource\/(\w{4}-\w{4})\.json$/i;
const DATASET_ID_REGEX = /(\w{4}-\w{4})/i;
const PAGE_SIZE_LIMIT = 50000;

// Retry configuration. How long a request and a tool call may take is in ./call-budget.ts (#79).
const MAX_RETRIES = 3;
const INITIAL_BACKOFF_MS = 1_000; // 1 second, doubles each retry
const RETRYABLE_STATUS_CODES = [429, 503, 502, 504];

// Bounds on one portal exchange (#77). Axios leaves both unbounded by default, so an answer was
// read into memory whatever its size: #75's redirect fetched a whole dataset (near 880 MB) and
// the hosted server restarted. 32 MiB holds 10,000 rows of the widest dataset measured (San
// Francisco's 311 cases at 1.77 KB a row, about 17.7 MB) with room to spare, and stops a
// whole-dataset answer early. A request body is a SoQL query; 1 MiB is far beyond a real one.
export const MAX_RESPONSE_BYTES = 32 * 1024 * 1024;
export const MAX_REQUEST_BYTES = 1024 * 1024;

// What axios 1.9.0 rejects with when a bound is passed (lib/adapters/http.js:339-341 and
// :556-563). Neither has an error code of its own, so the message is what identifies it.
const RESPONSE_TOO_LARGE = /maxContentLength size of \d+ exceeded/;
const REQUEST_TOO_LARGE = /Request body larger than maxBodyLength limit/;

function mebibytes(bytes: number): string {
  return `${bytes / (1024 * 1024)} MiB`;
}

function responseTooLarge(): McpError {
  return new McpError(
    ErrorCode.InvalidParams,
    `The portal's answer to this request passed ${mebibytes(MAX_RESPONSE_BYTES)}, this server's bound on one response, so it was stopped and nothing from it is returned. Ask for less: a lower limit, fewer columns (select), a narrower where, or an aggregate (group).`
  );
}

function requestTooLarge(): McpError {
  return new McpError(
    ErrorCode.InvalidParams,
    `This request's body is larger than ${mebibytes(MAX_REQUEST_BYTES)}, this server's bound on one request, so it was not sent. Shorten the query.`
  );
}

/**
 * The answer to a request that ran past its time (#79): a refusal that says the portal took too
 * long and how to ask for less, and one log line with the request's shape (`summarizeRequest`).
 * The request is not sent again: a query that ran 30 s runs as long the next time, and the old
 * retries held a call for about two minutes while the portal ran the same query four times.
 *
 * The refusal avoids the words the website's failure classifier reads as a timeout. The website
 * shows the model a category, not this text (civic-ai-tools-website src/lib/streaming.ts,
 * `describeToolFailureForLlm`): a timeout tells the model to report that the data could not be
 * retrieved, while a refusal tells it to make a differently formed request, which is what a
 * narrower query is. Other clients show the model this text.
 */
function tookTooLong(url: string, params: Record<string, unknown>, budget: CallBudget, waitedMs: number, allowedMs: number): McpError {
  const callMs = Date.now() - budget.start;
  console.error(`[Portal] Took too long: ${summarizeRequest(url, params)} waited_ms=${waitedMs} allowed_ms=${allowedMs} call_ms=${callMs}`);
  return new McpError(
    ErrorCode.InvalidParams,
    `The portal ${new URL(url).host} took too long to answer this request: this server waited ${Math.round(callMs / 1000)} s for it and stopped, and did not send it again, so nothing from it is returned. A narrower request may answer: a shorter date range in where, an aggregate (group with count(*)) instead of rows, fewer columns (select), or a smaller limit.`
  );
}

/** Axios's `timeout` (silence) rejects with ECONNABORTED; the signal (total time) with ERR_CANCELED. */
function ranPastItsTime(e: unknown): boolean {
  return axios.isAxiosError(e) && (e.code === AxiosError.ECONNABORTED || e.code === AxiosError.ERR_CANCELED);
}

/**
 * Execute an axios request within its call's time (./call-budget.ts), and retry on transient
 * failures. Uses exponential backoff with jitter for 429/5xx responses. `params` are the request's
 * own, for the log line when it runs past its time.
 */
async function requestWithRetry<T>(config: AxiosRequestConfig, params: Record<string, unknown>): Promise<AxiosResponse<T>> {
  const budget = callBudget();
  let lastError: Error | undefined;

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    const allowedMs = allowanceMs(budget);
    if (allowedMs <= 0) {
      if (lastError) break;
      throw tookTooLong(config.url!, params, budget, 0, 0);
    }
    const sentAt = Date.now();
    try {
      return await axios({
        ...config,
        ...timeBounds(allowedMs),
        maxContentLength: MAX_RESPONSE_BYTES,
        maxBodyLength: MAX_REQUEST_BYTES
      });
    } catch (e: unknown) {
      if (ranPastItsTime(e)) {
        throw tookTooLong(config.url!, params, budget, Date.now() - sentAt, allowedMs);
      }
      lastError = e instanceof Error ? e : new Error(String(e));

      if (attempt === MAX_RETRIES) break;

      // Only retry on retryable status codes
      const shouldRetry = axios.isAxiosError(e) && e.response && RETRYABLE_STATUS_CODES.includes(e.response.status);

      if (!shouldRetry) break;

      // Exponential backoff with jitter
      const backoff = INITIAL_BACKOFF_MS * Math.pow(2, attempt);

      // For 429, respect Retry-After header if present
      let waitMs = backoff;
      if (axios.isAxiosError(e) && e.response?.status === 429) {
        const retryAfter = e.response.headers['retry-after'];
        if (retryAfter) {
          const retrySeconds = parseInt(retryAfter, 10);
          if (!isNaN(retrySeconds)) {
            waitMs = Math.max(retrySeconds * 1000, backoff);
          }
        }
      }

      // Add jitter (0-25% of wait time)
      waitMs += Math.random() * waitMs * 0.25;

      // A retry is made only when its wait ends inside the call's time.
      if (Date.now() + waitMs >= budget.deadline) break;

      await new Promise(resolve => setTimeout(resolve, waitMs));
    }
  }

  throw lastError!;
}

function buildSoda3Url(datasetId: string, baseUrl: string): string {
  if (!baseUrl) {
    throw new Error(MISSING_BASE_URL);
  }
  const trimmedBase = baseUrl.endsWith('/') ? baseUrl.slice(0, -1) : baseUrl;
  return `${trimmedBase}/api/v3/views/${datasetId}/query.json`;
}

/**
 * The answer to a request a portal redirected and this server did not follow (#75): a refusal
 * naming where the portal points. A portal that has moved, as San Francisco's did from
 * data.sfgov.org to data.sf.gov, is then one call away. The new host is read from the portal's
 * own `Location` header, never from a list in this source.
 */
function redirectRefusal(response: AxiosResponse, requestUrl: string): McpError {
  const from = new URL(requestUrl).host;
  const answered = response.statusText ? `${response.status} ${response.statusText}` : `${response.status}`;
  const location = response.headers?.['location'];
  let to: string | undefined;
  if (typeof location === 'string' && location.length > 0) {
    try {
      to = new URL(location, requestUrl).host;
    } catch {
      to = undefined;
    }
  }
  if (to && to !== from) {
    return new McpError(
      ErrorCode.InvalidParams,
      `The portal ${from} answered this request with ${answered}, pointing to ${to}. This server does not follow a redirect on a data query; call again with domain "${to}".`
    );
  }
  return new McpError(
    ErrorCode.InvalidParams,
    `The portal ${from} answered this request with ${answered}${location ? `, pointing to ${location}` : ''}. This server does not follow a redirect on a data query.`
  );
}

// Read per request, not at import: src/index.ts loads .env (dotenv.config()) after every module
// has been imported, so a token read at import missed one set in .env.
function buildTokenHeader(): Record<string, string> {
  const token = process.env.SOCRATA_APP_TOKEN ?? '';
  return token ? { 'X-App-Token': token } : {};
}

function isDatasetPath(path: string): boolean {
  return DATASET_PATH_REGEX.test(path);
}

function extractDatasetId(path: string): string {
  const match = path.match(DATASET_ID_REGEX);
  if (!match) {
    throw new Error(`Unable to determine dataset identifier from path: ${path}`);
  }
  return match[1].toLowerCase();
}

function buildSoda3Payload(params: Record<string, unknown>): Record<string, unknown> {
  const payload: Record<string, unknown> = {};

  const sql = buildSoda3QueryString(params);
  if (sql) {
    payload.query = sql;
  }

  if (params.$limit !== undefined || params.$offset !== undefined) {
    payload.page = {
      pageSize: clampPageSize(params.$limit),
      pageNumber: calculatePageNumber(params.$offset, params.$limit)
    };
  }

  if (typeof params.format === 'string' && params.format.trim().length > 0) {
    payload.format = params.format.trim();
  }

  return payload;
}

function buildSoda3QueryString(params: Record<string, unknown>): string {
  if (typeof params.$query === 'string' && params.$query.trim().length > 0) {
    return params.$query.trim();
  }

  const selectClause = typeof params.$select === 'string' && params.$select.trim().length > 0 ? params.$select.trim() : '*';
  let sql = `SELECT ${selectClause}`;

  if (typeof params.$where === 'string' && params.$where.trim().length > 0) {
    sql += ` WHERE ${params.$where.trim()}`;
  }

  if (typeof params.$group === 'string' && params.$group.trim().length > 0) {
    sql += ` GROUP BY ${params.$group.trim()}`;
  }

  if (typeof params.$having === 'string' && params.$having.trim().length > 0) {
    sql += ` HAVING ${params.$having.trim()}`;
  }

  if (typeof params.$order === 'string' && params.$order.trim().length > 0) {
    sql += ` ORDER BY ${params.$order.trim()}`;
  }

  if (isFiniteNumber(params.$limit)) {
    sql += ` LIMIT ${params.$limit}`;
  }

  if (isFiniteNumber(params.$offset)) {
    sql += ` OFFSET ${params.$offset}`;
  }

  return sql;
}

function clampPageSize(limit: unknown): number {
  if (!isFiniteNumber(limit)) {
    return PAGE_SIZE_LIMIT;
  }
  return Math.min(Math.max(Math.trunc(limit), 1), PAGE_SIZE_LIMIT);
}

function calculatePageNumber(offset: unknown, limit: unknown): number {
  if (!isFiniteNumber(offset) || !isFiniteNumber(limit) || limit === 0) {
    return 1;
  }
  return Math.floor(Math.trunc(offset) / Math.trunc(limit)) + 1;
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

/**
 * Helper function to make API requests to Socrata SODA3 endpoints.
 *
 * `baseUrl` is required and has no default: it is the portal of the call being served. A call
 * without one throws here, before any request, and never falls back to the environment.
 */
export async function fetchFromSocrataApi<T>(path: string, params: Record<string, unknown> = {}, baseUrl: string): Promise<T> {
  if (!baseUrl) {
    throw new Error(MISSING_BASE_URL);
  }

  try {
    const tokenHeader = buildTokenHeader();

    if (isDatasetPath(path)) {
      const datasetId = extractDatasetId(path);
      const url = buildSoda3Url(datasetId, baseUrl);
      const payload = buildSoda3Payload(params);

      const response = await requestWithRetry<T>({
        method: 'post',
        url,
        data: payload,
        // Never follow a redirect on a data query (#75). Axios follows through follow-redirects,
        // which re-sends a POST answered 301 or 302 as a GET without its body, and on this
        // endpoint that GET asks for the whole dataset. A redirect is refused instead, naming
        // where the portal points (`redirectRefusal`). The GET paths below still follow.
        maxRedirects: 0,
        headers: {
          ...tokenHeader,
          'Content-Type': 'application/json'
        }
      }, params);
      return response.data;
    }

    const trimmedBase = baseUrl.endsWith('/') ? baseUrl.slice(0, -1) : baseUrl;
    const url = `${trimmedBase}${path}`;

    const response = await requestWithRetry<T>({
      method: 'get',
      url,
      params,
      headers: tokenHeader
    }, params);
    return response.data;
  } catch (e: unknown) {
    // A refusal made on the way (a request that ran past its time) goes out as it is.
    if (e instanceof McpError) {
      throw e;
    }
    if (axios.isAxiosError(e)) {
      const axiosError = e as AxiosError;

      if (RESPONSE_TOO_LARGE.test(axiosError.message)) {
        throw responseTooLarge();
      }
      if (REQUEST_TOO_LARGE.test(axiosError.message)) {
        throw requestTooLarge();
      }

      if (axiosError.response) {
        const status = axiosError.response.status;
        if (status >= 300 && status < 400) {
          throw redirectRefusal(axiosError.response, axiosError.config?.url ?? baseUrl);
        }
        if (status === 429) {
          throw new Error(
            `Rate limited by the data portal (HTTP 429). Too many requests — try again in a minute.`
          );
        }
        throw new Error(
          `API request failed: ${status} - ${axiosError.response.statusText}\nData: ${JSON.stringify(axiosError.response.data)}`
        );
      } else if (axiosError.request) {
        throw new Error(
          `API request failed: No response received. Message: ${axiosError.message}`
        );
      } else {
        throw new Error(
          `API request setup failed: ${axiosError.message}`
        );
      }
    }
    if (e instanceof Error) {
        throw new Error(`An unexpected error occurred: ${e.message}`);
    }
    throw new Error(`An unexpected and unknown error occurred: ${String(e)}`);
  }
}

/**
 * Common types for Socrata API responses
 */

// Dataset metadata in catalog listings
export interface DatasetMetadata {
  id: string;
  name: string;
  description?: string;
  datasetType?: string;
  category?: string;
  tags?: string[];
  createdAt?: string;
  updatedAt?: string;
  [key: string]: unknown;
}

// Category information
export interface CategoryInfo {
  name: string;
  count: number;
}

// Tag information
export interface TagInfo {
  name: string;
  count: number;
}

// Column information
export interface ColumnInfo {
  name: string;
  dataTypeName: string;
  description?: string;
  fieldName: string;
  [key: string]: unknown;
}

// Portal metrics
export interface PortalMetrics {
  datasets: number;
  views: number;
  downloads?: number;
  apiCalls?: number;
  [key: string]: unknown;
}
