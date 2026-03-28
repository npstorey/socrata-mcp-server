import axios, { AxiosError, AxiosRequestConfig, AxiosResponse } from 'axios';

// Get configured data portal URL from environment
const DATA_PORTAL_URL = process.env.DATA_PORTAL_URL ?? '';
const DEFAULT_BASE_URL: string = DATA_PORTAL_URL;
const SOCRATA_APP_TOKEN = process.env.SOCRATA_APP_TOKEN ?? '';

const DATASET_PATH_REGEX = /\/resource\/(\w{4}-\w{4})\.json$/i;
const DATASET_ID_REGEX = /(\w{4}-\w{4})/i;
const PAGE_SIZE_LIMIT = 50000;

// Request timeout and retry configuration
const REQUEST_TIMEOUT_MS = 30_000; // 30 seconds
const MAX_RETRIES = 3;
const INITIAL_BACKOFF_MS = 1_000; // 1 second, doubles each retry
const RETRYABLE_STATUS_CODES = [429, 503, 502, 504];

/**
 * Execute an axios request with timeout, and retry on transient failures.
 * Uses exponential backoff with jitter for 429/5xx responses.
 */
async function requestWithRetry<T>(config: AxiosRequestConfig): Promise<AxiosResponse<T>> {
  let lastError: Error | undefined;

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    try {
      return await axios({ ...config, timeout: REQUEST_TIMEOUT_MS });
    } catch (e: unknown) {
      lastError = e instanceof Error ? e : new Error(String(e));

      if (attempt === MAX_RETRIES) break;

      // Only retry on retryable status codes or network timeouts
      const shouldRetry =
        (axios.isAxiosError(e) && e.response && RETRYABLE_STATUS_CODES.includes(e.response.status)) ||
        (axios.isAxiosError(e) && e.code === 'ECONNABORTED');

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

      await new Promise(resolve => setTimeout(resolve, waitMs));
    }
  }

  throw lastError!;
}

function buildSoda3Url(datasetId: string, baseUrl: string = DEFAULT_BASE_URL): string {
  if (!baseUrl) {
    throw new Error('DATA_PORTAL_URL is not configured');
  }
  const trimmedBase = baseUrl.endsWith('/') ? baseUrl.slice(0, -1) : baseUrl;
  return `${trimmedBase}/api/v3/views/${datasetId}/query.json`;
}

function buildTokenHeader(): Record<string, string> {
  return SOCRATA_APP_TOKEN ? { 'X-App-Token': SOCRATA_APP_TOKEN } : {};
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
 * Helper function to make API requests to Socrata SODA3 endpoints
 */
export async function fetchFromSocrataApi<T>(path: string, params: Record<string, unknown> = {}, baseUrl = DEFAULT_BASE_URL): Promise<T> {
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
        headers: {
          ...tokenHeader,
          'Content-Type': 'application/json'
        }
      });
      return response.data;
    }

    if (!baseUrl) {
      throw new Error('DATA_PORTAL_URL is not configured');
    }

    const trimmedBase = baseUrl.endsWith('/') ? baseUrl.slice(0, -1) : baseUrl;
    const url = `${trimmedBase}${path}`;

    const response = await requestWithRetry<T>({
      method: 'get',
      url,
      params,
      headers: tokenHeader
    });
    return response.data;
  } catch (e: unknown) {
    if (axios.isAxiosError(e)) {
      const axiosError = e as AxiosError;

      if (axiosError.code === 'ECONNABORTED') {
        throw new Error(
          `API request timed out after ${REQUEST_TIMEOUT_MS / 1000}s (retried ${MAX_RETRIES} times). The data portal may be under heavy load.`
        );
      }

      if (axiosError.response) {
        const status = axiosError.response.status;
        if (status === 429) {
          throw new Error(
            `Rate limited by the data portal (HTTP 429) after ${MAX_RETRIES} retries. Too many requests — try again in a minute.`
          );
        }
        throw new Error(
          `API request failed: ${status} - ${axiosError.response.statusText}\nData: ${JSON.stringify(axiosError.response.data)}`
        );
      } else if (axiosError.request) {
        throw new Error(
          `API request failed: No response received (retried ${MAX_RETRIES} times). Message: ${axiosError.message}`
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
