import { describe, test, expect, vi, beforeEach } from 'vitest';
import { handleSearch, getRowCount, MAX_ROWS, DEFAULT_PREVIEW_ROWS, MAX_RAW_ROWS } from '../tools/search.js';
import * as api from '../utils/api.js';

// Mock the API module
vi.mock('../utils/api.js');

describe('Search Tool', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('getRowCount', () => {
    test('should fetch row count correctly', async () => {
      const mockFetch = vi.mocked(api.fetchFromSocrataApi);
      mockFetch.mockResolvedValueOnce([{ count: '12345' }]);

      const count = await getRowCount({
        datasetId: 'test-123',
        domain: 'data.test.gov',
        where: 'amount > 100'
      });

      expect(count).toBe(12345);
      expect(mockFetch).toHaveBeenCalledWith(
        '/resource/test-123.json',
        {
          $select: 'count(*)',
          $limit: 1,
          $where: 'amount > 100'
        },
        'https://data.test.gov'
      );
    });
  });

  describe('handleSearch', () => {
    test('returns full data when dataset is small', async () => {
      const mockFetch = vi.mocked(api.fetchFromSocrataApi);
      const mockData = Array(123).fill({}).map((_, i) => ({ id: i, value: `item-${i}` }));
      
      // First call: count
      mockFetch.mockResolvedValueOnce([{ count: '123' }]);
      // Second call: data
      mockFetch.mockResolvedValueOnce(mockData);

      const result = await handleSearch({
        datasetId: 'small-dataset',
        domain: 'data.test.gov'
      });

      expect(result).toEqual({
        data: mockData,
        is_sample: false,
        returned_rows: 123,
        total_rows: 123
      });

      // Should have called count first, then fetched all data
      expect(mockFetch).toHaveBeenCalledTimes(2);
    });

    test('marks as sample when dataset is huge and no explicit limit', async () => {
      const mockFetch = vi.mocked(api.fetchFromSocrataApi);
      const mockData = Array(DEFAULT_PREVIEW_ROWS).fill({}).map((_, i) => ({ id: i }));
      
      // First call: count shows huge dataset
      mockFetch.mockResolvedValueOnce([{ count: '120000' }]);
      // Second call: preview data
      mockFetch.mockResolvedValueOnce(mockData);

      const result = await handleSearch({
        datasetId: 'huge-dataset',
        domain: 'data.test.gov'
      });

      expect(result).toEqual({
        data: mockData,
        is_sample: true,
        returned_rows: DEFAULT_PREVIEW_ROWS,
        total_rows: 120000,
        has_more: true,
        next_offset: DEFAULT_PREVIEW_ROWS
      });

      // Should fetch only preview rows
      expect(mockFetch).toHaveBeenCalledTimes(2);
      expect(mockFetch).toHaveBeenLastCalledWith(
        '/resource/huge-dataset.json',
        {
          $limit: DEFAULT_PREVIEW_ROWS,
          $offset: 0
        },
        'https://data.test.gov'
      );
    });

    test('"all" on a dataset within the cap returns every row, in one request', async () => {
      const mockFetch = vi.mocked(api.fetchFromSocrataApi);
      const rows = Array(600).fill({}).map((_, i) => ({ id: i }));

      mockFetch.mockResolvedValueOnce([{ count: '600' }]);
      mockFetch.mockResolvedValueOnce(rows);

      const result = await handleSearch({
        datasetId: 'all-small-dataset',
        domain: 'data.test.gov',
        limit: 'all'
      });

      expect(result).toEqual({
        data: rows,
        is_sample: false,
        returned_rows: 600,
        total_rows: 600,
        has_more: false,
        next_offset: undefined
      });
      expect(mockFetch).toHaveBeenCalledTimes(2);
      expect(mockFetch).toHaveBeenLastCalledWith(
        '/resource/all-small-dataset.json',
        { $limit: 600, $offset: 0 },
        'https://data.test.gov'
      );
    });

    test('"all" past the cap returns the first 10,000 rows, with next_offset and a limit_note (#77)', async () => {
      const mockFetch = vi.mocked(api.fetchFromSocrataApi);
      const totalRows = 150000;
      const firstPage = Array(MAX_RAW_ROWS).fill({}).map((_, i) => ({ id: i }));

      mockFetch.mockResolvedValueOnce([{ count: totalRows.toString() }]);
      mockFetch.mockResolvedValueOnce(firstPage);

      const result = await handleSearch({
        datasetId: 'huge-all-dataset',
        domain: 'data.test.gov',
        limit: 'all'
      });

      expect(MAX_RAW_ROWS).toBe(10000);
      expect(result).toEqual({
        data: firstPage,
        is_sample: false,
        returned_rows: 10000,
        total_rows: 150000,
        has_more: true,
        next_offset: 10000,
        limit_note: '"all" returns at most 10,000 rows per call; 140,000 more match from next_offset. Continue from next_offset, or use aggregation (GROUP BY) to analyze the full dataset.'
      });
      // Count + one page of 10,000: it used to page through 100,000 rows in 50,000-row requests.
      expect(mockFetch).toHaveBeenCalledTimes(2);
      expect(mockFetch).toHaveBeenLastCalledWith(
        '/resource/huge-all-dataset.json',
        { $limit: 10000, $offset: 0 },
        'https://data.test.gov'
      );
    });

    test('"all" from an offset fetches only what remains', async () => {
      const mockFetch = vi.mocked(api.fetchFromSocrataApi);
      const rest = Array(5000).fill({}).map((_, i) => ({ id: 20000 + i }));

      mockFetch.mockResolvedValueOnce([{ count: '25000' }]);
      mockFetch.mockResolvedValueOnce(rest);

      const result = await handleSearch({
        datasetId: 'all-offset-dataset',
        domain: 'data.test.gov',
        limit: 'all',
        offset: 20000
      });

      expect(result).toMatchObject({ returned_rows: 5000, total_rows: 25000, has_more: false });
      expect(result.limit_note).toBeUndefined();
      expect(mockFetch).toHaveBeenLastCalledWith(
        '/resource/all-offset-dataset.json',
        { $limit: 5000, $offset: 20000 },
        'https://data.test.gov'
      );
    });

    test('a limit past the cap is reduced to it, with a limit_note (the evaluation\'s limit 32016)', async () => {
      const mockFetch = vi.mocked(api.fetchFromSocrataApi);
      const rows = Array(MAX_RAW_ROWS).fill({}).map((_, i) => ({ id: i }));

      mockFetch.mockResolvedValueOnce([{ count: '40000' }]);
      mockFetch.mockResolvedValueOnce(rows);

      const result = await handleSearch({
        datasetId: 'xzkq-xp2w',
        domain: 'data.test.gov',
        limit: 32016
      });

      expect(result).toEqual({
        data: rows,
        is_sample: false,
        returned_rows: 10000,
        total_rows: 40000,
        limit_note: 'Results limited to 10,000 rows per call (requested 32,016). Use aggregation (GROUP BY) to analyze the full dataset, or page with offset.'
      });
      expect(mockFetch).toHaveBeenLastCalledWith(
        '/resource/xzkq-xp2w.json',
        { $limit: 10000, $offset: 0 },
        'https://data.test.gov'
      );
    });

    test('a limit past the cap on a dataset smaller than the cap carries no limit_note: nothing was left out', async () => {
      const mockFetch = vi.mocked(api.fetchFromSocrataApi);
      const rows = Array(500).fill({}).map((_, i) => ({ id: i }));

      mockFetch.mockResolvedValueOnce([{ count: '500' }]);
      mockFetch.mockResolvedValueOnce(rows);

      const result = await handleSearch({
        datasetId: 'small-big-limit-dataset',
        domain: 'data.test.gov',
        limit: 20000
      });

      expect(result).toEqual({ data: rows, is_sample: false, returned_rows: 500, total_rows: 500 });
      expect(mockFetch).toHaveBeenLastCalledWith(
        '/resource/small-big-limit-dataset.json',
        { $limit: 10000, $offset: 0 },
        'https://data.test.gov'
      );
    });

    test('a limit past the cap on a large dataset is reduced in the preview too', async () => {
      const mockFetch = vi.mocked(api.fetchFromSocrataApi);

      mockFetch.mockResolvedValueOnce([{ count: '120000' }]);
      mockFetch.mockResolvedValueOnce(Array(MAX_RAW_ROWS).fill({}).map((_, i) => ({ id: i })));

      const result = await handleSearch({
        datasetId: 'large-limit-dataset',
        domain: 'data.test.gov',
        limit: 20000
      });

      expect(result).toMatchObject({ is_sample: true, returned_rows: 10000, has_more: true, next_offset: 10000 });
      expect(result.limit_note).toContain('requested 20,000');
      expect(mockFetch).toHaveBeenLastCalledWith(
        '/resource/large-limit-dataset.json',
        { $limit: 10000, $offset: 0 },
        'https://data.test.gov'
      );
    });

    test('no limit on more rows than the cap returns a preview, not every row', async () => {
      const mockFetch = vi.mocked(api.fetchFromSocrataApi);

      mockFetch.mockResolvedValueOnce([{ count: '30000' }]);
      mockFetch.mockResolvedValueOnce(Array(DEFAULT_PREVIEW_ROWS).fill({}).map((_, i) => ({ id: i })));

      const result = await handleSearch({
        datasetId: 'mid-dataset',
        domain: 'data.test.gov'
      });

      expect(result).toMatchObject({ is_sample: true, returned_rows: DEFAULT_PREVIEW_ROWS, total_rows: 30000, has_more: true });
      expect(mockFetch).toHaveBeenLastCalledWith(
        '/resource/mid-dataset.json',
        { $limit: DEFAULT_PREVIEW_ROWS, $offset: 0 },
        'https://data.test.gov'
      );
    });

    test('handles full SoQL query', async () => {
      const mockFetch = vi.mocked(api.fetchFromSocrataApi);
      const mockData = Array(42).fill({}).map((_, i) => ({ id: i }));
      
      mockFetch.mockResolvedValueOnce(mockData);

      const result = await handleSearch({
        datasetId: 'soql-dataset',
        domain: 'data.test.gov',
        soqlQuery: 'SELECT * WHERE category = "test" LIMIT 42'
      });

      expect(result).toEqual({
        data: mockData,
        is_sample: false,
        returned_rows: 42,
        total_rows: 42,
        has_more: false
      });

      // Should make only one call with the full query
      expect(mockFetch).toHaveBeenCalledTimes(1);
      expect(mockFetch).toHaveBeenCalledWith(
        '/resource/soql-dataset.json',
        {
          $query: 'SELECT * WHERE category = "test" LIMIT 42'
        },
        'https://data.test.gov'
      );
    });

    test('uses custom limit when provided', async () => {
      const mockFetch = vi.mocked(api.fetchFromSocrataApi);
      const mockData = Array(500).fill({}).map((_, i) => ({ id: i }));
      
      // First call: count
      mockFetch.mockResolvedValueOnce([{ count: '10000' }]);
      // Second call: limited data
      mockFetch.mockResolvedValueOnce(mockData);

      const result = await handleSearch({
        datasetId: 'custom-limit-dataset',
        domain: 'data.test.gov',
        limit: 500
      });

      expect(result).toEqual({
        data: mockData,
        is_sample: false,
        returned_rows: 500,
        total_rows: 10000
      });

      expect(mockFetch).toHaveBeenLastCalledWith(
        '/resource/custom-limit-dataset.json',
        {
          $limit: 500,
          $offset: 0
        },
        'https://data.test.gov'
      );
    });

    test('applies filters correctly', async () => {
      const mockFetch = vi.mocked(api.fetchFromSocrataApi);
      
      // First call: count with filters
      mockFetch.mockResolvedValueOnce([{ count: '50' }]);
      // Second call: filtered data
      mockFetch.mockResolvedValueOnce(Array(50).fill({}).map((_, i) => ({ id: i })));

      await handleSearch({
        datasetId: 'filtered-dataset',
        domain: 'data.test.gov',
        where: 'amount > 1000',
        select: 'id, name, amount',
        order: 'amount DESC',
        q: 'important'
      });

      // Check that filters were applied to both count and data queries
      expect(mockFetch).toHaveBeenCalledWith(
        '/resource/filtered-dataset.json',
        {
          $select: 'count(*)',
          $limit: 1,
          $where: 'amount > 1000',
          $q: 'important'
        },
        'https://data.test.gov'
      );

      expect(mockFetch).toHaveBeenCalledWith(
        '/resource/filtered-dataset.json',
        {
          $limit: 50,
          $offset: 0,
          $select: 'id, name, amount',
          $where: 'amount > 1000',
          $order: 'amount DESC',
          $q: 'important'
        },
        'https://data.test.gov'
      );
    });

    test('handles offset correctly', async () => {
      const mockFetch = vi.mocked(api.fetchFromSocrataApi);
      const mockData = Array(100).fill({}).map((_, i) => ({ id: i + 1000 }));
      
      // First call: count
      mockFetch.mockResolvedValueOnce([{ count: '5000' }]);
      // Second call: offset data
      mockFetch.mockResolvedValueOnce(mockData);

      const result = await handleSearch({
        datasetId: 'offset-dataset',
        domain: 'data.test.gov',
        limit: 100,
        offset: 1000
      });

      expect(result).toEqual({
        data: mockData,
        is_sample: false,
        returned_rows: 100,
        total_rows: 5000
      });

      expect(mockFetch).toHaveBeenLastCalledWith(
        '/resource/offset-dataset.json',
        {
          $limit: 100,
          $offset: 1000
        },
        'https://data.test.gov'
      );
    });

    test('handles empty result gracefully', async () => {
      const mockFetch = vi.mocked(api.fetchFromSocrataApi);
      
      // First call: count = 0
      mockFetch.mockResolvedValueOnce([{ count: '0' }]);
      // Second call: empty array
      mockFetch.mockResolvedValueOnce([]);

      const result = await handleSearch({
        datasetId: 'empty-dataset',
        domain: 'data.test.gov'
      });

      expect(result).toEqual({
        data: [],
        is_sample: false,
        returned_rows: 0,
        total_rows: 0
      });
    });

    test('detects when SoQL query hits MAX_ROWS limit', async () => {
      const mockFetch = vi.mocked(api.fetchFromSocrataApi);
      const mockData = Array(MAX_ROWS).fill({}).map((_, i) => ({ id: i }));
      
      mockFetch.mockResolvedValueOnce(mockData);

      const result = await handleSearch({
        datasetId: 'max-rows-dataset',
        domain: 'data.test.gov',
        soqlQuery: 'SELECT * FROM dataset'
      });

      expect(result).toEqual({
        data: mockData,
        is_sample: false,
        returned_rows: MAX_ROWS,
        total_rows: MAX_ROWS,
        has_more: true, // Indicates there might be more data
        limit_note: expect.stringContaining('Results limited to')
      });
    });

    test('respects a custom MAX_RAW_ROWS from the environment, for "all" and for limit', async () => {
      process.env.MAX_RAW_ROWS = '2500';
      try {
        // Re-import to pick up new env var
        vi.resetModules();
        const { handleSearch: handleSearchWithNewCap } = await import('../tools/search.js');

        const mockFetch = vi.mocked(api.fetchFromSocrataApi);

        mockFetch.mockResolvedValueOnce([{ count: '30000' }]);
        mockFetch.mockResolvedValueOnce(Array(2500).fill({}).map((_, i) => ({ id: i })));
        const all = await handleSearchWithNewCap({ datasetId: 'custom-cap-dataset', domain: 'data.test.gov', limit: 'all' });
        expect(all).toMatchObject({ returned_rows: 2500, total_rows: 30000, has_more: true, next_offset: 2500 });
        expect(mockFetch).toHaveBeenLastCalledWith('/resource/custom-cap-dataset.json', { $limit: 2500, $offset: 0 }, 'https://data.test.gov');

        mockFetch.mockResolvedValueOnce([{ count: '30000' }]);
        mockFetch.mockResolvedValueOnce(Array(2500).fill({}).map((_, i) => ({ id: i })));
        const limited = await handleSearchWithNewCap({ datasetId: 'custom-cap-dataset', domain: 'data.test.gov', limit: 4000 });
        expect(limited.limit_note).toContain('Results limited to 2,500 rows per call (requested 4,000)');
        expect(mockFetch).toHaveBeenLastCalledWith('/resource/custom-cap-dataset.json', { $limit: 2500, $offset: 0 }, 'https://data.test.gov');
      } finally {
        delete process.env.MAX_RAW_ROWS;
        vi.resetModules();
      }
    });
  });
});