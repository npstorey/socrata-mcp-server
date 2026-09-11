// THROWAWAY — Wave N11 (civic-ai-tools-website#434) P-S1 red instrument. Not for merge; the PR
// carrying it is closed unmerged once CI has run.
//
// With DATA_PORTAL_URL unset, a call that names no portal must be refused: the server chooses no
// portal on the caller's behalf. Three portal-less shapes are driven through the real handlers with
// the Socrata client mocked, so the request a call WOULD have made is recorded rather than sent.
// At c3c2f88 every shape fails, and the failure prints the recorded request, which names the
// literal portal the code falls back to (src/utils/portal-config.ts:29).
//
// The search leg asserts refusal. Whether search refuses or answers through the cross-portal
// discovery endpoint without a default is P-S1's to measure and state; this red only shows that
// today it silently scopes itself to one city.
import { describe, test, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('axios');
vi.mock('../utils/api.js', () => ({
  fetchFromSocrataApi: vi.fn(),
}));

import { handleSearchTool, handleFetchTool, handleSocrataTool } from '../tools/socrata-tools.js';
import { fetchFromSocrataApi } from '../utils/api.js';

const mockedFetch = vi.mocked(fetchFromSocrataApi);

describe('no DATA_PORTAL_URL configured: a call naming no portal is refused, and no request is made for it', () => {
  let saved: string | undefined;

  beforeEach(() => {
    saved = process.env.DATA_PORTAL_URL;
    delete process.env.DATA_PORTAL_URL;
    vi.clearAllMocks();
    mockedFetch.mockResolvedValue({ results: [] } as never);
  });

  afterEach(() => {
    if (saved === undefined) delete process.env.DATA_PORTAL_URL;
    else process.env.DATA_PORTAL_URL = saved;
  });

  const shapes: Array<[string, () => Promise<unknown>]> = [
    ['get_data catalog with no domain', () => handleSocrataTool({ type: 'catalog', query: 'noise' })],
    ['fetch of a bare dataset id', () => handleFetchTool({ id: 'abcd-1234' })],
    ['search', () => handleSearchTool({ query: 'noise' })],
  ];

  for (const [name, call] of shapes) {
    test(`${name}: refused, with no request made on the caller's behalf`, async () => {
      let refused = false;
      try {
        await call();
      } catch {
        refused = true;
      }
      const recordedRequests = mockedFetch.mock.calls.map((args) => JSON.stringify(args));
      expect({ refused, recordedRequests }).toEqual({ refused: true, recordedRequests: [] });
    });
  }
});
