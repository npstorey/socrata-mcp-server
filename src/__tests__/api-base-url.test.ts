/**
 * `fetchFromSocrataApi` requests only the portal its caller passes (server#63).
 *
 * It used to default `baseUrl` to `DATA_PORTAL_URL`, read once when `src/utils/api.ts` loaded:
 * a second default-portal layer under the one in `src/utils/portal-config.ts`. Every call site
 * now passes the base URL of the call it serves, and a call without one throws before any
 * request is made. The environment is set BEFORE the module is loaded here, so a surviving
 * snapshot would have a value to fall back to — the shape in which the fallback can show itself.
 */

import { describe, it, expect, vi, afterEach } from 'vitest';

vi.mock('axios');

const saved = process.env.DATA_PORTAL_URL;

afterEach(() => {
  if (saved === undefined) delete process.env.DATA_PORTAL_URL;
  else process.env.DATA_PORTAL_URL = saved;
  vi.resetModules();
});

describe('fetchFromSocrataApi without a baseUrl', () => {
  for (const path of ['/api/catalog/v1', '/api/views/abcd-1234', '/resource/abcd-1234.json']) {
    it(`${path}: throws, and requests nothing, even with DATA_PORTAL_URL set when the module loaded`, async () => {
      process.env.DATA_PORTAL_URL = 'https://data.cityofchicago.org';
      vi.resetModules();
      const axios = vi.mocked((await import('axios')).default);
      const { fetchFromSocrataApi } = await import('../utils/api.js');
      const call = fetchFromSocrataApi as unknown as (path: string, params?: Record<string, unknown>, baseUrl?: string) => Promise<unknown>;

      await expect(call(path, {})).rejects.toThrow(/no portal base URL/i);
      await expect(call(path, {}, '')).rejects.toThrow(/no portal base URL/i);
      expect(axios.mock.calls).toEqual([]);
      expect(axios.get.mock.calls).toEqual([]);
    });
  }
});
