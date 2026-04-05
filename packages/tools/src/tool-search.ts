import type { ToolDefinition, ToolContext } from './types.js';

export interface ToolSearchDeps {
  searchTools: (query: string) => Promise<{ name: string; description: string }[]>;
  selectTool: (name: string) => Promise<ToolDefinition | null>;
}

export interface ToolSearchRegistry {
  registry: Map<string, ToolDefinition>;
}

function tokenize(s: string): string[] {
  return s.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
}

function scoreMatch(queryTokens: string[], tool: ToolDefinition): number {
  const hay = tokenize(`${tool.name} ${tool.description}`);
  const haySet = new Set(hay);
  let score = 0;
  for (const q of queryTokens) {
    if (haySet.has(q)) score += 2;
    else if (hay.some(h => h.includes(q))) score += 1;
  }
  return score;
}

function isRegistryOpts(opts: ToolSearchDeps | ToolSearchRegistry): opts is ToolSearchRegistry {
  return 'registry' in opts && opts.registry instanceof Map;
}

export function createToolSearchTool(opts: ToolSearchDeps | ToolSearchRegistry): ToolDefinition {
  if (isRegistryOpts(opts)) {
    // Registry-based mode: keyword-overlap ranking over deferred tools only
    return {
      name: 'ToolSearch',
      description:
        'Search for deferred tools by natural-language query. Returns schemas of matching tools so they can be called in this turn.',
      isReadOnly: true,
      inputSchema: {
        type: 'object',
        properties: {
          query: {
            type: 'string',
            description: 'Keywords to find tools. Use "select:<tool_name>" for direct selection.',
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
        const query: string = String(input.query ?? '').trim();
        const max: number = (input.max_results as number) ?? 5;
        const qTokens = tokenize(query);
        const scored: Array<{ name: string; description: string; inputSchema: unknown; score: number }> = [];
        for (const tool of opts.registry.values()) {
          if (!tool.shouldDefer) continue;
          const score = scoreMatch(qTokens, tool);
          if (score > 0) {
            scored.push({ name: tool.name, description: tool.description, inputSchema: tool.inputSchema, score });
          }
        }
        scored.sort((a, b) => b.score - a.score);
        return { matches: scored.slice(0, max) };
      },
    };
  }

  // Legacy callback-based mode: preserves the original ToolSearchDeps behaviour
  const deps = opts;
  return {
    name: 'ToolSearch',
    description:
      'Search for available deferred tools. Use "select:<tool_name>" for direct selection, or keywords to search.',
    isReadOnly: true,
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
      const query: string = String(input.query ?? '').trim();
      const maxResults: number = (input.max_results as number) ?? 5;

      if (query.startsWith('select:')) {
        const toolName = query.slice(7).trim();
        if (!toolName) {
          return 'Missing tool name. Use "select:<tool_name>".';
        }
        const tool = await deps.selectTool(toolName);
        if (tool) {
          return `Tool "${toolName}" loaded successfully. It is now available for use.`;
        }
        return `Tool "${toolName}" not found. Try ToolSearch with keywords first, then run select:<tool_name>.`;
      }

      if (!query) {
        return [
          'Please provide keywords to search tools.',
          'Examples:',
          '- "search: git diff"',
          '- "search: browser automation"',
          '- "select:ToolName" to load a known tool directly',
        ].join('\n');
      }

      const results = await deps.searchTools(query);
      const limited = results.slice(0, maxResults);

      if (limited.length === 0) {
        return `No matching tools found for "${query}". Try broader keywords or use "select:<tool_name>".`;
      }

      return limited.map((t) => `- ${t.name}: ${t.description}`).join('\n');
    },
  };
}
