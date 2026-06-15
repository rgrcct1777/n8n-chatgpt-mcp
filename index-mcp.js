import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';

import { McpServer } from './dist/services/mcp-server.js';
const core = new McpServer();

const server = new Server(
  {
    name: 'n8n-mcp-server',
    version: '1.0.0',
  },
  {
    capabilities: {
      tools: {},
    },
  }
);

server.setRequestHandler(ListToolsRequestSchema, async () => {
  return {
    tools: core.getTools(),
  };
});

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const name = request.params?.name;
  const args = request.params?.arguments ?? {};

  if (typeof name !== 'string' || !name.length) {
    return {
      content: [{ type: 'text', text: 'Error: Tool name is required' }],
      isError: true,
    };
  }

  try {
    return await core.callTool(name, args);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      content: [{ type: 'text', text: `Error: ${message}` }],
      isError: true,
    };
  }
});

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error('N8N MCP Server running on stdio');
}

main().catch(console.error);
