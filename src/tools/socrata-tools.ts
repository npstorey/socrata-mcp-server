import { z } from 'zod';
// import { zodToJsonSchema, type JsonSchema7Type } from 'zod-to-json-schema'; // No longer using zodToJsonSchema
import { type JsonSchema7Type } from 'zod-to-json-schema'; // Keep for typing if manually constructing
import { Tool } from '@modelcontextprotocol/sdk/types.js'; // Suffix needed
import { McpError, ErrorCode } from '../utils/mcp-errors.js';
import {
  fetchFromSocrataApi,
  DatasetMetadata,
  CategoryInfo,
  TagInfo,
  ColumnInfo
} from '../utils/api.js';
import axios from 'axios';
import { handleSearch } from './search.js';
import { retrieveDocuments } from './document-retrieval.js';
// import { McpToolHandlerContext } from '@modelcontextprotocol/sdk/types.js'; // Removed incorrect import

/**
 * The SDK's `Tool` type describes only the wire shape returned by tools/list;
 * it has no handler member. This repo keeps each tool's implementation next to
 * its wire definition, so pair them in a local type (#47). The handler is
 * invoked from src/index.ts and is never included in tools/list responses.
 */
export type ToolWithHandler = Tool & {
  handler: (params: Record<string, unknown>) => Promise<unknown>;
};

// Get the default domain from environment
const getDefaultDomain = () => {
  const url = process.env.DATA_PORTAL_URL || 'https://data.cityofnewyork.us';
  return url.replace(/^https?:\/\//, '');
};

// Handler for catalog functionality
async function handleCatalog(params: {
  query?: string;
  domain?: string;
  limit?: number;
  offset?: number;
}): Promise<DatasetMetadata[]> {
  const { query, domain = getDefaultDomain(), limit = 10, offset = 0 } = params;

  const apiParams: Record<string, unknown> = {
    limit,
    offset,
    search_context: domain // Add search_context parameter with the domain
  };

  if (query) {
    apiParams.q = query;
  }

  const baseUrl = `https://${domain}`;
  const response = await fetchFromSocrataApi<{ results: any[] }>(
    '/api/catalog/v1',
    apiParams,
    baseUrl
  );

  // Map the nested structure to our DatasetMetadata interface
  return response.results.map((result: any) => ({
    id: result.resource?.id || result.id,
    name: result.resource?.name || result.name,
    description: result.resource?.description || result.description,
    datasetType: result.resource?.type || result.type,
    category: result.classification?.domain_category,
    tags: result.classification?.domain_tags || [],
    createdAt: result.resource?.createdAt,
    updatedAt: result.resource?.updatedAt,
    ...result.resource // Include any other fields
  } as DatasetMetadata));
}

// Handler for categories functionality
async function handleCategories(params: {
  domain?: string;
}): Promise<CategoryInfo[]> {
  const { domain = getDefaultDomain() } = params;

  const apiParams: Record<string, unknown> = {
    search_context: domain // Add search_context parameter with the domain
  };

  const baseUrl = `https://${domain}`;

  try {
    // First try the standard domain_categories endpoint
    const response = await fetchFromSocrataApi<CategoryInfo[]>(
      '/api/catalog/v1/domain_categories',
      apiParams,
      baseUrl
    );

    // If we get a valid array response, return it
    if (Array.isArray(response) && response.length > 0) {
      return response;
    }

    // Otherwise, try the alternate approach with only=categories parameter
    const altResponse = await fetchFromSocrataApi<{categories: CategoryInfo[]}>(
      '/api/catalog/v1',
      { ...apiParams, only: 'categories' },
      baseUrl
    );

    return altResponse.categories || [];
  } catch (error) {
    // If the primary endpoint fails, try the alternate approach
    try {
      const altResponse = await fetchFromSocrataApi<{categories: CategoryInfo[]}>(
        '/api/catalog/v1',
        { ...apiParams, only: 'categories' },
        baseUrl
      );

      return altResponse.categories || [];
    } catch {
      // If both approaches fail, rethrow the original error
      throw error;
    }
  }
}

// Handler for tags functionality
async function handleTags(params: {
  domain?: string;
}): Promise<TagInfo[]> {
  const { domain = getDefaultDomain() } = params;

  const apiParams: Record<string, unknown> = {
    search_context: domain // Add search_context parameter with the domain
  };

  const baseUrl = `https://${domain}`;

  try {
    // First try the standard domain_tags endpoint
    const response = await fetchFromSocrataApi<TagInfo[]>(
      '/api/catalog/v1/domain_tags',
      apiParams,
      baseUrl
    );

    // If we get a valid array response, return it
    if (Array.isArray(response) && response.length > 0) {
      return response;
    }

    // Otherwise, try the alternate approach with only=tags parameter
    const altResponse = await fetchFromSocrataApi<{tags: TagInfo[]}>(
      '/api/catalog/v1',
      { ...apiParams, only: 'tags' },
      baseUrl
    );

    return altResponse.tags || [];
  } catch (error) {
    // If the primary endpoint fails, try the alternate approach
    try {
      const altResponse = await fetchFromSocrataApi<{tags: TagInfo[]}>(
        '/api/catalog/v1',
        { ...apiParams, only: 'tags' },
        baseUrl
      );

      return altResponse.tags || [];
    } catch {
      // If both approaches fail, rethrow the original error
      throw error;
    }
  }
}

// Handler for dataset metadata functionality
async function handleDatasetMetadata(params: {
  datasetId: string;
  domain?: string;
}): Promise<Record<string, unknown>> {
  const { datasetId, domain = getDefaultDomain() } = params;

  const baseUrl = `https://${domain}`;
  const response = await fetchFromSocrataApi<Record<string, unknown>>(
    `/api/views/${datasetId}`,
    {},
    baseUrl
  );

  return response;
}

// Handler for column information functionality
async function handleColumnInfo(params: {
  datasetId: string;
  domain?: string;
}): Promise<ColumnInfo[]> {
  const { datasetId, domain = getDefaultDomain() } = params;

  const baseUrl = `https://${domain}`;
  const response = await fetchFromSocrataApi<ColumnInfo[]>(
    `/api/views/${datasetId}/columns`,
    {},
    baseUrl
  );

  return response;
}

// Handler for metrics — derives stats from the metadata endpoint.
// Socrata has no dedicated public metrics API, so we extract useful stats
// from /api/views/{id} (view count, timestamps, etc.) and a COUNT(*) query
// for the actual row count.
async function handleMetrics(params: {
  datasetId: string;
  domain?: string;
}): Promise<Record<string, unknown>> {
  const { datasetId, domain = getDefaultDomain() } = params;

  const baseUrl = `https://${domain}`;

  // Fetch metadata and row count in parallel.
  // Row count uses a direct GET to avoid the SODA3 POST routing in fetchFromSocrataApi.
  const [metadata, countResult] = await Promise.all([
    fetchFromSocrataApi<Record<string, unknown>>(
      `/api/views/${datasetId}`,
      {},
      baseUrl
    ),
    axios.get<Record<string, unknown>[]>(
      `${baseUrl}/resource/${datasetId}.json`,
      { params: { '$select': 'count(*) as count', '$limit': 1 } }
    ).then(res => res.data).catch(() => null)
  ]);

  const rowCount = countResult?.[0]?.count ?? null;

  return {
    id: datasetId,
    name: metadata.name,
    rowCount,
    viewCount: metadata.viewCount,
    downloadCount: metadata.downloadCount,
    createdAt: metadata.createdAt,
    rowsUpdatedAt: metadata.rowsUpdatedAt,
    metadataUpdatedAt: metadata.metadataUpdatedAt,
    dataUpdatedAt: metadata.dataUpdatedAt,
    category: metadata.category,
    attribution: metadata.attribution,
    owner: (metadata as any).owner?.displayName,
    numberOfComments: metadata.numberOfComments,
  };
}

// Handler for data access functionality (preserved for backward compatibility)
async function handleDataAccess(params: {
  datasetId: string;
  domain?: string;
  soqlQuery?: string;
  limit?: number;
  offset?: number;
  select?: string;
  where?: string;
  order?: string;
  group?: string;
  having?: string;
  q?: string;
}): Promise<Record<string, unknown>[]> {
  const {
    datasetId,
    domain = getDefaultDomain(),
    soqlQuery,
    limit = 10,
    offset = 0,
    select,
    where,
    order,
    group,
    having,
    q
  } = params;

  const apiParams: Record<string, unknown> = {};

  if (soqlQuery && soqlQuery.trim().length > 0) {
    apiParams.$query = soqlQuery;
  } else {
    apiParams.$limit = limit;
    apiParams.$offset = offset;
    if (select) apiParams.$select = select;
    if (where) apiParams.$where = where;
    if (order) apiParams.$order = order;
    if (group) apiParams.$group = group;
    if (having) apiParams.$having = having;
    if (q) apiParams.$q = q;
  }

  const baseUrl = `https://${domain}`;
  const response = await fetchFromSocrataApi<Record<string, unknown>[]>(
    `/resource/${datasetId}.json`,
    apiParams,
    baseUrl
  );

  return response;
}

// Zod schemas for different tool types

// Search tool schema - matches OpenAI requirements (single query string)
export const searchToolZodSchema = z.object({
  query: z.string().min(1, 'Query is required').describe('Search query string')
});

// Fetch tool schema - matches OpenAI requirements (single ID string)
export const fetchToolZodSchema = z.object({
  id: z.string().min(1, 'Document ID is required').describe('Identifier returned from the search tool')
});

// 1️⃣ Zod definition for the Socrata tool's parameters.
// This is used by the MCP SDK to parse/validate parameters from the client.
export const socrataToolZodSchema = z.object({
  type: z.enum(['catalog','metadata','query','metrics'])
         .describe('Operation to perform'),
  query: z.string().min(1).optional()
         .describe('General search phrase OR a full SoQL query string. If this is a full SoQL query (e.g., starts with SELECT), other SoQL parameters like select, where, q might be overridden or ignored by the handler in favor of the full SoQL query. If it\'s a search phrase, it will likely be used for a full-text search ($q parameter to Socrata).'),
  // Optional parameters - these should also be in jsonParameters if they are to be exposed to the client
  domain: z.string().optional().describe('The Socrata domain (e.g., data.cityofnewyork.us)'),
  portal: z.string().optional().describe('Alias for domain — the Socrata portal domain'),
  limit: z.union([z.coerce.number().int().positive(), z.literal('all')]).optional().describe('Number of results to return, or "all" to fetch all available data up to configured cap'),
  offset: z.number().int().nonnegative().optional().describe('Offset for pagination'),
  select: z.string().optional().describe('SoQL SELECT clause'),
  where: z.string().optional().describe('SoQL WHERE clause'),
  order: z.string().optional().describe('SoQL ORDER BY clause'),
  group: z.string().optional().describe('SoQL GROUP BY clause'),
  having: z.string().optional().describe('SoQL HAVING clause'),
  dataset_id: z.string().optional().describe('Dataset ID (for metadata, metrics, data-access)'),
  q: z.string().optional().describe('Full-text search query within the dataset (used in data access)')
});

// Infer the type from the Zod schema for use in the handler
export type SocrataToolParams = z.infer<typeof socrataToolZodSchema>;
export type SearchToolParams = z.infer<typeof searchToolZodSchema>;
export type FetchToolParams = z.infer<typeof fetchToolZodSchema>;

// 2️⃣ Manually defined JSON Schema (conforming to JsonSchema7Type)
// This defines how the tool's parameters are presented to the MCP client (e.g., in MCP Inspector).
const jsonParameters: any = {
  type: 'object',
  properties: {
    type: {
      type: 'string',
      enum: ['catalog', 'metadata', 'query', 'metrics'],
      description: 'Operation to perform'
    },
    query: {
      type: 'string',
      description: 'General search phrase OR a full SoQL query string. If this is a full SoQL query (e.g., starts with SELECT), other SoQL parameters like select, where, q might be overridden or ignored by the handler in favor of the full SoQL query. If it\'s a search phrase, it will likely be used for a full-text search ($q parameter to Socrata).'
    },
    // Optional parameters reflected from socrataToolZodSchema
    domain: {
      type: 'string',
      description: 'The Socrata domain (e.g., data.cityofnewyork.us)'
    },
    portal: {
      type: 'string',
      description: 'Alias for domain — the Socrata portal domain'
    },
    limit: {
      type: 'string',
      description: 'Number of results to return (e.g., "10", "100"), or "all" to fetch all available data'
    },
    offset: {
      type: 'integer',
      description: 'Offset for pagination'
    },
    select: {
      type: 'string',
      description: 'SoQL SELECT clause'
    },
    where: {
      type: 'string',
      description: 'SoQL WHERE clause'
    },
    order: {
      type: 'string',
      description: 'SoQL ORDER BY clause'
    },
    group: {
      type: 'string',
      description: 'SoQL GROUP BY clause'
    },
    having: {
      type: 'string',
      description: 'SoQL HAVING clause'
    },
    dataset_id: {
      type: 'string',
      description: 'Dataset ID (for metadata, column-info, data-access)'
    },
    q: {
      type: 'string',
      description: 'Full-text search query within the dataset (used in data access)'
    }
  },
  required: ['type']
};

// JSON schemas for the new tools
const searchJsonParameters: any = {
  type: 'object',
  additionalProperties: false,
  properties: {
    query: {
      type: 'string',
      description: 'Search query for full-text search'
    }
  },
  required: ['query']
};

const fetchJsonParameters: any = {
  type: 'object',
  additionalProperties: false,
  properties: {
    id: {
      type: 'string',
      description: 'Identifier returned by the search tool'
    }
  },
  required: ['id']
};

// 3️⃣ Tool uses the manually crafted JSON schema
export const UNIFIED_SOCRATA_TOOL: ToolWithHandler = {
  name: 'get_data',
  description: 'A unified tool to interact with Socrata open-data portals.',
  inputSchema: jsonParameters,  // Latest MCP spec uses 'inputSchema'
  // Assert the handler type to satisfy the generic Tool.handler signature.
  // The actual call from src/index.ts will provide the correctly typed SocrataToolParams.
  handler: handleSocrataTool as (params: Record<string, unknown>) => Promise<unknown>
};

// New search tool that returns only id/score pairs
export const SEARCH_TOOL: ToolWithHandler = {
  name: 'search',
  title: 'Search NYC Open Data',
  description: 'Search NYC Open Data portal and return matching dataset IDs',
  inputSchema: searchJsonParameters,  // Latest MCP spec uses 'inputSchema'
  handler: handleSearchTool as (params: Record<string, unknown>) => Promise<unknown>
};

// New document retrieval tool
export const FETCH_TOOL: ToolWithHandler = {
  name: 'fetch',
  title: 'Fetch NYC Data Document',
  description: 'Retrieve full dataset metadata or record content from NYC Open Data portal',
  inputSchema: fetchJsonParameters,
  handler: handleFetchTool as (params: Record<string, unknown>) => Promise<unknown>
};

// Main handler function that dispatches to specific handlers based on type
// It now expects parameters already parsed by the MCP SDK according to socrataToolZodSchema.
export async function handleSocrataTool(
  rawParams: SocrataToolParams | any
  // context?: McpToolHandlerContext // Context removed for now to align with Tool.handler type
): Promise<unknown> {
  // Map old parameter names and aliases for backward compatibility
  const params: SocrataToolParams = {
    ...rawParams,
    dataset_id: rawParams.dataset_id || rawParams.datasetId,
    // Accept 'portal' as alias for 'domain'
    domain: rawParams.domain || rawParams.portal
  };

  const type = params.type; // Directly use the parsed 'type'
  const query = params.query; // Directly use the parsed 'query'

  // Use a mutable copy for potential modifications like adding default domain/limit/offset.
  const modifiableParams: Partial<SocrataToolParams> = { ...params };

  // Ensure a default domain is set if not provided, applicable to most handlers
  if (!modifiableParams.domain) {
    modifiableParams.domain = getDefaultDomain();
  }
  if (!modifiableParams.domain && ['catalog', 'metadata', 'query', 'metrics'].includes(type)) {
    throw new Error('Domain parameter is required for this operation type and no default DATA_PORTAL_URL is configured.');
  }

  // Default for limit/offset might apply to 'catalog' and 'query' (data-access)
  if (modifiableParams.limit === undefined && (type === 'catalog' || type === 'query')) {
    modifiableParams.limit = 10;
  }
  if (modifiableParams.offset === undefined && (type === 'catalog' || type === 'query')) {
    modifiableParams.offset = 0;
  }

  switch (type) {
    case 'catalog':
      // Pass all relevant params from modifiableParams
      // Handle 'all' limit by converting to a large number for catalog
      const catalogLimit = modifiableParams.limit === 'all' ? 1000 : 
                          typeof modifiableParams.limit === 'number' ? modifiableParams.limit : 10;
      return handleCatalog({ 
        query: modifiableParams.query, 
        domain: modifiableParams.domain, 
        limit: catalogLimit, 
        offset: modifiableParams.offset 
      });
    case 'metadata':
      const metadataDatasetId = modifiableParams.dataset_id || query;
      if (!metadataDatasetId) throw new Error('dataset_id is required for type=metadata');
      return handleDatasetMetadata({
        datasetId: metadataDatasetId,
        domain: modifiableParams.domain
      });
    case 'query': // This corresponds to 'data-access'
      const {
        dataset_id: dsId,
        query: queryField,
        domain: domainField,
        limit: limitField,
        offset: offsetField,
        select: selectField,
        where: whereField,
        order: orderField,
        group: groupField,
        having: havingField,
        q: zodQ
      } = modifiableParams;

      let effectiveDatasetId = dsId;
      if (!effectiveDatasetId && queryField && !/^\s*select/i.test(queryField)) {
        effectiveDatasetId = queryField;
      }
      if (!effectiveDatasetId) {
        throw new Error('Dataset ID (from dataset_id field, or from query field if not a SoQL SELECT) is required for type=query operation.');
      }

      let passAsSoqlQuery: string | undefined = undefined;
      let passAsSelect = selectField;
      let passAsWhere = whereField;
      let passAsOrder = orderField;
      let passAsGroup = groupField;
      let passAsHaving = havingField;
      let passAsQ = zodQ;

      if (queryField && /^\s*select/i.test(queryField)) {
        passAsSoqlQuery = queryField;
        passAsSelect = undefined;
        passAsWhere = undefined;
        passAsOrder = undefined;
        passAsGroup = undefined;
        passAsHaving = undefined;
        passAsQ = undefined;
        console.log('[handleSocrataTool] Received full SoQL query in "query" field; ignoring select/where/order/group/having/q parameters.');
      } else if (queryField) {
        passAsQ = queryField;
        console.log('[handleSocrataTool] Treating "query" field as general search term mapped to $q parameter.');
      }

      return handleSearch({
        datasetId: effectiveDatasetId,
        domain: domainField || getDefaultDomain(),
        soqlQuery: passAsSoqlQuery,
        limit: limitField as number | 'all' | undefined,
        offset: offsetField,
        select: passAsSelect,
        where: passAsWhere,
        order: passAsOrder,
        group: passAsGroup,
        having: passAsHaving,
        q: passAsQ
      });
    case 'metrics':
      const metricsDatasetId = modifiableParams.dataset_id || query;
      if (!metricsDatasetId) throw new Error('dataset_id is required for type=metrics');
      return handleMetrics({
        datasetId: metricsDatasetId,
        domain: modifiableParams.domain
      });
    default:
      const exhaustiveCheck: never = type;
      throw new Error(`Unknown Socrata operation type: ${exhaustiveCheck}. Supported types are catalog, metadata, query, metrics.`);
  }
}

// Export for backward compatibility (we'll remove this later)
export const handleCatalogTool = handleCatalog;
export const handleCategoriesTool = handleCategories;
export const handleTagsTool = handleTags;
export const handleDatasetMetadataTool = handleDatasetMetadata;
export const handleColumnInfoTool = handleColumnInfo;
export const handleDataAccessTool = handleDataAccess;

const STRICT_DATASET_ID_REGEX = /^[a-z0-9]{4}-[a-z0-9]{4}$/i;
const DATASET_ID_IN_PATH_REGEX = /[a-z0-9]{4}-[a-z0-9]{4}/i;

interface ParsedFetchIdentifier {
  kind: 'dataset' | 'record';
  domain: string;
  datasetId: string;
  recordId?: string;
}

function tryParseUrlIdentifier(input: string): ParsedFetchIdentifier | null {
  try {
    const url = new URL(input);
    const datasetMatch = url.pathname.match(DATASET_ID_IN_PATH_REGEX);
    if (!datasetMatch) {
      return null;
    }

    const datasetId = datasetMatch[0].toLowerCase();
    const domain = url.hostname.toLowerCase();

    let recordId: string | undefined;
    const rowMatch = url.pathname.match(/row\/(row-[^\/?]+|[^\/?]+)/i);
    if (rowMatch && rowMatch[1]) {
      recordId = decodeURIComponent(rowMatch[1]);
    } else {
      const recordParam =
        url.searchParams.get('row_id') ??
        url.searchParams.get('record_id') ??
        url.searchParams.get('rowid');
      if (recordParam) {
        recordId = recordParam;
      }
    }

    return {
      kind: recordId ? 'record' : 'dataset',
      domain,
      datasetId,
      recordId
    };
  } catch {
    return null;
  }
}

function parseFetchIdentifier(rawId: string): ParsedFetchIdentifier {
  const trimmed = rawId.trim();
  if (!trimmed) {
    throw new McpError(ErrorCode.InvalidParams, 'Document ID is required');
  }

  if (trimmed.startsWith('dataset:') || trimmed.startsWith('record:')) {
    const parts = trimmed.split(':');
    const kind = parts[0] as 'dataset' | 'record';
    const domain = parts[1];
    const datasetId = parts[2];
    const recordId = parts[3];

    if (!domain || !datasetId) {
      throw new McpError(
        ErrorCode.InvalidParams,
        'Fetch identifier must include domain and dataset ID'
      );
    }

    if (kind === 'record' && !recordId) {
      throw new McpError(
        ErrorCode.InvalidParams,
        'Record fetch identifier must include the row identifier'
      );
    }

    return {
      kind,
      domain: domain.toLowerCase(),
      datasetId: datasetId.toLowerCase(),
      recordId
    };
  }

  let parsed = tryParseUrlIdentifier(trimmed);
  if (!parsed && trimmed.includes('/')) {
    parsed = tryParseUrlIdentifier(`https://${trimmed}`);
  }
  if (parsed) {
    return parsed;
  }

  if (STRICT_DATASET_ID_REGEX.test(trimmed)) {
    return {
      kind: 'dataset',
      domain: getDefaultDomain(),
      datasetId: trimmed.toLowerCase()
    };
  }

  const colonParts = trimmed.split(':');
  if (colonParts.length === 2) {
    const [first, second] = colonParts;
    if (STRICT_DATASET_ID_REGEX.test(first) && second) {
      return {
        kind: 'record',
        domain: getDefaultDomain(),
        datasetId: first.toLowerCase(),
        recordId: second
      };
    }

    if ((first.includes('.') || first.includes('localhost')) && STRICT_DATASET_ID_REGEX.test(second)) {
      return {
        kind: 'dataset',
        domain: first.toLowerCase(),
        datasetId: second.toLowerCase()
      };
    }
  }

  throw new McpError(
    ErrorCode.InvalidParams,
    `Unsupported fetch identifier format: ${rawId}`
  );
}

const SEARCH_PREVIEW_ROW_LIMIT = 5;

// Fetch column metadata and preview rows for a single dataset.
// Returns partial enrichment — either field may be undefined on failure.
async function fetchEnrichment(
  datasetId: string,
  domain: string
): Promise<{
  columns?: { fieldName: string; dataTypeName: string; description?: string }[];
  preview_rows?: Record<string, unknown>[];
}> {
  const baseUrl = `https://${domain}`;

  const [columnsResult, previewResult] = await Promise.all([
    fetchFromSocrataApi<ColumnInfo[]>(
      `/api/views/${datasetId}/columns`,
      {},
      baseUrl
    ).catch(() => null),
    fetchFromSocrataApi<Record<string, unknown>[]>(
      `/resource/${datasetId}.json`,
      { $limit: SEARCH_PREVIEW_ROW_LIMIT },
      baseUrl
    ).catch(() => null)
  ]);

  const columns = columnsResult
    ? columnsResult
        .filter((col: any) => !col.flags?.includes('hidden'))
        .map((col: any) => ({
          fieldName: col.fieldName,
          dataTypeName: col.dataTypeName,
          ...(col.description ? { description: col.description } : {})
        }))
    : undefined;

  const preview_rows = previewResult
    ? previewResult.slice(0, SEARCH_PREVIEW_ROW_LIMIT)
    : undefined;

  return { columns, preview_rows };
}

// Handler for the new search tool
export async function handleSearchTool(
  rawParams: SearchToolParams | any
): Promise<{ content: { type: 'text'; text: string }[] }> {
  const { query } = searchToolZodSchema.parse(rawParams);

  const domain = getDefaultDomain();
  const catalogResults = await handleCatalog({
    query,
    domain,
    limit: 10,
    offset: 0
  });

  // Build base results, then enrich in parallel
  const baseResults = catalogResults.map((dataset: any) => {
    const datasetId = dataset.resource?.id || dataset.id;
    const title = dataset.resource?.name || dataset.name || datasetId;
    const description = dataset.resource?.description || dataset.description || '';

    return {
      datasetId,
      id: `dataset:${domain}:${datasetId}`,
      title,
      url: `https://${domain}/dataset/${datasetId}`,
      snippet: typeof description === 'string' ? description.slice(0, 200) : undefined
    };
  });

  // Fetch enrichment for all results in parallel
  const enrichments = await Promise.all(
    baseResults.map(r => fetchEnrichment(r.datasetId, domain))
  );

  const results = baseResults.map((base, i) => {
    const { datasetId, ...result } = base;
    const enrichment = enrichments[i];
    return {
      ...result,
      ...(enrichment.columns ? { columns: enrichment.columns } : {}),
      ...(enrichment.preview_rows ? { preview_rows: enrichment.preview_rows } : {})
    };
  });

  const responsePayload = {
    results
  };

  return {
    content: [
      {
        type: 'text',
        text: JSON.stringify(responsePayload)
      }
    ]
  };
}

// Helper function to provide backward compatibility for document retrieval params
export async function handleFetchTool(
  rawParams: FetchToolParams | any
): Promise<{ content: { type: 'text'; text: string }[] }> {
  const { id } = fetchToolZodSchema.parse(rawParams);

  const { kind, domain, datasetId, recordId } = parseFetchIdentifier(id);

  const resolvedDomain = domain || getDefaultDomain();

  if (kind === 'dataset') {
    const metadata = await handleDatasetMetadata({
      datasetId,
      domain: resolvedDomain
    });

    const title = (metadata as any)?.name || datasetId;
    const description = (metadata as any)?.description || (metadata as any)?.resource?.description || '';
    const columns: ColumnInfo[] | undefined = Array.isArray((metadata as any)?.columns)
      ? (metadata as any)?.columns
      : undefined;

    const textSections = [
      typeof description === 'string' && description.trim().length > 0 ? `Description:\n${description.trim()}` : undefined,
      columns && columns.length > 0
        ? `Columns:\n${columns.map(col => `- ${col.name}${col.dataTypeName ? ` (${col.dataTypeName})` : ''}`).join('\n')}`
        : undefined
    ].filter(Boolean);

    const responseObject = {
      id,
      title,
      text: textSections.join('\n\n') || 'No description available.',
      url: `https://${resolvedDomain}/dataset/${datasetId}`,
      metadata
    };

    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify(responseObject)
        }
      ]
    };
  }

  // kind === 'record'
  if (!recordId) {
    throw new McpError(
      ErrorCode.InvalidParams,
      'Record IDs must include a record identifier'
    );
  }

  const documents = await retrieveDocuments({
    ids: [recordId],
    datasetId,
    domain: resolvedDomain
  });

  const document = documents[0];

  if (!document) {
    throw new McpError(
      ErrorCode.NotFound,
      `Record ${recordId} not found in dataset ${datasetId}`
    );
  }

  const title = document?.name || document?.title || `${datasetId} record ${recordId}`;

  const responseObject = {
    id,
    title,
    text: JSON.stringify(document, null, 2),
    url: `${resolvedDomain}/dataset/${datasetId}/row/${recordId}`,
    metadata: {
      datasetId,
      domain: resolvedDomain
    }
  };

  return {
    content: [
      {
        type: 'text',
        text: JSON.stringify(responseObject)
      }
    ]
  };
}

// Export all tools as an array (now includes all three tools)
export const SOCRATA_TOOLS = [UNIFIED_SOCRATA_TOOL, SEARCH_TOOL, FETCH_TOOL];

