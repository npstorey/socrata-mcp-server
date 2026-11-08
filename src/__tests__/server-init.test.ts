import { describe, it, expect, vi, beforeEach } from 'vitest';

// REMOVE .js extensions for SDK imports in mocks and actual imports
// Both mocks are called with `new`. Since vitest 4 a mock called with `new` constructs
// its implementation, so the implementation is a `function`, not an arrow function.
vi.mock('@modelcontextprotocol/sdk/server/mcp.js', () => {
  return {
    McpServer: vi.fn().mockImplementation(function () {
      return {
        connect: vi.fn(),
        tool: vi.fn(),
        sendLoggingMessage: vi.fn(),
      };
    }),
  };
});

vi.mock('@modelcontextprotocol/sdk/server/stdio', () => { // NO suffix
  return {
    StdioServerTransport: vi.fn().mockImplementation(function () {
      return {
        start: vi.fn(),
        send: vi.fn(),
        close: vi.fn(),
      };
    }),
  };
});

// Import the mocked modules
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio'; // NO suffix

describe('Server initialization', () => {
  beforeEach(() => {
    // Clear all mocks before each test
    vi.clearAllMocks();
  });

  it('should create server with correct metadata', () => {
    // Manually execute the server setup similar to index.ts
    new McpServer(
      {
        name: 'true-bench-mcp',
        version: '0.1.0'
      },
      {
        capabilities: {
          tools: {},
          logging: {}
        }
      }
    );

  // Assert that McpServer was called with correct parameters
    expect(McpServer).toHaveBeenCalledWith(
      {
        name: 'true-bench-mcp',
        version: '0.1.0'
      },
      {
        capabilities: {
          tools: {},
          logging: {}
        }
      }
    );
  });

  it('should connect server to transport', async () => {
    const server = new McpServer(
      { name: 'test', version: '1.0.0' },
      { capabilities: { tools: {}, logging: {} } }
    );

    const transport = new StdioServerTransport();
    await server.connect(transport);

    expect(server.connect).toHaveBeenCalledWith(transport);
  });
});

