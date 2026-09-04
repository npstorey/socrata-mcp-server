/**
 * The text this server sends a client or a model must describe the portal it is
 * actually configured for (server#61, widened at Wave N10 P-S1).
 *
 * WHAT THIS GUARD ASSERTS OVER — and why it is shaped this way.
 *
 * It drives the real `createServer()` from `src/index.ts` over an in-memory
 * transport with a real MCP `Client`, and asserts over the JSON-RPC responses
 * that come back: `tools/list`, `prompts/list`, `prompts/get` (every prompt),
 * `resources/list` and `resources/read` (every resource). It never imports
 * `SEARCH_TOOL.description` — or any other constant under test — into its own
 * expectation. Every existing assertion in this suite did exactly that
 * (`tools-schema-validation.test.ts`, `openai-mcp-integration.test.ts`,
 * `socrata-tools.test.ts`), which is why the strings could have said anything
 * and the suite would have stayed green.
 *
 * THE EXPECTATION IS DERIVED FROM `DATA_PORTAL_URL`, NOT FROM A LIST.
 *
 * The table below holds two portals. Each run configures the server for one of
 * them, and the *other* row supplies the vocabulary that must not appear. A
 * guard exercised only under the default configuration is the shape that cannot
 * fail, so both rows are driven, and each run also asserts positively that the
 * configured domain does reach the surface — proving the text adapts rather
 * than merely having been scrubbed of city names.
 *
 * IT ALSO REQUIRES THE TEXT TO BE RESOLVED LAZILY. One server instance answers
 * under both configurations. That is not incidental: `src/index.ts` calls
 * `dotenv.config()` in its module body, which runs *after* every import it
 * makes, so anything that snapshots `DATA_PORTAL_URL` at module-load time reads
 * the environment before dotenv has populated it. Lazy resolution is the only
 * correct shape here, and this test fails if it is lost.
 *
 * STATED BLIND SPOTS.
 *
 * 1. The `skill-guidance` prompt body is excluded from the foreign-vocabulary
 *    assertion. Its text comes from `src/skills/*.ts`, which are GENERATED from
 *    `civic-ai-tools/docs/skills/*.md` and are never hand-edited here (see
 *    `.claude/rules/skills.md`). Those documents name several cities on
 *    purpose: they describe multi-portal capability ("NYC, Chicago, SF, Seattle,
 *    LA, and other Socrata portals"), not a default this server would be wrong
 *    about. Changing them is a PR to the hub repository, not to this one.
 * 2. It walks string *values*, not object keys.
 * 3. `tools/call` responses are not covered — those carry portal data, not
 *    advertised text.
 */

import { describe, it, expect, afterAll, beforeAll } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createServer } from '../index.js';

type PortalFixture = {
  /** What `DATA_PORTAL_URL` is set to for this run. */
  url: string;
  /** The bare host the server should be talking about. */
  domain: string;
  /**
   * Words that identify this portal's city and belong to no other row in the
   * table. When the server is configured for the *other* row, none of these may
   * appear in anything it sends.
   */
  vocabulary: string[];
};

const PORTALS: PortalFixture[] = [
  {
    url: 'https://data.cityofnewyork.us',
    domain: 'data.cityofnewyork.us',
    vocabulary: ['NYC', 'New York', 'cityofnewyork', 'NYPD', 'borough', 'Manhattan']
  },
  {
    url: 'https://data.cityofchicago.org',
    domain: 'data.cityofchicago.org',
    vocabulary: ['Chicago', 'cityofchicago', 'Illinois', 'Cook County']
  }
];

/**
 * Hostnames that legitimately appear in advertised text and are not the
 * configured portal. Empty on purpose: nothing today needs an exemption, and an
 * entry added here has to be justified in review.
 */
const NON_PORTAL_HOSTS: string[] = [];

/** A host-shaped token, restricted to TLDs an open-data portal actually uses. */
const HOST_PATTERN = /\b(?:[a-z0-9-]+\.)+(?:us|org|gov|com|io|net|edu)\b/gi;

/** Every string value reachable in a response, tagged with where it came from. */
function collectStrings(value: unknown, path: string, out: Array<{ path: string; text: string }>): void {
  if (typeof value === 'string') {
    out.push({ path, text: value });
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((item, i) => collectStrings(item, `${path}[${i}]`, out));
    return;
  }
  if (value && typeof value === 'object') {
    for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
      collectStrings(child, `${path}.${key}`, out);
    }
  }
}

type Surface = { label: string; response: unknown };

/**
 * Drives every advertised surface and returns what came back over the wire.
 * `skill-guidance` is fetched too, but returned separately so the stated
 * carve-out is visible rather than silently applied.
 */
async function readAdvertisedSurfaces(client: Client): Promise<{
  surfaces: Surface[];
  skillGuidance: unknown;
}> {
  const surfaces: Surface[] = [];

  const toolsList = await client.listTools();
  surfaces.push({ label: 'tools/list', response: toolsList });

  const promptsList = await client.listPrompts();
  surfaces.push({ label: 'prompts/list', response: promptsList });

  const resourcesList = await client.listResources();
  surfaces.push({ label: 'resources/list', response: resourcesList });

  let skillGuidance: unknown = null;
  for (const prompt of promptsList.prompts) {
    // Supply every declared argument so no body falls back to a default branch.
    const args: Record<string, string> = {};
    for (const argument of prompt.arguments ?? []) {
      args[argument.name] = `sample ${argument.name}`;
    }
    const got = await client.getPrompt({ name: prompt.name, arguments: args });
    if (prompt.name === 'skill-guidance') {
      skillGuidance = got;
    } else {
      surfaces.push({ label: `prompts/get(${prompt.name})`, response: got });
    }
  }

  // And again with no arguments at all, so the default-value branches — which
  // is where a hardcoded city hides most easily — are driven too.
  for (const prompt of promptsList.prompts) {
    if (prompt.name === 'skill-guidance') continue;
    if ((prompt.arguments ?? []).some((a) => a.required)) continue;
    const got = await client.getPrompt({ name: prompt.name });
    surfaces.push({ label: `prompts/get(${prompt.name}, defaults)`, response: got });
  }

  for (const resource of resourcesList.resources) {
    const got = await client.readResource({ uri: resource.uri });
    surfaces.push({ label: `resources/read(${resource.uri})`, response: got });
  }

  expect(surfaces.length).toBeGreaterThan(5);
  return { surfaces, skillGuidance };
}

describe('advertised text describes the configured portal', () => {
  let client: Client;
  let close: () => Promise<void>;
  const originalPortalUrl = process.env.DATA_PORTAL_URL;

  beforeAll(async () => {
    const server = await createServer();
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    client = new Client({ name: 'portal-text-guard', version: '1.0.0' }, { capabilities: {} });
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
    close = async () => {
      await client.close();
      await server.close();
    };
  });

  afterAll(async () => {
    await close?.();
    if (originalPortalUrl === undefined) {
      delete process.env.DATA_PORTAL_URL;
    } else {
      process.env.DATA_PORTAL_URL = originalPortalUrl;
    }
  });

  for (const [index, portal] of PORTALS.entries()) {
    const others = PORTALS.filter((_, i) => i !== index);

    describe(`configured for ${portal.domain}`, () => {
      let surfaces: Surface[];
      let skillGuidance: unknown;

      beforeAll(async () => {
        process.env.DATA_PORTAL_URL = portal.url;
        ({ surfaces, skillGuidance } = await readAdvertisedSurfaces(client));
      });

      it('names no other portal’s city anywhere in what it sends', () => {
        const offences: string[] = [];
        for (const surface of surfaces) {
          const strings: Array<{ path: string; text: string }> = [];
          collectStrings(surface.response, surface.label, strings);
          for (const { path, text } of strings) {
            for (const other of others) {
              for (const word of other.vocabulary) {
                if (text.toLowerCase().includes(word.toLowerCase())) {
                  offences.push(`${path}: "${word}" in ${JSON.stringify(text.slice(0, 160))}`);
                }
              }
            }
          }
        }
        expect(offences, `configured for ${portal.domain}, but:\n${offences.join('\n')}`).toEqual([]);
      });

      it('spells no portal host other than the configured one', () => {
        const offences: string[] = [];
        for (const surface of surfaces) {
          const strings: Array<{ path: string; text: string }> = [];
          collectStrings(surface.response, surface.label, strings);
          for (const { path, text } of strings) {
            for (const host of text.match(HOST_PATTERN) ?? []) {
              const found = host.toLowerCase();
              if (found === portal.domain.toLowerCase()) continue;
              if (NON_PORTAL_HOSTS.includes(found)) continue;
              offences.push(`${path}: "${host}" in ${JSON.stringify(text.slice(0, 160))}`);
            }
          }
        }
        expect(offences, `configured for ${portal.domain}, but:\n${offences.join('\n')}`).toEqual([]);
      });

      it('says which portal it is configured for on every surface a model reads', () => {
        const missing: string[] = [];
        // tools/list, every prompt body and the two prose resources have to name
        // the portal — scrubbing the city out without naming the real one would
        // otherwise pass the two assertions above.
        for (const surface of surfaces) {
          const isPromptBody = surface.label.startsWith('prompts/get');
          const isToolsList = surface.label === 'tools/list';
          const isProseResource =
            surface.label.startsWith('resources/read') && !surface.label.includes('popular');
          if (!isPromptBody && !isToolsList && !isProseResource) continue;

          const strings: Array<{ path: string; text: string }> = [];
          collectStrings(surface.response, surface.label, strings);
          const namesPortal = strings.some(({ text }) =>
            text.toLowerCase().includes(portal.domain.toLowerCase())
          );
          if (!namesPortal) missing.push(surface.label);
        }
        expect(missing, `no mention of ${portal.domain} in:\n${missing.join('\n')}`).toEqual([]);
      });

      it('still serves the skill-guidance prompt (excluded from the assertions above)', () => {
        // Stated carve-out, not a silent one: the body is generated from the hub
        // repository's skill documents, which name several cities on purpose.
        expect(skillGuidance).toBeTruthy();
      });
    });
  }
});
