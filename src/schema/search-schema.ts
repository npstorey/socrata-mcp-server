import { z } from 'zod';

// Schema for the search response with metadata
export const searchResponseSchema = z.object({
  data: z.array(z.record(z.string(), z.unknown())),
  is_sample: z.boolean().describe('Whether the returned data is a sample/preview of a larger dataset'),
  returned_rows: z.number().describe('Number of rows actually returned in this response'),
  total_rows: z.number().describe('Total number of rows available in the dataset'),
  has_more: z.boolean().optional().describe('Whether there are more rows available beyond what was returned'),
  next_offset: z.number().optional().describe('The offset to use for fetching the next page of results')
});

export type SearchResponse = z.infer<typeof searchResponseSchema>;