import { fetchFromSocrataApi } from '../utils/api.js';

// Constants for Socrata API limits
export const MAX_ROWS = 50000; // Socrata per-request hard limit
export const DEFAULT_PREVIEW_ROWS = 1000; // Default preview size for large datasets
// The most rows one query returns (#77): the cap on `limit`, on "all", and on a non-aggregating
// SoQL query. 10,000 is what the skill guidance tells a model never to exceed in one call. A
// larger `limit` is reduced to it, with a `limit_note`; "all" means every matching row from
// `offset` up to it, with `next_offset` when more remain. "all" used to page through up to
// 100,000 rows (ROW_FETCH_CAP, now retired) into one result. Read per call, not at import:
// src/index.ts loads .env (dotenv.config()) after every module has been imported, so a value read
// at import missed one set in .env.
export function maxRawRows(): number {
  return parseInt(process.env.MAX_RAW_ROWS || '10000', 10);
}

function formatCount(n: number): string {
  return n.toLocaleString('en-US');
}

// Detect whether a SoQL query uses aggregation (GROUP BY or aggregate functions)
const AGGREGATION_PATTERN = /\b(GROUP\s+BY|COUNT\s*\(|SUM\s*\(|AVG\s*\(|MIN\s*\(|MAX\s*\()\b/i;

function isAggregationQuery(soql: string): boolean {
  return AGGREGATION_PATTERN.test(soql);
}

// Parse the LIMIT value from a SoQL query string, returns undefined if no LIMIT clause
function parseSoqlLimit(soql: string): number | undefined {
  const match = soql.match(/\bLIMIT\s+(\d+)/i);
  return match ? parseInt(match[1], 10) : undefined;
}

// Replace or append a LIMIT clause in a SoQL query
function setSoqlLimit(soql: string, limit: number): string {
  if (/\bLIMIT\s+\d+/i.test(soql)) {
    return soql.replace(/\bLIMIT\s+\d+/i, `LIMIT ${limit}`);
  }
  return `${soql.trimEnd()} LIMIT ${limit}`;
}

// Clamp a raw (non-aggregation) SoQL query's LIMIT to the cap (maxRawRows).
// Returns { query, clamped } where clamped is true if the limit was reduced or added.
function clampRawQueryLimit(soql: string, cap: number): { query: string; clamped: boolean; originalLimit?: number } {
  if (isAggregationQuery(soql)) {
    return { query: soql, clamped: false };
  }

  const existingLimit = parseSoqlLimit(soql);

  if (existingLimit === undefined) {
    // No LIMIT on a raw query — add safety default
    return { query: setSoqlLimit(soql, cap), clamped: true };
  }

  if (existingLimit > cap) {
    return { query: setSoqlLimit(soql, cap), clamped: true, originalLimit: existingLimit };
  }

  return { query: soql, clamped: false };
}

// Response type with metadata
export interface SearchResponse {
  data: any[];
  is_sample: boolean;
  returned_rows: number;
  total_rows: number;
  has_more?: boolean;
  next_offset?: number;
  limit_note?: string;
}

// Helper function to get total row count for a dataset
export async function getRowCount(params: {
  datasetId: string;
  domain: string;
  where?: string;
  q?: string;
}): Promise<number> {
  const { datasetId, domain, where, q } = params;
  
  const apiParams: Record<string, unknown> = {
    $select: 'count(*)',
    $limit: 1
  };
  
  if (where) apiParams.$where = where;
  if (q) apiParams.$q = q;
  
  const baseUrl = `https://${domain}`;
  const response = await fetchFromSocrataApi<Array<{ count: string }>>(
    `/resource/${datasetId}.json`,
    apiParams,
    baseUrl
  );
  
  return parseInt(response[0]?.count || '0', 10);
}

// Enhanced search handler with pagination and metadata
export async function handleSearch(params: {
  datasetId: string;
  domain: string;
  soqlQuery?: string;
  limit?: number | 'all';
  offset?: number;
  select?: string;
  where?: string;
  order?: string;
  group?: string;
  having?: string;
  q?: string;
}): Promise<SearchResponse> {
  const {
    datasetId,
    domain,
    soqlQuery,
    limit,
    offset = 0,
    select,
    where,
    order,
    group,
    having,
    q
  } = params;
  const MAX_RAW_ROWS = maxRawRows();

  // If a full SoQL query is provided, we can't easily determine row count
  // So we'll fetch with the query and check results
  if (soqlQuery && soqlQuery.trim().length > 0) {
    // Clamp raw (non-aggregation) queries to MAX_RAW_ROWS
    const { query: clampedQuery, clamped, originalLimit } = clampRawQueryLimit(soqlQuery, MAX_RAW_ROWS);

    const apiParams: Record<string, unknown> = {
      $query: clampedQuery
    };

    const baseUrl = `https://${domain}`;
    const data = await fetchFromSocrataApi<Record<string, unknown>[]>(
      `/resource/${datasetId}.json`,
      apiParams,
      baseUrl
    );

    const result: SearchResponse = {
      data,
      is_sample: false,
      returned_rows: data.length,
      total_rows: data.length, // Can't determine total with custom query
      has_more: data.length === MAX_ROWS // Might have more if we hit the limit
    };

    if (clamped) {
      (result as any).limit_note = originalLimit
        ? `Results limited to ${formatCount(MAX_RAW_ROWS)} rows (requested ${formatCount(originalLimit)}). Use aggregation (GROUP BY) to analyze the full dataset.`
        : `Results limited to ${formatCount(MAX_RAW_ROWS)} rows (safety default). Use aggregation (GROUP BY) to analyze the full dataset, or add an explicit LIMIT if you need fewer rows.`;
    }

    return result;
  }

  // Get total row count first
  const totalRows = await getRowCount({ datasetId, domain, where, q });
  
  // Determine fetch strategy
  const requestAll = limit === 'all';
  // A limit above the cap is reduced to it, and the result says so when the cap left rows out.
  const userLimit = typeof limit === 'number' ? Math.min(limit, MAX_RAW_ROWS) : undefined;
  const reduced =
    typeof limit === 'number' && limit > MAX_RAW_ROWS && totalRows - offset > MAX_RAW_ROWS
      ? {
          limit_note: `Results limited to ${formatCount(MAX_RAW_ROWS)} rows per call (requested ${formatCount(limit)}). Use aggregation (GROUP BY) to analyze the full dataset, or page with offset.`
        }
      : {};

  // Case 1: Small dataset, or a specific limit, within the cap
  if (totalRows <= MAX_ROWS && !requestAll && (userLimit ?? totalRows) <= MAX_RAW_ROWS) {
    const apiParams: Record<string, unknown> = {
      $limit: userLimit ?? totalRows,
      $offset: offset
    };
    
    if (select) apiParams.$select = select;
    if (where) apiParams.$where = where;
    if (order) apiParams.$order = order;
    if (group) apiParams.$group = group;
    if (having) apiParams.$having = having;
    if (q) apiParams.$q = q;
    
    const baseUrl = `https://${domain}`;
    const data = await fetchFromSocrataApi<Record<string, unknown>[]>(
      `/resource/${datasetId}.json`,
      apiParams,
      baseUrl
    );
    
    return {
      data,
      is_sample: false,
      returned_rows: data.length,
      total_rows: totalRows,
      ...reduced
    };
  }

  // Case 2: User explicitly requested "all" data: every matching row from offset, up to the cap
  if (requestAll) {
    const allData: Record<string, unknown>[] = [];
    let currentOffset = offset;
    const maxToFetch = Math.min(Math.max(totalRows - offset, 0), MAX_RAW_ROWS);

    while (allData.length < maxToFetch) {
      const batchSize = Math.min(MAX_ROWS, maxToFetch - allData.length);
      const apiParams: Record<string, unknown> = {
        $limit: batchSize,
        $offset: currentOffset
      };
      
      if (select) apiParams.$select = select;
      if (where) apiParams.$where = where;
      if (order) apiParams.$order = order;
      if (group) apiParams.$group = group;
      if (having) apiParams.$having = having;
      if (q) apiParams.$q = q;
      
      const baseUrl = `https://${domain}`;
      const batch = await fetchFromSocrataApi<Record<string, unknown>[]>(
        `/resource/${datasetId}.json`,
        apiParams,
        baseUrl
      );
      
      if (batch.length === 0) break; // No more data
      
      allData.push(...batch);
      currentOffset += batch.length;
    }
    
    const hasMore = currentOffset < totalRows;

    return {
      data: allData,
      is_sample: false,
      returned_rows: allData.length,
      total_rows: totalRows,
      has_more: hasMore,
      next_offset: hasMore ? currentOffset : undefined,
      ...(hasMore && allData.length >= MAX_RAW_ROWS
        ? {
            limit_note: `"all" returns at most ${formatCount(MAX_RAW_ROWS)} rows per call; ${formatCount(totalRows - currentOffset)} more match from next_offset. Continue from next_offset, or use aggregation (GROUP BY) to analyze the full dataset.`
          }
        : {})
    };
  }
  
  // Case 3: Large dataset, or no limit on more rows than the cap - return preview
  const previewLimit = userLimit ?? DEFAULT_PREVIEW_ROWS;
  const apiParams: Record<string, unknown> = {
    $limit: Math.min(previewLimit, MAX_ROWS),
    $offset: offset
  };
  
  if (select) apiParams.$select = select;
  if (where) apiParams.$where = where;
  if (order) apiParams.$order = order;
  if (group) apiParams.$group = group;
  if (having) apiParams.$having = having;
  if (q) apiParams.$q = q;
  
  const baseUrl = `https://${domain}`;
  const data = await fetchFromSocrataApi<Record<string, unknown>[]>(
    `/resource/${datasetId}.json`,
    apiParams,
    baseUrl
  );
  
  return {
    data,
    is_sample: true,
    returned_rows: data.length,
    total_rows: totalRows,
    has_more: offset + data.length < totalRows,
    next_offset: offset + data.length < totalRows ? offset + data.length : undefined,
    ...reduced
  };
}