import { describe, expect, it } from 'bun:test';
import { ToolRegistry, type ToolDefinition } from '@open-agent/tools';
import { OpenAgentRuntime } from '../index.js';

function createSdkServer(toolName: string, description = 'MCP tool') {
  return {
    type: 'sdk' as const,
    name: 'demo',
    instance: {
      tools: [
        {
          name: toolName,
          description,
          inputSchema: {
            type: 'object',
            properties: {
              value: { type: 'string' },
            },
          },
          handler: async (args: Record<string, unknown>) => ({
            echoed: args.value ?? null,
          }),
        },
      ],
    },
  };
}

describe('OpenAgentRuntime MCP wiring', () => {
  it('同步 namespaced MCP 工具并让 ToolSearch 可见', async () => {
    const registry = new ToolRegistry();
    const runtime = new OpenAgentRuntime({
      cwd: '/tmp',
      toolRegistry: registry,
      mcp: {
        toolNameStyle: 'namespaced',
        formatResult: (result) => (typeof result === 'string' ? result : JSON.stringify(result)),
      },
    });

    await runtime.initialize();
    runtime.registerToolSearchTool();
    await runtime.setMcpServers({
      demo: createSdkServer('echo', 'Echo from MCP'),
    });

    const tool = registry.get('mcp__demo__echo');
    expect(tool).toBeDefined();
    expect(await tool!.execute({ value: 'hi' }, {} as any)).toBe(JSON.stringify({ echoed: 'hi' }));

    const toolSearch = registry.get('ToolSearch');
    const searchResult = await toolSearch!.execute({ query: 'echo' }, {} as any);
    expect(searchResult).toContain('mcp__demo__echo');
  });

  it('在 raw 命名模式下移除 MCP 工具时恢复基线工具', async () => {
    const registry = new ToolRegistry();
    const baseTool: ToolDefinition = {
      name: 'echo',
      description: 'base echo',
      inputSchema: { type: 'object', properties: {} },
      execute: async () => 'base',
    };
    registry.register(baseTool);

    const runtime = new OpenAgentRuntime({
      cwd: '/tmp',
      toolRegistry: registry,
      mcp: {
        restoreTool: (toolName) => (toolName === 'echo' ? baseTool : undefined),
      },
    });

    await runtime.initialize();
    await runtime.setMcpServers({
      demo: createSdkServer('echo', 'Echo from MCP'),
    });

    expect(registry.get('echo')?.description).toBe('Echo from MCP');

    await runtime.setMcpServers({});

    expect(registry.get('echo')?.description).toBe('base echo');
    expect(await registry.get('echo')!.execute({}, {} as any)).toBe('base');
  });
});
