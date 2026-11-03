import { fetchFromSocrataApi } from '../utils/api.js';
import { documentCache } from '../utils/cache.js';
import { McpError, ErrorCode } from '../utils/mcp-errors.js';
import { summarizeError } from '../utils/log-summary.js';

// Size limits
const MAX_ROWS_PER_REQUEST = 50; // Maximum 50 rows per request
const MAX_ROW_SIZE_KB = 20; // Maximum 20KB per row
const SOCRATA_MAX_ROWS = 50000; // Socrata's per-request limit

export interface DocumentRetrievalRequest {
  ids: string[];
  datasetId?: string;
  domain: string;
}

// Return just an array of documents
export type DocumentRetrievalResponse = any[];

/**
 * Generate cache key for a request
 */
function getCacheKey(datasetId: string, ids: string[]): string {
  // Sort IDs to ensure consistent cache keys
  const sortedIds = [...ids].sort();
  return `${datasetId}:${JSON.stringify(sortedIds)}`;
}

/**
 * Enforce size limit on individual documents
 */
function enforceDocumentSize(doc: any, maxKB: number): any {
  const json = JSON.stringify(doc);
  const sizeKB = new TextEncoder().encode(json).length / 1024;
  
  if (sizeKB <= maxKB) {
    return doc;
  }
  
  console.warn(`[DocumentRetrieval] Document size ${sizeKB.toFixed(2)}KB exceeds limit of ${maxKB}KB`);
  
  // Truncate large fields
  const truncated = { ...doc };
  
  // Find and truncate large string fields
  for (const [key, value] of Object.entries(truncated)) {
    if (typeof value === 'string' && value.length > 1000) {
      truncated[key] = value.substring(0, 1000) + '... [truncated]';
    } else if (Array.isArray(value) && value.length > 10) {
      truncated[key] = value.slice(0, 10);
      truncated[`${key}_truncated`] = true;
    }
  }
  
  // Add truncation flag
  truncated._truncated = true;
  
  return truncated;
}

/**
 * Build a WHERE clause to filter by IDs
 */
function buildIdFilter(ids: string[], idField: string = ':id'): string {
  if (ids.length === 0) return '';
  
  if (ids.length === 1) {
    return `${idField} = '${ids[0]}'`;
  }
  
  // For multiple IDs, use IN clause
  const quotedIds = ids.map(id => `'${id}'`).join(',');
  return `${idField} IN (${quotedIds})`;
}

/**
 * Detect the ID field name in the dataset
 */
async function detectIdField(datasetId: string, domain: string): Promise<string> {
  try {
    // Fetch one row to inspect fields
    const baseUrl = `https://${domain}`;
    const sample = await fetchFromSocrataApi<Record<string, unknown>[]>(
      `/resource/${datasetId}.json`,
      { $limit: 1 },
      baseUrl
    );
    
    if (sample.length === 0) {
      return ':id'; // Default
    }
    
    const row = sample[0];
    const idFields = [':id', '_id', 'id', 'ID', 'uid', 'UID'];
    
    for (const field of idFields) {
      if (field in row) {
        return field;
      }
    }
    
    // Default to :id
    return ':id';
  } catch (error) {
    console.warn(`[DocumentRetrieval] Could not detect ID field: ${summarizeError(error)}`);
    return ':id';
  }
}

/**
 * Retrieve documents by their IDs with caching and size limits
 */
export async function retrieveDocuments(
  request: DocumentRetrievalRequest
): Promise<DocumentRetrievalResponse> {
  const { ids, datasetId, domain } = request;
  
  if (!datasetId) {
    throw new McpError(
      ErrorCode.InvalidParams,
      'datasetId is required for document retrieval'
    );
  }
  
  // Pre-flight check: validate request size
  if (ids.length > MAX_ROWS_PER_REQUEST) {
    throw new McpError(
      ErrorCode.InvalidParams,
      `Cannot retrieve more than ${MAX_ROWS_PER_REQUEST} documents at once. Requested: ${ids.length}`
    );
  }
  
  const requestedIds = ids;
  
  // Check cache first
  const cacheKey = getCacheKey(datasetId, requestedIds);
  const cachedResult = documentCache.get(cacheKey);
  
  if (cachedResult) {
    console.log('[DocumentRetrieval] Cache hit');
    return cachedResult as DocumentRetrievalResponse;
  }
  
  console.log('[DocumentRetrieval] Cache miss, fetching from Socrata');
  
  const errors: string[] = [];
  const documents: any[] = [];
  
  try {
    // Detect ID field
    const idField = await detectIdField(datasetId, domain);
    
    // For row_N style IDs, we need to fetch by offset
    const rowIndexIds = requestedIds.filter(id => id.startsWith('row_'));
    const regularIds = requestedIds.filter(id => !id.startsWith('row_'));
    
    // Fetch regular IDs if any
    if (regularIds.length > 0) {
      const whereClause = buildIdFilter(regularIds, idField);
      const apiParams: Record<string, unknown> = {
        $where: whereClause,
        $limit: SOCRATA_MAX_ROWS
      };
      
      const baseUrl = `https://${domain}`;
      const rows = await fetchFromSocrataApi<Record<string, unknown>[]>(
        `/resource/${datasetId}.json`,
        apiParams,
        baseUrl
      );
      
      // Process and add documents
      for (const row of rows) {
        try {
          const sizedDoc = enforceDocumentSize(row, MAX_ROW_SIZE_KB);
          documents.push(sizedDoc);
        } catch (error) {
          errors.push(`Failed to process document: ${error}`);
        }
      }
    }
    
    // Fetch row index IDs if any
    if (rowIndexIds.length > 0) {
      // Extract offsets from row_N format
      const offsets = rowIndexIds
        .map(id => {
          const match = id.match(/^row_(\d+)$/);
          return match ? parseInt(match[1], 10) : null;
        })
        .filter((offset): offset is number => offset !== null)
        .sort((a, b) => a - b);
      
      if (offsets.length > 0) {
        // Fetch rows at specific offsets
        // This is inefficient but necessary for row-based IDs
        const minOffset = offsets[0];
        const maxOffset = offsets[offsets.length - 1];
        const limit = Math.min(maxOffset - minOffset + 1, SOCRATA_MAX_ROWS);
        
        const apiParams: Record<string, unknown> = {
          $offset: minOffset,
          $limit: limit
        };
        
        const baseUrl = `https://${domain}`;
        const rows = await fetchFromSocrataApi<Record<string, unknown>[]>(
          `/resource/${datasetId}.json`,
          apiParams,
          baseUrl
        );
        
        // Extract requested rows by index
        for (const offset of offsets) {
          const relativeIndex = offset - minOffset;
          if (relativeIndex < rows.length) {
            try {
              const row = rows[relativeIndex];
              const sizedDoc = enforceDocumentSize(row, MAX_ROW_SIZE_KB);
              documents.push(sizedDoc);
            } catch (error) {
              errors.push(`Failed to process document at offset ${offset}: ${error}`);
            }
          }
        }
      }
    }
    
    // Cache the result
    documentCache.set(cacheKey, documents);
    
    return documents;
    
  } catch (error) {
    console.error(`[DocumentRetrieval] Error fetching documents: ${summarizeError(error)}`);
    
    // Return partial results if any
    if (documents.length > 0) {
      return documents;
    }
    
    // Complete failure
    if (error instanceof McpError) {
      throw error;
    }
    throw new McpError(
      ErrorCode.InternalError,
      `Document retrieval failed: ${error instanceof Error ? error.message : 'Unknown error'}`
    );
  }
}

/**
 * Retrieve all documents for a dataset (with pagination and sampling)
 * This is used when no specific IDs are provided
 */
export async function retrieveAllDocuments(params: {
  datasetId?: string;
  domain: string;
  limit?: number | 'all';
  offset?: number;
  where?: string;
  order?: string;
}): Promise<DocumentRetrievalResponse> {
  const {
    datasetId,
    domain,
    limit = MAX_ROWS_PER_REQUEST,
    offset = 0,
    where,
    order
  } = params;
  
  if (!datasetId) {
    throw new McpError(
      ErrorCode.InvalidParams,
      'datasetId is required for retrieveAllDocuments'
    );
  }

  // Check if we need to fetch all
  const fetchAll = limit === 'all';
  const requestedLimit = fetchAll ? SOCRATA_MAX_ROWS : 
                        typeof limit === 'number' ? Math.min(limit, MAX_ROWS_PER_REQUEST) : 
                        MAX_ROWS_PER_REQUEST;

  const apiParams: Record<string, unknown> = {
    $limit: requestedLimit,
    $offset: offset
  };

  if (where) apiParams.$where = where;
  if (order) apiParams.$order = order;

  const baseUrl = `https://${domain}`;
  
  try {
    // Get total count first
    const countParams: Record<string, unknown> = {
      $select: 'count(*)',
      $limit: 1
    };
    
    if (where) countParams.$where = where;
    
    const countResult = await fetchFromSocrataApi<Array<{ count: string }>>(
      `/resource/${datasetId}.json`,
      countParams,
      baseUrl
    );
    
    const totalCount = parseInt(countResult[0]?.count || '0', 10);
    
    // Fetch documents
    const rows = await fetchFromSocrataApi<Record<string, unknown>[]>(
      `/resource/${datasetId}.json`,
      apiParams,
      baseUrl
    );
    
    // Process documents with size limits
    const documents: any[] = [];
    const errors: string[] = [];
    
    for (const row of rows) {
      try {
        const sizedDoc = enforceDocumentSize(row, MAX_ROW_SIZE_KB);
        documents.push(sizedDoc);
      } catch (error) {
        errors.push(`Failed to process document: ${error}`);
      }
    }
    
    return documents;
    
  } catch (error) {
    console.error(`[DocumentRetrieval] Error fetching all documents: ${summarizeError(error)}`);
    if (error instanceof McpError) {
      throw error;
    }
    throw new McpError(
      ErrorCode.InternalError,
      `Document retrieval failed: ${error instanceof Error ? error.message : 'Unknown error'}`
    );
  }
}