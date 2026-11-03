import { fetchFromSocrataApi } from '../utils/api.js';
import { McpError, ErrorCode } from '../utils/mcp-errors.js';
import { summarizeError } from '../utils/log-summary.js';

// Size limits
const MAX_OBJECT_SIZE_KB = 2; // 2KB per object
const MAX_TOTAL_SIZE_MB = 10; // 10MB total

export interface SearchResult {
  id: string;
  score: number;
}

// Remove the wrapper interface - we'll return SearchResult[] directly
export type SearchIdsResponse = SearchResult[];

/**
 * Calculate a relevance score based on search criteria
 * This is a simplified scoring - in production you might want more sophisticated ranking
 */
function calculateScore(row: any, query?: string): number {
  if (!query) return 1.0;
  
  // Simple scoring based on field matches
  let score = 0;
  const queryLower = query.toLowerCase();
  
  // Check each field for matches
  for (const [key, value] of Object.entries(row)) {
    if (value && typeof value === 'string') {
      const valueLower = value.toLowerCase();
      if (valueLower.includes(queryLower)) {
        // Exact match gets higher score
        if (valueLower === queryLower) {
          score += 10;
        } else {
          score += 1;
        }
        // Bonus for matches in important fields
        if (key === 'name' || key === 'title' || key === 'description') {
          score += 2;
        }
      }
    }
  }
  
  // Normalize to 0-1 range
  return Math.min(1.0, score / 10);
}

/**
 * Extract the ID field from a Socrata row
 * Socrata datasets typically have :id or _id fields
 */
function extractId(row: any): string | null {
  // Try common ID field names
  const idFields = [':id', '_id', 'id', 'ID', 'uid', 'UID'];
  
  for (const field of idFields) {
    if (row[field]) {
      return String(row[field]);
    }
  }
  
  // If no ID field found, generate one from row index or hash
  // This is a fallback - ideally all datasets should have IDs
  return null;
}

/**
 * Enforce size limits on objects
 */
function enforceObjectSize(obj: any, maxKB: number): any {
  const json = JSON.stringify(obj);
  const sizeKB = new TextEncoder().encode(json).length / 1024;
  
  if (sizeKB <= maxKB) {
    return obj;
  }
  
  // Object too large - return a truncated version
  console.warn(`[SearchIds] Object size ${sizeKB.toFixed(2)}KB exceeds limit of ${maxKB}KB`);
  
  // For search results, we can't really truncate, so we'll throw an error
  throw new Error(`Search result object exceeds size limit of ${maxKB}KB`);
}

/**
 * Search for datasets and return only IDs with relevance scores
 */
export async function searchIds(params: {
  datasetId?: string;
  domain: string;
  query?: string;
  where?: string;
  limit?: number;
  offset?: number;
}): Promise<SearchIdsResponse> {
  const { 
    datasetId, 
    domain, 
    query, 
    where,
    limit = 100,
    offset = 0 
  } = params;

  // Require datasetId for now - catalog search is handled in the parent handler
  if (!datasetId) {
    throw new McpError(
      ErrorCode.InvalidParams,
      'datasetId is required for searchIds function'
    );
  }

  // Pre-flight check: estimate response size
  // Each object is roughly {id: "string", score: number} ≈ 100 bytes average
  const estimatedSizeBytes = limit * 100;
  if (estimatedSizeBytes > MAX_TOTAL_SIZE_MB * 1024 * 1024) {
    throw new McpError(
      ErrorCode.InvalidParams,
      `Request would exceed size limit of ${MAX_TOTAL_SIZE_MB}MB. Reduce limit parameter.`
    );
  }

  const apiParams: Record<string, unknown> = {
    $limit: limit,
    $offset: offset
  };

  // Add search query if provided
  if (query) {
    apiParams.$q = query;
  }

  // Add where clause if provided
  if (where) {
    apiParams.$where = where;
  }

  // Include ID field in select to ensure we get it
  apiParams.$select = ':*, *';

  const baseUrl = `https://${domain}`;
  
  try {
    // Fetch matching rows
    const rows = await fetchFromSocrataApi<Record<string, unknown>[]>(
      `/resource/${datasetId}.json`,
      apiParams,
      baseUrl
    );

    // Convert to search results
    const results: SearchResult[] = [];
    let totalSize = 0;
    
    for (let i = 0; i < rows.length; i++) {
      const row = rows[i];
      const id = extractId(row);
      
      if (!id) {
        console.warn(`[SearchIds] No ID found for row ${i}, using index`);
        // Use row index as fallback ID
        results.push({
          id: `row_${offset + i}`,
          score: calculateScore(row, query)
        });
      } else {
        const result = {
          id,
          score: calculateScore(row, query)
        };
        
        // Check object size
        try {
          const checkedResult = enforceObjectSize(result, MAX_OBJECT_SIZE_KB);
          results.push(checkedResult);
          
          // Track total size
          totalSize += JSON.stringify(checkedResult).length;
          
          // Check total size limit
          if (totalSize > MAX_TOTAL_SIZE_MB * 1024 * 1024) {
            console.warn(`[SearchIds] Total size limit reached, returning ${results.length} results`);
            break;
          }
        } catch (error) {
          console.error(`[SearchIds] Skipping oversized result: ${summarizeError(error)}`);
          // Skip this result
        }
      }
    }

    // Sort by score descending
    results.sort((a, b) => b.score - a.score);

    return results;
  } catch (error) {
    console.error(`[SearchIds] Search error: ${summarizeError(error)}`);
    if (error instanceof McpError) {
      throw error;
    }
    throw new McpError(
      ErrorCode.InternalError,
      `Search failed: ${error instanceof Error ? error.message : 'Unknown error'}`
    );
  }
}