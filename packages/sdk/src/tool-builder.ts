/**
 * SDK tool() function — define custom tools for SDK consumers.
 * Matches Claude Code's tool() + createSdkMcpServer().
 */

export interface ToolAnnotations {
  readOnly?: boolean;
  destructive?: boolean;
  idempotent?: boolean;
  openWorld?: boolean;
}

export interface SdkToolDefinition<TInput = unknown> {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  handler: (args: TInput, extra?: unknown) => Promise<{ content: Array<{ type: 'text'; text: string }> }>;
  annotations?: ToolAnnotations;
  searchHint?: string;
  alwaysLoad?: boolean;
}

/**
 * Define a custom SDK tool.
 */
export function tool<TInput = unknown>(
  name: string,
  description: string,
  inputSchema: Record<string, unknown>,
  handler: (args: TInput, extra?: unknown) => Promise<{ content: Array<{ type: 'text'; text: string }> }>,
  extras?: { annotations?: ToolAnnotations; searchHint?: string; alwaysLoad?: boolean },
): SdkToolDefinition<TInput> {
  return {
    name,
    description,
    inputSchema,
    handler,
    annotations: extras?.annotations,
    searchHint: extras?.searchHint,
    alwaysLoad: extras?.alwaysLoad,
  };
}

export interface SdkMcpServerOptions {
  name: string;
  version?: string;
  tools?: SdkToolDefinition[];
}

export interface SdkMcpServerInstance {
  name: string;
  version: string;
  tools: SdkToolDefinition[];
  /** Handle a tool call from the runtime */
  callTool(toolName: string, args: unknown): Promise<{ content: Array<{ type: 'text'; text: string }> }>;
  /** List available tools */
  listTools(): Array<{ name: string; description: string; inputSchema: Record<string, unknown> }>;
}

/**
 * Create an in-process MCP server instance for SDK tool hosting.
 */
export function createSdkMcpServer(options: SdkMcpServerOptions): SdkMcpServerInstance {
  const toolMap = new Map<string, SdkToolDefinition>();
  for (const t of options.tools ?? []) {
    toolMap.set(t.name, t);
  }

  return {
    name: options.name,
    version: options.version ?? '1.0.0',
    tools: options.tools ?? [],

    async callTool(toolName: string, args: unknown) {
      const t = toolMap.get(toolName);
      if (!t) throw new Error(`Tool not found: ${toolName}`);
      return t.handler(args);
    },

    listTools() {
      return [...toolMap.values()].map(t => ({
        name: t.name,
        description: t.description,
        inputSchema: t.inputSchema,
      }));
    },
  };
}
