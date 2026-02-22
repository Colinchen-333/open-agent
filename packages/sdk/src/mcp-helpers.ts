import type { McpServerConfig } from '@open-agent/core';

// --------------------------------------------------------------------------
// SDK MCP helpers
// --------------------------------------------------------------------------

/**
 * Full definition of a tool that can be registered in an SDK-hosted MCP
 * server.  Mirrors the shape used by the MCP SDK's `server.tool()` API.
 */
export interface SdkMcpToolDefinition {
  name: string;
  description: string;
  inputSchema: Record<string, any>;
  handler: (args: any, extra: unknown) => Promise<any>;
}

/**
 * Create an in-process MCP server configuration that can be passed directly
 * to `QueryOptions.mcpServers`.  The returned object satisfies `McpServerConfig`
 * (type `'sdk'`) and also exposes an `instance` property carrying the server
 * metadata for frameworks that need it.
 *
 * @example
 * ```ts
 * const server = createSdkMcpServer({
 *   name: 'my-tools',
 *   tools: [
 *     tool('greet', 'Say hello', { name: { type: 'string' } }, async ({ name }) => `Hello, ${name}!`),
 *   ],
 * });
 *
 * const q = query({ prompt: 'Greet Alice', options: { mcpServers: { myTools: server } } });
 * ```
 */
export function createSdkMcpServer(options: {
  name: string;
  version?: string;
  tools?: SdkMcpToolDefinition[];
}): McpServerConfig & { instance: SdkMcpServerInstance } {
  const instance: SdkMcpServerInstance = {
    name: options.name,
    version: options.version ?? '1.0.0',
    tools: options.tools ?? [],
  };

  return {
    type: 'sdk',
    name: options.name,
    instance,
  } as McpServerConfig & { instance: SdkMcpServerInstance };
}

/**
 * Internal shape of the object attached to `instance` on configs produced
 * by `createSdkMcpServer`.
 */
export interface SdkMcpServerInstance {
  name: string;
  version: string;
  tools: SdkMcpToolDefinition[];
}

/**
 * Convenience factory for creating a `SdkMcpToolDefinition`.
 *
 * @param name        - Unique tool name (snake_case recommended).
 * @param description - Human-readable description shown to the model.
 * @param inputSchema - JSON Schema describing the tool's input object.
 * @param handler     - Async function that executes the tool.
 *
 * @example
 * ```ts
 * const myTool = tool(
 *   'fetch_weather',
 *   'Fetch current weather for a city',
 *   { city: { type: 'string', description: 'City name' } },
 *   async ({ city }) => fetchWeather(city),
 * );
 * ```
 */
export function tool(
  name: string,
  description: string,
  inputSchema: Record<string, any>,
  handler: (args: any, extra: unknown) => Promise<any>,
): SdkMcpToolDefinition {
  return { name, description, inputSchema, handler };
}
