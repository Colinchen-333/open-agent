import type { ToolDefinition, ToolContext } from './types.js';

export interface McpToolsDeps {
  listResources: (
    server?: string,
  ) => Promise<{ uri: string; name: string; mimeType?: string; description?: string; server: string }[]>;
  readResource: (server: string, uri: string) => Promise<string>;
}

export function createListMcpResourcesTool(deps: McpToolsDeps): ToolDefinition {
  return {
    name: 'ListMcpResourcesTool',
    description: 'List available resources from configured MCP servers.',
    inputSchema: {
      type: 'object',
      properties: {
        server: { type: 'string', description: 'Optional server name to filter by' },
      },
    },
    async execute(input: any, _ctx: ToolContext) {
      const resources = await deps.listResources(input.server);
      if (resources.length === 0) return 'No resources available.';
      return JSON.stringify(resources, null, 2);
    },
  };
}

export function createReadMcpResourceTool(deps: McpToolsDeps): ToolDefinition {
  return {
    name: 'ReadMcpResourceTool',
    description: 'Read a specific resource from an MCP server.',
    inputSchema: {
      type: 'object',
      properties: {
        server: { type: 'string', description: 'The MCP server name' },
        uri: { type: 'string', description: 'The resource URI to read' },
      },
      required: ['server', 'uri'],
    },
    async execute(input: any, _ctx: ToolContext) {
      return await deps.readResource(input.server, input.uri);
    },
  };
}
