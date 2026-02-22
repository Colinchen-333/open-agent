import type { ToolDefinition, ToolContext } from './types.js';

export interface ToolSearchDeps {
  searchTools: (query: string) => Promise<{ name: string; description: string }[]>;
  selectTool: (name: string) => Promise<ToolDefinition | null>;
}

export function createToolSearchTool(deps: ToolSearchDeps): ToolDefinition {
  return {
    name: 'ToolSearch',
    description:
      'Search for available deferred tools. Use "select:<tool_name>" for direct selection, or keywords to search.',
    inputSchema: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description:
            'Query to find tools. Use "select:<tool_name>" for direct selection.',
        },
        max_results: {
          type: 'number',
          default: 5,
          description: 'Maximum results to return',
        },
      },
      required: ['query'],
    },
    async execute(input: any, _ctx: ToolContext) {
      const query: string = input.query;
      const maxResults: number = (input.max_results as number) ?? 5;

      if (query.startsWith('select:')) {
        const toolName = query.slice(7);
        const tool = await deps.selectTool(toolName);
        if (tool) {
          return `Tool "${toolName}" loaded successfully. It is now available for use.`;
        }
        return `Tool "${toolName}" not found.`;
      }

      const results = await deps.searchTools(query);
      const limited = results.slice(0, maxResults);

      if (limited.length === 0) {
        return 'No matching tools found.';
      }

      return limited.map((t) => `- ${t.name}: ${t.description}`).join('\n');
    },
  };
}
