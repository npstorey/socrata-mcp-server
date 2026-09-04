#!/usr/bin/env node

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { OpenAICompatibleTransport } from './openai-compatible-transport.js';
import express from 'express';
import dotenv from 'dotenv';
import cors from 'cors';
import crypto from 'crypto';
import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  UNIFIED_SOCRATA_TOOL,
  SEARCH_TOOL,
  FETCH_TOOL,
  socrataToolZodSchema,
  searchToolZodSchema,
  fetchToolZodSchema,
  handleSearchTool,
  handleFetchTool
} from './tools/socrata-tools.js';
import { z } from 'zod';
import {
  ListToolsRequestSchema,
  CallToolRequestSchema,
  InitializeRequestSchema,
  ListPromptsRequestSchema,
  ListResourcesRequestSchema,
  ReadResourceRequestSchema,
  GetPromptRequestSchema,
  type InitializeResult
} from '@modelcontextprotocol/sdk/types.js';
import { McpError, ErrorCode } from './utils/mcp-errors.js';
import { composeSkillGuidance } from './skills/compose.js';
import { getDefaultDomain } from './utils/portal-config.js';

// NOTE(#47): the prompts/resources request schemas were previously hand-rolled
// here behind a comment claiming they were "not properly exported from SDK".
// They are exported (and were at 1.15.x too); the local copies were also what
// blew up zod type inference (TS2589) once the `any`-typed SDK shim was
// removed. Import the SDK's own schemas instead.

dotenv.config();

/**
 * Advertised identifiers that used to name one city.
 *
 * These are the names and URIs a client addresses, not prose, so they are
 * versioned rather than interpolated: a URI that changed with `DATA_PORTAL_URL`
 * would not be an identifier at all. The pre-rename forms are still accepted so
 * a client that hardcoded one keeps working; they are simply never advertised.
 * Measured before renaming: nothing in this repository, the hub repository or
 * the website addresses them — the only consumers were this file.
 */
const RESOURCE_URIS = {
  portalOverview: 'data://portal/info/portal-overview',
  popularDatasets: 'data://portal/info/popular-datasets',
  apiGuide: 'data://portal/info/api-guide'
} as const;

const LEGACY_RESOURCE_URI_PREFIX = 'data://nyc/info/';

/** Maps a pre-rename resource URI onto its current one; passes anything else through. */
function resolveResourceUri(uri: string): string {
  return uri.startsWith(LEGACY_RESOURCE_URI_PREFIX)
    ? `data://portal/info/${uri.slice(LEGACY_RESOURCE_URI_PREFIX.length)}`
    : uri;
}

const ANALYZE_PROMPT = 'analyze_open_data';
const ANALYZE_PROMPT_LEGACY_NAME = 'analyze_nyc_data';

/**
 * Builds a Server with every tool/prompt/resource handler registered.
 *
 * Exported so a test can drive the real handlers over an in-memory transport
 * rather than rebuilding a look-alike server of its own. Before this export
 * existed, every "integration" test in `src/__tests__` constructed its own
 * `McpServer` with its own titles and descriptions, so nothing in the suite
 * ever read what this file actually returns.
 */
export async function createServer(transport?: OpenAICompatibleTransport): Promise<Server> {
  console.error('[Server] Creating Server instance...');
  
  const server = new Server(
    { name: 'socrata-mcp-server', version: '0.1.5' },
    {
      capabilities: {
        tools: {},
        prompts: {},
        resources: { subscribe: false, listChanged: true },
        // NOTE(#47): `roots` and `sampling` were previously declared here.
        // They are CLIENT capabilities (this server implements neither), and
        // 1.30.0's ServerCapabilities type rejects them - the de-shimmed
        // compiler surfaced the false advertisement (scoping report §3.4 on
        // civic-ai-tools#131). Wire-invisible removal: the initialize response
        // clients actually see is built by the hand-rolled handler below.
        experimental: {
          // Experimental capability values are objects, not booleans
          // (ServerCapabilities.experimental: Record<string, object>).
          elicit: {}
        }
      }
      // NOTE(#47): a former `authMethods: []` option was removed here. It has
      // never been part of the SDK's ServerOptions at any 1.x version (zero
      // occurrences in the SDK's types or runtime) - it was silently ignored.
      // This server requires no auth; see the /.well-known handlers in
      // startApp() for the explicit no-auth signal.
    }
  );
  
  // Track transport type for modality inference in GetPrompt
  const isHttpTransport = !!transport;

  // Store transport reference on server for initialize handler
  if (transport) {
    (server as any)._customTransport = transport;
  }

  // Wrap setRequestHandler to log all registrations and calls
  const originalSetRequestHandler = server.setRequestHandler.bind(server);
  server.setRequestHandler = function(schema: any, handler: any) {
    console.error('[Server] Registering handler for schema:', schema);
    return originalSetRequestHandler(schema, async (request: any, ...args: any[]) => {
      console.error('[Server] Handler called with request:', JSON.stringify(request, null, 2));
      try {
        const result = await handler(request, ...args);
        console.error('[Server] Handler returned:', JSON.stringify(result, null, 2));
        return result;
      } catch (error) {
        console.error('[Server] Handler error:', error);
        throw error;
      }
    });
  };

  // Handle Initialize - OpenAI sends this first
  try {
    server.setRequestHandler(InitializeRequestSchema, async (request) => {
      console.error('[Server - Initialize] Request received:', JSON.stringify(request, null, 2));
      const protocolVersion = request.params.protocolVersion || '2025-01-01';
      
      // Try to get session ID from the custom transport
      let sessionId: string | undefined;
      
      if ((server as any)._customTransport) {
        // The transport should have the sessionId available after initialization
        const transport = (server as any)._customTransport;
        console.error('[Server - Initialize] Checking transport for session ID');
        
        // The SDK's StreamableHTTPServerTransport will have sessionId property after initialization
        if ((transport as any).sessionId) {
          sessionId = (transport as any).sessionId;
          console.error('[Server - Initialize] Found sessionId on transport:', sessionId);
        } else {
          // Log available properties for debugging
          console.error('[Server - Initialize] Transport properties:', Object.getOwnPropertyNames(transport));
          console.error('[Server - Initialize] Transport prototype:', Object.getOwnPropertyNames(Object.getPrototypeOf(transport)));
          
          // Check parent class properties
          const parentProto = Object.getPrototypeOf(Object.getPrototypeOf(transport));
          if (parentProto) {
            console.error('[Server - Initialize] Parent prototype properties:', Object.getOwnPropertyNames(parentProto));
          }
        }
      }
      
      // InitializeResult plus the non-standard sessionId this server has always
      // echoed in the body for the OpenAI-connector handshake (Result schemas
      // are passthrough, so the extra member is wire-legal).
      // NOTE(#47): earlier revisions decorated each capability with an invented
      // `supported: true` member (an OpenAI-connector-era artifact; `supported`
      // exists at no MCP spec revision - capability PRESENCE is the signal).
      // 1.30.0's strict ServerCapabilities type rejects it; the response now
      // matches the constructor's declared capabilities above, which is what
      // the SDK's own initialize handler would have sent.
      const response: InitializeResult & { sessionId?: string } = {
        protocolVersion: protocolVersion,
        capabilities: {
          tools: {},
          prompts: {},
          resources: { subscribe: false, listChanged: true },
          logging: {},
          experimental: {
            elicit: {}
          }
        },
        serverInfo: {
          name: 'socrata-mcp-server',
          version: '0.1.5'
        }
      };
      
      // Add sessionId to response if we have it
      if (sessionId) {
        console.error('[Server - Initialize] Adding sessionId to response body:', sessionId);
        response.sessionId = sessionId;
      } else {
        console.error('[Server - Initialize] No sessionId available to add to response body');
      }
      
      return response;
    });
  } catch (e) {
    console.error('[Server] Could not register initialize handler:', e);
  }

  // Handle ListTools
  server.setRequestHandler(ListToolsRequestSchema, async (request) => {
    console.error('[Server - ListTools] Request received');
    
    const tools = [
      {
        name: 'get_data',
        title: 'Unified Socrata Access',
        description: UNIFIED_SOCRATA_TOOL.description,
        inputSchema: UNIFIED_SOCRATA_TOOL.inputSchema
      },
      {
        name: 'search',
        // Read the title from the tool definition rather than re-declaring it.
        // Two literals here named a portal this server may not be serving, and
        // they could drift from socrata-tools.ts without anything noticing.
        title: SEARCH_TOOL.title,
        description: SEARCH_TOOL.description,
        inputSchema: SEARCH_TOOL.inputSchema
      },
      {
        name: 'fetch',
        title: FETCH_TOOL.title,
        description: FETCH_TOOL.description,
        inputSchema: FETCH_TOOL.inputSchema
      }
    ];
    
    console.error(`[Server - ListTools] Returning ${tools.length} tools: get_data, search, fetch`);
    
    return { tools };
  });

  // Handle ListPrompts
  server.setRequestHandler(ListPromptsRequestSchema, async (request) => {
    console.error('[Server - ListPrompts] Request received');
    
    const portalDomain = getDefaultDomain();

    const prompts = [
      {
        name: ANALYZE_PROMPT,
        title: 'Analyze Open Data',
        description: `Search and analyze datasets from the open data portal this server is configured for (${portalDomain})`,
        arguments: [
          {
            name: 'topic',
            description: 'The topic or dataset to analyze (e.g., "crime statistics", "restaurant inspections", "311 complaints")',
            required: true
          },
          {
            name: 'time_period',
            description: 'Time period for the analysis (e.g., "last month", "2023", "past 5 years")',
            required: false
          }
        ]
      },
      {
        name: 'find_dataset',
        title: 'Find a Dataset',
        description: `Help find specific datasets on the open data portal this server is configured for (${portalDomain})`,
        arguments: [
          {
            name: 'description',
            description: 'Description of the data you are looking for',
            required: true
          }
        ]
      },
      {
        name: 'compare_neighborhoods',
        title: 'Compare Neighborhoods',
        description: `Compare data across neighborhoods or districts on the open data portal this server is configured for (${portalDomain})`,
        arguments: [
          {
            name: 'metric',
            description: 'What metric to compare (e.g., "crime rates", "air quality", "noise complaints")',
            required: true
          },
          {
            name: 'neighborhoods',
            // "boroughs" is one city's subdivision vocabulary; whatever this
            // portal calls its areas is the caller's to supply.
            description: 'Which neighborhoods or districts to compare (comma-separated)',
            required: true
          }
        ]
      },
      {
        name: 'skill-guidance',
        title: 'Socrata Query Skill Guidance',
        description: 'Socrata query skill guidance composed for your context (web or local)',
        arguments: [
          {
            name: 'modality',
            description: 'web or local — if omitted, inferred from transport (HTTP → web, stdio → local)',
            required: false
          }
        ]
      }
    ];
    
    console.error(`[Server - ListPrompts] Returning ${prompts.length} prompts`);
    
    return {
      prompts
    };
  });

  // Handle GetPrompt
  server.setRequestHandler(GetPromptRequestSchema, async (request) => {
    const promptName = request.params.name;
    const args = request.params.arguments;
    console.error(`[Server - GetPrompt] Request for prompt: ${promptName}, args:`, args);

    if (promptName === 'skill-guidance') {
      // Determine modality: explicit arg > transport inference
      const modality = args?.modality || (isHttpTransport ? 'web' : 'local');
      const composition = composeSkillGuidance(modality, process.env.SKILL_POSTURE);
      if (composition.warning) {
        console.error(`[Server - GetPrompt] ${composition.warning}`);
      }
      console.error(`[Server - GetPrompt] Composing skill-guidance with modality: ${modality}, posture: ${composition.postureDecision}`);

      return {
        description: `Socrata query skill guidance (${modality} mode${composition.postureApplied ? ', reference-demo posture' : ''})`,
        messages: [
          {
            role: 'user' as const,
            content: {
              type: 'text' as const,
              text: composition.text
            }
          }
        ]
      };
    }

    if (promptName === ANALYZE_PROMPT || promptName === ANALYZE_PROMPT_LEGACY_NAME) {
      const portalDomain = getDefaultDomain();
      const topic = args?.topic || 'general open data';
      const timePeriod = args?.time_period ? ` for ${args.time_period}` : '';
      return {
        description: `Analyze ${topic} from ${portalDomain}`,
        messages: [
          {
            role: 'user' as const,
            content: {
              type: 'text' as const,
              text: `Search and analyze datasets about "${topic}"${timePeriod} on the open data portal this server is configured for (${portalDomain}). Use the get_data tool to discover relevant datasets and run SoQL queries. Provide key findings with data tables and methodology.`
            }
          }
        ]
      };
    }

    if (promptName === 'find_dataset') {
      const portalDomain = getDefaultDomain();
      const description = args?.description || 'data';
      return {
        description: `Find datasets on ${portalDomain} matching: ${description}`,
        messages: [
          {
            role: 'user' as const,
            content: {
              type: 'text' as const,
              text: `Help me find datasets on the open data portal this server is configured for (${portalDomain}) that match this description: "${description}". Use the search tool to find relevant datasets and provide their names, IDs, and descriptions.`
            }
          }
        ]
      };
    }

    if (promptName === 'compare_neighborhoods') {
      const portalDomain = getDefaultDomain();
      const metric = args?.metric || 'data';
      const neighborhoods = args?.neighborhoods || 'all areas the portal reports on';
      return {
        description: `Compare ${metric} across ${neighborhoods}`,
        messages: [
          {
            role: 'user' as const,
            content: {
              type: 'text' as const,
              text: `Compare ${metric} across these neighborhoods or districts: ${neighborhoods}. Use the open data portal this server is configured for (${portalDomain}) to find relevant datasets and run comparative queries. Present findings in a comparison table.`
            }
          }
        ]
      };
    }

    throw new Error(`Prompt not found: ${promptName}`);
  });

  // Handle ListResources
  server.setRequestHandler(ListResourcesRequestSchema, async (request) => {
    console.error('[Server - ListResources] Request received');
    
    const portalDomain = getDefaultDomain();

    const resources = [
      {
        uri: RESOURCE_URIS.portalOverview,
        name: 'Open Data Portal Overview',
        title: `${portalDomain} Portal Overview`,
        description: `What the portal this server is configured for (${portalDomain}) offers, and how to explore it from here`,
        mimeType: 'text/plain'
      },
      {
        uri: RESOURCE_URIS.popularDatasets,
        name: 'Finding Popular Datasets',
        title: `How to Find Popular Datasets on ${portalDomain}`,
        // Was a hardcoded list of five datasets from one city, which is false on
        // any other portal and goes stale on that one. What is actually popular
        // is a property of the portal, so this resource says how to ask it.
        description: `How to find the most-used datasets on the portal this server is configured for (${portalDomain})`,
        mimeType: 'text/markdown'
      },
      {
        uri: RESOURCE_URIS.apiGuide,
        name: 'Socrata API Guide',
        title: 'Quick Guide to Socrata API',
        description: `Quick reference for using the Socrata API against ${portalDomain}`,
        mimeType: 'text/markdown'
      }
    ];
    
    console.error(`[Server - ListResources] Returning ${resources.length} resources`);
    
    return {
      resources,
      nextCursor: undefined
    };
  });

  // Handle ReadResource
  server.setRequestHandler(ReadResourceRequestSchema, async (request) => {
    console.error('[Server - ReadResource] Request received for URI:', request.params.uri);
    
    const portalDomain = getDefaultDomain();

    const resourceContents: Record<string, any> = {
      [RESOURCE_URIS.portalOverview]: {
        uri: RESOURCE_URIS.portalOverview,
        name: 'Open Data Portal Overview',
        mimeType: 'text/plain',
        // The dataset count, the publishing agencies and the category list this
        // text used to assert were one city's, stated as fact. What a portal
        // holds is the portal's property; ask it rather than assert it.
        text: `Open Data Portal Overview

This server is configured for the Socrata open data portal at ${portalDomain}.
Any tool call that does not pass an explicit "domain" argument runs against
that portal.

What a Socrata portal provides:
- A catalog of datasets published by the organizations behind the portal
- Dataset metadata (columns, types, update cadence) alongside the records
- Free, key-less read access over the Socrata API
- Several response formats on the underlying API (JSON, CSV, GeoJSON)

How to explore it from here:
- search — full-text search over the catalog; returns dataset IDs
- fetch — retrieve a dataset's metadata, or a record, by identifier
- get_data with type "catalog" — browse or filter the catalog
- get_data with type "metadata" — inspect one dataset's columns
- get_data with type "query" — run a SoQL query against a dataset
- get_data with type "metrics" — usage metrics for a dataset

Which datasets exist on ${portalDomain}, how many there are, and which
organizations publish them are properties of that portal. Ask it with search or
the catalog rather than assuming a list.`
      },
      [RESOURCE_URIS.popularDatasets]: {
        uri: RESOURCE_URIS.popularDatasets,
        name: 'Finding Popular Datasets',
        mimeType: 'text/markdown',
        // This was a hardcoded snapshot of five datasets from one city, served
        // as application/json under a title naming that city's portal. It could
        // not be made true for another portal by interpolating a domain: the
        // dataset IDs, the names and the publishing agencies were all one
        // portal's. Deriving the list live from the catalog would put a network
        // call inside resources/read and a new failure mode with it, so the
        // resource now answers the same question by pointing at the tools that
        // can actually answer it. Making it live is a follow-up, not a text fix.
        text: `# Finding the most-used datasets on ${portalDomain}

This server ships no curated list of popular datasets. Which datasets are most
used is a property of ${portalDomain} and it changes over time, so a list baked
into the server would go stale here and would be wrong on any other portal.

Ask the portal instead:

- \`get_data\` with \`type: "catalog"\` and a \`query\` returns catalog entries
  matching a search phrase, most relevant first.
- \`get_data\` with \`type: "metrics"\` and a \`dataset_id\` returns that
  dataset's usage metrics.
- \`search\` returns dataset IDs for a full-text query; \`fetch\` retrieves one
  by identifier.

A reasonable sequence: \`search\` for the topic, then \`get_data\` with
\`type: "metrics"\` on the candidates to compare how heavily each is used.`
      },
      [RESOURCE_URIS.apiGuide]: {
        uri: RESOURCE_URIS.apiGuide,
        name: 'Socrata API Guide',
        mimeType: 'text/markdown',
        text: `# Socrata API Quick Guide

## Basic API Structure
\`\`\`
https://${portalDomain}/resource/{dataset-id}.{format}
\`\`\`

## Common Parameters
- **$limit**: Number of results to return (default: 1000, max: 50000)
- **$offset**: Number of results to skip for pagination
- **$where**: SoQL WHERE clause for filtering
- **$select**: Choose specific columns to return
- **$order**: Sort results by field(s)
- **$q**: Full-text search query

## Example Queries

### Get first 10 records
\`\`\`
/resource/dataset-id.json?$limit=10
\`\`\`

### Filter with WHERE clause
\`\`\`
/resource/dataset-id.json?$where=status='Open' AND year=2023
\`\`\`

### Full-text search
\`\`\`
/resource/dataset-id.json?$q=restaurant
\`\`\`

### Select specific fields
\`\`\`
/resource/dataset-id.json?$select=name,address,grade&$limit=100
\`\`\`

## SoQL Functions
- **upper()**, **lower()**: Change case
- **starts_with()**, **contains()**: String matching
- **within_box()**, **within_circle()**: Geospatial queries
- **date_trunc_y()**, **date_trunc_m()**: Date truncation

## Rate Limits
- No API key required for basic access
- With API key: Higher rate limits available
- Consider using pagination for large datasets`
      }
    };
    
    const content = resourceContents[resolveResourceUri(request.params.uri)];
    if (!content) {
      throw new Error(`Resource not found: ${request.params.uri}`);
    }

    console.error('[Server - ReadResource] Returning content for:', request.params.uri);
    
    return {
      contents: [content]
    };
  });

  // Handle CallTool
  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    console.error('[Server] CallTool request:', JSON.stringify(request, null, 2));
    
    if (!request.params || typeof request.params !== 'object') {
      throw new Error('Invalid params: missing params object');
    }

    const toolName = request.params.name;
    const toolArgs = request.params.arguments;

  // Handle search tool
    if (toolName === 'search') {
      try {
        console.error(`[Server] Calling search tool with args:`, JSON.stringify(toolArgs, null, 2));
        
        const parsed = searchToolZodSchema.parse(toolArgs);
        console.error(`[Server] Parsed search params:`, JSON.stringify(parsed, null, 2));
        
        const result = await handleSearchTool(parsed);
        console.error('[Tool] Search result:', JSON.stringify(result, null, 2));
        
        return {
          content: result.content,
          isError: false
        };
      } catch (error) {
        console.error('[Tool] Search error:', error);
        if (error instanceof z.ZodError) {
          console.error('[Server] ZodError issues:', JSON.stringify(error.issues, null, 2));
        }
        throw error;
      }
    }
    
  // Handle fetch tool
  if (toolName === 'fetch') {
    try {
      console.error(`[Server] Calling fetch tool with args:`, JSON.stringify(toolArgs, null, 2));
      
      const parsed = fetchToolZodSchema.parse(toolArgs);
      console.error(`[Server] Parsed fetch params:`, JSON.stringify(parsed, null, 2));
      
      const result = await handleFetchTool(parsed);
      console.error('[Tool] Fetch result:', JSON.stringify(result, null, 2));
      return {
        content: result.content,
        isError: false
      };
    } catch (error) {
      console.error('[Tool] Document retrieval error:', error);
      if (error instanceof z.ZodError) {
        console.error('[Server] ZodError issues:', JSON.stringify(error.issues, null, 2));
      }
      throw error;
    }
  }
    
    // Handle original get_data tool for backward compatibility
    if (toolName === UNIFIED_SOCRATA_TOOL.name) {
      try {
        console.error(`[Server] Calling tool: ${toolName} with args:`, JSON.stringify(toolArgs, null, 2));
        
        const parsed = socrataToolZodSchema.parse(toolArgs);
        console.error(`[Server] Parsed Socrata params:`, JSON.stringify(parsed, null, 2));
        
        const handler = UNIFIED_SOCRATA_TOOL.handler;
        if (typeof handler !== 'function') {
          throw new Error('Tool handler is not a function');
        }
        
        const result = await handler(parsed);
        console.error('[Tool] Result:', JSON.stringify(result, null, 2));
        
        let responseText: string;
        if (result === null || result === undefined) {
          responseText = String(result);
        } else if (typeof result === 'string') {
          responseText = result;
        } else if (typeof result === 'number' || typeof result === 'boolean') {
          responseText = result.toString();
        } else {
          responseText = JSON.stringify(result, null, 2);
        }
        
        return {
          content: [{ type: 'text', text: responseText }],
          isError: false
        };
      } catch (error) {
        console.error('[Tool] Error:', error);
        if (error instanceof z.ZodError) {
          console.error('[Server] ZodError issues:', JSON.stringify(error.issues, null, 2));
        }
        throw error;
      }
    } else {
      throw new Error(`Method not found: ${toolName}`);
    }
  });

  console.error('[Server] Server instance created and request handlers registered.');
  return server;
}

// Global map to store transports by session ID
const transports: Map<string, { transport: OpenAICompatibleTransport, server: Server, cleanup: () => Promise<void> }> = new Map();

async function startApp() {
  try {
    const app = express();
    const port = Number(process.env.PORT) || 8000;
    
    console.error('[Environment] DATA_PORTAL_URL:', process.env.DATA_PORTAL_URL);
    
    // IMPORTANT: NO express.json() before /mcp route!
    
    // CORS configuration
    app.use(cors({
      origin: true,
      credentials: true,
      exposedHeaders: ['mcp-session-id']
    }));

    const mcpPath = '/mcp';
    
    // Accept-header shim for OpenAI connector - CRITICAL!
    app.use(mcpPath, (req, _res, next) => {
      const h = req.headers.accept ?? '';
      if (!h.includes('text/event-stream')) {
        req.headers.accept = h ? `${h}, text/event-stream` : 'text/event-stream';
      }
      next();
    });

    // Body parser for /mcp route - parse all content types as text to avoid stream consumption issues
    app.use(mcpPath, express.text({ type: '*/*' }));

    // Health check
    app.get('/healthz', (_req, res) => {
      console.error('[Health] /healthz hit');
      res.sendStatus(200);
    });

    // Root endpoint
    app.get('/', (_req, res) => {
      res.send('Socrata MCP Server running');
    });
    
    // Debug endpoint to test server
    app.get('/debug', async (_req, res) => {
      console.error('[Debug] Testing server state...');
      res.json({
        server: 'running',
        activeSessions: transports.size,
        sessions: Array.from(transports.keys()).filter(k => k !== '__pending__'),
        environment: {
          DATA_PORTAL_URL: process.env.DATA_PORTAL_URL
        }
      });
    });

    // --- Honest no-auth signal (#47; #44's dead "Authenticate" button) ---
    // This server requires no authentication. MCP (2025-03-26 through
    // 2025-11-25) has no positive "no auth required" advertisement; the spec's
    // signal is absence: a server that never returns 401 and serves no
    // RFC 9728 protected-resource metadata is unauthenticated. The SDK client
    // enters its OAuth flow only on HTTP 401 (1.30.0 client/streamableHttp.js
    // handles `response.status === 401`; client/auth.js drives discovery),
    // and this server never sends one. The dead "Authenticate" button issue
    // #44 records is client-side recovery UX after a failed connect - no
    // server response can suppress it at the v1 SDK level; the protocol-
    // ceiling bump removes the failure that triggered it.
    //
    // What can be made honest server-side: clients probing the OAuth
    // discovery surface used to receive Express's HTML "Cannot GET/POST"
    // pages ("Invalid OAuth error response ... <pre>Cannot POST /register</pre>"
    // in #44's log). Answer those probes precisely instead: 404 - the correct
    // "not a protected resource" signal - with an RFC 6749-shaped JSON error
    // body stating that no auth exists here. Paths cover the 1.30.0 client's
    // discovery ladder incl. its path-inserted/appended variants (RFC 9728
    // protected-resource metadata, RFC 8414 authorization-server metadata,
    // OIDC discovery, RFC 7591 dynamic client registration).
    const noAuthProbePaths = [
      '/.well-known/oauth-protected-resource',
      '/.well-known/oauth-authorization-server',
      '/.well-known/openid-configuration',
      '/mcp/.well-known', // OIDC Discovery 1.0 style: appended after the resource path
      '/register'
    ];
    for (const probePath of noAuthProbePaths) {
      app.use(probePath, (_req, res) => {
        res.status(404).json({
          error: 'invalid_request',
          error_description:
            'This MCP server does not require authentication. There is no OAuth authorization server, protected-resource metadata, or client registration endpoint; connect without credentials.'
        });
      });
    }

    // Remove old global transport creation - we'll create per-session instead
    // Helper function to create and setup a new transport/server pair
    async function createTransportAndServer(sessionId?: string) {
      console.error('[MCP] Creating new transport/server pair', sessionId ? `for session ${sessionId}` : 'for initialization');
      
      const transport = new OpenAICompatibleTransport({
        sessionIdGenerator: () => {
          const newSessionId = crypto.randomBytes(16).toString('hex');
          console.error('[Transport] sessionIdGenerator called! Generated:', newSessionId);
          return newSessionId;
        },
        // Pass callbacks in constructor options
        onsessioninitialized: (initializedSessionId: string) => {
          console.error('[Transport] onsessioninitialized fired! Session:', initializedSessionId);
          // Store the transport in our map when session is initialized
          if (!transports.has(initializedSessionId)) {
            console.error('[Transport] Storing transport for session:', initializedSessionId);
            // Transport and server are already created, just need to store the reference
            const entry = transports.get('__pending__');
            if (entry) {
              transports.delete('__pending__');
              transports.set(initializedSessionId, entry);
            }
          }
        },
        onsessionclosed: (closedSessionId: string) => {
          console.error('[Transport] onsessionclosed fired! Session:', closedSessionId);
          // Clean up transport from map
          if (transports.has(closedSessionId)) {
            console.error('[Transport] Removing transport for closed session:', closedSessionId);
            const entry = transports.get(closedSessionId);
            if (entry) {
              entry.cleanup().catch(err => console.error('[Transport] Error during cleanup:', err));
            }
            transports.delete(closedSessionId);
          }
        }
      });
      
      // Setup transport event handlers
      transport.onmessage = (message: any, extra?: any) => {
        console.error('[Transport] onmessage fired!', JSON.stringify(message, null, 2));
        if (extra) {
          console.error('[Transport] onmessage extra:', JSON.stringify(extra, null, 2));
        }
      };

      transport.onerror = (error: any) => {
        console.error('[Transport] onerror fired! Error:', error);
      };

      transport.onclose = () => {
        console.error('[Transport] onclose fired!');
      };
      
      // Wrap handleRequest to see what's happening
      const originalHandleRequest = transport.handleRequest.bind(transport);
      transport.handleRequest = async (req: any, res: any) => {
        console.error('[Transport.handleRequest] Called');
        console.error('[Transport.handleRequest] Method:', req.method);
        console.error('[Transport.handleRequest] URL:', req.url);
        console.error('[Transport.handleRequest] Session ID:', (transport as any).sessionId);
        console.error('[Transport.handleRequest] Transport internal state:', {
          hasServer: !!(transport as any)._server,
          hasSession: !!(transport as any)._session,
          serverInfo: (transport as any)._server ? {
            name: (transport as any)._server.name,
            connected: true
          } : null
        });
        
        try {
          // The SDK's handleRequest actually accepts a third parameter for parsed body
          const body = (req as any).body;
          const result = await (originalHandleRequest as any)(req, res, body);
          console.error('[Transport.handleRequest] Completed, result:', result);
          return result;
        } catch (error) {
          console.error('[Transport.handleRequest] Error:', error);
          throw error;
        }
      };
      
      // Create server (passing transport so initialize handler can access session ID)
      const server = await createServer(transport);
      
      // Connect server to transport
      console.error('[MCP] Connecting server to transport...');
      await server.connect(transport);
      console.error('[MCP] Server connected');
      
      // Create cleanup function
      const cleanup = async () => {
        console.error('[Cleanup] Cleaning up transport and server');
        try {
          if ('close' in server && typeof (server as any).close === 'function') {
            await (server as any).close();
          }
          await transport.close();
        } catch (error) {
          console.error('[Cleanup] Error during cleanup:', error);
        }
      };
      
      return { transport, server, cleanup };
    }

    // Track response timestamps by session for timing analysis
    const lastResponseTimestamps: Map<string, { method: string, timestamp: number }> = new Map();
    
    // MCP endpoint
    app.all(mcpPath, async (req, res) => {
      // Track request timing
      const requestStartTime = Date.now();
      const sessionId = req.headers['mcp-session-id'] as string;
      
      // Log timing between requests
      if (sessionId && lastResponseTimestamps.has(sessionId)) {
        const lastResponse = lastResponseTimestamps.get(sessionId)!;
        const timeSinceLastResponse = requestStartTime - lastResponse.timestamp;
        console.error(`[Express] Time since last ${lastResponse.method} response: ${timeSinceLastResponse}ms`);
        
        // Special logging for DELETE after tools/list
        if (req.method === 'DELETE' && lastResponse.method === 'tools/list') {
          console.error(`[Express] ⚠️  DELETE request received ${timeSinceLastResponse}ms after tools/list response`);
        }
      }
      
      console.error(`[Express] ${req.method} ${req.url}`);
      console.error('[Express] Request timestamp:', new Date().toISOString());
      console.error('[Express] Headers:', {
        'accept': req.headers.accept,
        'content-type': req.headers['content-type'],
        'mcp-session-id': req.headers['mcp-session-id'],
        'mcp-protocol-version': req.headers['mcp-protocol-version'],
        'x-session-id': req.headers['x-session-id'],
        'user-agent': req.headers['user-agent']
      });
      
      // Log all MCP-related headers
      const mcpHeaders = Object.entries(req.headers)
        .filter(([key]) => key.toLowerCase().startsWith('mcp-'))
        .reduce((acc, [key, value]) => ({ ...acc, [key]: value }), {});
      if (Object.keys(mcpHeaders).length > 0) {
        console.error('[Express] All MCP headers:', mcpHeaders);
      }
      
      // Track current request body for response interceptors
      let currentRequestBody: any = null;
      let protocolVersion: string | undefined = undefined;
      
      // For POST requests, log parsed body (now available via Express body parser)
      if (req.method === 'POST' && req.body) {
        console.error('[Express] Request body:', req.body);
        currentRequestBody = req.body;
        
        // Check if this is an initialize request without a session ID
        try {
          const parsed = JSON.parse(req.body);
          if (parsed.method === 'initialize') {
            protocolVersion = parsed.params?.protocolVersion;
            console.error('[Express] Initialize request detected:');
            console.error('  - Protocol version:', protocolVersion);
            console.error('  - Has session ID:', !!req.headers['mcp-session-id']);
            console.error('  - Client:', parsed.params?.clientInfo?.name);
            if (!req.headers['mcp-session-id']) {
              console.error('[Express] Initialize request without session ID detected - this is expected for first request');
            }
          }
        } catch (e) {
          // Ignore parse errors
        }
      }
      
      // Determine which transport to use
      let transportEntry: { transport: OpenAICompatibleTransport, server: Server, cleanup: () => Promise<void> } | undefined;
      let existingSessionId = req.headers['mcp-session-id'] as string | undefined;
      
      // Check if this is an initialization request
      let isInitializeRequest = false;
      if (req.method === 'POST' && currentRequestBody) {
        try {
          const parsed = JSON.parse(currentRequestBody);
          isInitializeRequest = parsed.method === 'initialize';
        } catch (e) {
          // Ignore parse errors
        }
      }
      
      if (existingSessionId && transports.has(existingSessionId)) {
        // Use existing transport for this session
        transportEntry = transports.get(existingSessionId);
        console.error('[Express] Using existing transport for session:', existingSessionId);
      } else if (!existingSessionId && isInitializeRequest) {
        // Create new transport for initialization request
        console.error('[Express] Creating new transport for initialization request');
        transportEntry = await createTransportAndServer();
        // Temporarily store with pending key until session ID is assigned
        transports.set('__pending__', transportEntry);
      } else {
        // No valid session and not an initialization request
        console.error('[Express] No valid session ID and not an initialization request');
        res.status(400).json({
          jsonrpc: '2.0',
          error: {
            code: -32000,
            message: 'Bad Request: No valid session ID provided',
          },
          id: null
        });
        return;
      }
      
      if (!transportEntry) {
        console.error('[Express] Failed to get or create transport!');
        res.status(503).send('Service Unavailable');
        return;
      }
      
      const transport = transportEntry.transport;
      
      // Log response events
      const originalEnd = res.end;
      const originalWrite = res.write;
      const originalSetHeader = res.setHeader;
      const originalJson = res.json;
      
      // Helper function to ensure proper SSE formatting
      const formatSSEMessage = (data: string): string => {
        // Ensure proper SSE format with double newline at the end
        if (!data.endsWith('\n\n')) {
          if (!data.endsWith('\n')) {
            return data + '\n\n';
          }
          return data + '\n';
        }
        return data;
      };
      
      // Track if we're writing an initialize response
      let isInitializeResponse = false;
      
      res.setHeader = function(name: string, value: any) {
        console.error(`[Express] Response.setHeader: ${name} = ${value}`);
        
        // If setting up SSE, add keep-alive
        if (name.toLowerCase() === 'content-type' && value === 'text/event-stream') {
          console.error('[Express] SSE stream detected, setting up keep-alive');
          
          // Send a comment every 30 seconds to keep the connection alive
          const keepAliveInterval = setInterval(() => {
            try {
              res.write(': keep-alive\n\n');
              console.error('[Express] Sent SSE keep-alive comment');
            } catch (err) {
              console.error('[Express] Failed to send keep-alive:', err);
              clearInterval(keepAliveInterval);
            }
          }, 30000);
          
          // Clean up interval when response ends
          const cleanup = () => {
            if (keepAliveInterval) {
              clearInterval(keepAliveInterval);
              console.error('[Express] Cleaned up SSE keep-alive interval');
            }
          };
          
          res.on('close', cleanup);
          res.on('finish', cleanup);
          res.on('error', cleanup);
        }
        
        return originalSetHeader.call(this, name, value);
      };
      
      res.json = function(data: any) {
        console.error('[Express] Response.json:', JSON.stringify(data, null, 2));
        
        // If this is an initialize response, ensure we're sending the session ID
        if (data && data.result && !data.error) {
          const sessionId = res.getHeader('mcp-session-id');
          if (sessionId) {
            console.error('[Express] Initialize response includes session ID in header:', sessionId);
          }
        }
        
        return originalJson.call(this, data);
      };
      
      res.write = function(chunk: any, encoding?: any, callback?: any) {
        console.error('[Express] Response.write called, data length:', chunk ? chunk.length : 0);
        
        // Enhanced logging with response metadata
        console.error('[Express] Response metadata:', {
          timestamp: new Date().toISOString(),
          sessionId: res.getHeader('mcp-session-id'),
          contentType: res.getHeader('Content-Type'),
          method: currentRequestBody ? (typeof currentRequestBody === 'string' ? JSON.parse(currentRequestBody).method : currentRequestBody.method) : 'unknown'
        });
        
        if (chunk) {
          const chunkStr = chunk.toString();
          
          // Log raw data with increased limit (2000 bytes)
          if (chunk.length < 2000) {
            console.error('[Express] Response.write data:', chunkStr);
          } else {
            console.error('[Express] Response.write data (truncated):', chunkStr.substring(0, 2000) + '... [TRUNCATED]');
          }
          
          // Parse SSE data for structured logging
          if (chunkStr.includes('event:') && chunkStr.includes('data:')) {
            try {
              const dataMatch = chunkStr.match(/data:\s*(.+?)(?:\n\n|$)/s);
              if (dataMatch) {
                const jsonData = JSON.parse(dataMatch[1]);
                console.error('[Express] SSE JSON payload:', JSON.stringify(jsonData, null, 2));
                
                // Log specific information based on response type
                if (jsonData.result && jsonData.result.tools) {
                  console.error('[Express] Tools count:', jsonData.result.tools.length);
                  jsonData.result.tools.forEach((tool: any, index: number) => {
                    console.error(`[Express] Tool[${index}]:`, {
                      name: tool.name,
                      hasInputSchema: !!tool.inputSchema,
                      hasRequired: !!(tool.inputSchema && tool.inputSchema.required),
                      requiredCount: tool.inputSchema?.required?.length || 0
                    });
                  });
                }
              }
            } catch (e) {
              console.error('[Express] Failed to parse SSE JSON:', e instanceof Error ? e.message : String(e));
            }
          }
          
          // Detect initialize response
          if (currentRequestBody) {
            try {
              const parsed = JSON.parse(currentRequestBody);
              if (parsed.method === 'initialize' && chunkStr.includes('"result":') && chunkStr.includes('"protocolVersion":')) {
                isInitializeResponse = true;
                console.error('[Express] Detected initialize response');
              }
            } catch (e) {
              // Ignore parse errors
            }
          }
        }
        
        // For SSE responses, ensure proper formatting
        if (res.getHeader('Content-Type') === 'text/event-stream' && typeof chunk === 'string') {
          chunk = formatSSEMessage(chunk);
        }
        
        if (typeof encoding === 'function') {
          callback = encoding;
          encoding = undefined;
        }
        
        // Call original write and ensure data is flushed for SSE
        const result = originalWrite.call(this, chunk, encoding, callback);
        
        // Force flush for SSE to ensure Claude receives data immediately
        if (res.getHeader('Content-Type') === 'text/event-stream' && (res as any).flush) {
          (res as any).flush();
        }
        
        return result;
      };
      
      res.end = function(chunk?: any, encoding?: any, callback?: any) {
        console.error('[Express] Response.end called');
        if (chunk) {
          const preview = typeof chunk === 'string' ? chunk.substring(0, 500) : 
                          Buffer.isBuffer(chunk) ? chunk.toString().substring(0, 500) : 
                          'non-string data';
          console.error('[Express] Response.end data:', preview);
        }
        
        // Removed extra roots.listChanged event - not part of MCP spec and causes issues with OpenAI
        
        if (typeof chunk === 'function') {
          callback = chunk;
          chunk = undefined;
          encoding = undefined;
        } else if (typeof encoding === 'function') {
          callback = encoding;
          encoding = undefined;
        }
        
        // For SSE responses, add a small delay to ensure all data is transmitted
        if (res.getHeader('Content-Type') === 'text/event-stream') {
          // Flush any pending data first
          if ((res as any).flush) {
            (res as any).flush();
          }
          
          // Add a small delay before ending the response
          setTimeout(() => {
            originalEnd.call(this, chunk, encoding, callback);
          }, 10); // 10ms delay
          
          return this; // Return the response object for chaining
        }
        
        return originalEnd.call(this, chunk, encoding, callback);
      };
      
      try {
        console.error('[Express] Calling transport.handleRequest...');
        await transport.handleRequest(req, res);
        console.error('[Express] transport.handleRequest returned');
        console.error('[Express] Response headersSent:', res.headersSent);
        console.error('[Express] Response finished:', res.finished);
        
        // Handle DELETE request cleanup
        if (req.method === 'DELETE' && existingSessionId) {
          console.error('[Express] DELETE request processed, checking if session should be cleaned up');
          // The transport's onsessionclosed callback will handle cleanup
          // We just need to ensure it happens
        }
        
        // Log request completion timing and track for timing analysis
        const requestDuration = Date.now() - requestStartTime;
        console.error('[Express] Request completed in', requestDuration, 'ms');
        
        // Track response timestamp for timing analysis
        const currentSessionId = existingSessionId || (transport as any).sessionId;
        if (currentSessionId && currentRequestBody) {
          try {
            const parsed = typeof currentRequestBody === 'string' ? JSON.parse(currentRequestBody) : currentRequestBody;
            if (parsed.method) {
              lastResponseTimestamps.set(currentSessionId, {
                method: parsed.method,
                timestamp: Date.now()
              });
              console.error(`[Express] Recorded response timestamp for ${parsed.method}`);
            }
          } catch (e) {
            // Ignore parse errors
          }
        }
      } catch (error) {
        console.error('[Express] Error handling request:', error);
        if (!res.headersSent) {
          res.status(500).json({ error: 'Internal server error' });
        }
        
        // Log error timing
        const requestDuration = Date.now() - requestStartTime;
        console.error('[Express] Request failed after', requestDuration, 'ms');
      }
    });

    // Start server
    const httpServer = app.listen(port, '0.0.0.0', () => {
      console.error(`🚀 Server running on port ${port}`);
      console.error(`   Health: http://localhost:${port}/healthz`);
      console.error(`   MCP: http://localhost:${port}/mcp`);
      console.error(`   Debug: http://localhost:${port}/debug`);
      console.error('[Startup] Transports map ready');
      console.error('[Startup] Active sessions:', transports.size);
    });

    // Graceful shutdown
    const gracefulShutdown = async (signal: string) => {
      console.error(`${signal} signal received: closing resources.`);
      
      // Close all active transports
      console.error(`Closing ${transports.size} active transports...`);
      for (const [sessionId, entry] of transports) {
        if (sessionId !== '__pending__') {
          console.error(`Closing transport for session ${sessionId}...`);
          await entry.cleanup().catch((e: any) => console.error(`Error closing session ${sessionId}:`, e));
        }
      }
      transports.clear();
      
      httpServer.close(() => {
        console.error('HTTP server closed.');
        process.exit(0);
      });
    };
    
    process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
    process.on('SIGINT', () => gracefulShutdown('SIGINT'));

  } catch (error) {
    console.error('[Fatal] Error during startup:', error);
    
    // Clean up any transports that were created
    for (const [sessionId, entry] of transports) {
      if (sessionId !== '__pending__') {
        await entry.cleanup().catch((e: any) => console.error(`Error closing session ${sessionId} during fatal error:`, e));
      }
    }
    transports.clear();
    
    process.exit(1);
  }
}

/**
 * True unless this module is being imported by some other entry point.
 *
 * `createServer` is exported for tests, and importing this module used to boot
 * a transport as a side effect. The check is deliberately biased towards
 * starting: it returns true whenever the answer cannot be established (no
 * `argv[1]`, an unresolvable path), so `npm run start`, the `--stdio` bin entry
 * and the Render start command keep the behaviour they had. `realpathSync` on
 * both sides is what makes the npx/`node_modules/.bin` symlink resolve to the
 * same file as `import.meta.url`.
 */
function isProcessEntrypoint(): boolean {
  const entry = process.argv[1];
  if (!entry) return true;
  try {
    return realpathSync(entry) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return true;
  }
}

if (isProcessEntrypoint()) {
  // Check for --stdio flag to determine transport mode
  if (process.argv.includes('--stdio')) {
    // Stdio mode for Claude Code / Cursor
    (async () => {
      try {
        console.error('[Startup] Starting in stdio mode...');
        const transport = new StdioServerTransport();
        const server = await createServer();
        await server.connect(transport);
        console.error('[Startup] Server connected to stdio transport');
      } catch (error) {
        console.error('[Fatal] Error starting stdio server:', error);
        process.exit(1);
      }
    })();
  } else {
    // HTTP mode for hosted deployments (the reference deployment runs on Render)
    startApp().catch(console.error);
  }
}
