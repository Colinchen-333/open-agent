import { describe, expect, it } from 'bun:test';
import { ToolRegistry, type ToolDefinition } from '@open-agent/tools';
import { OpenAgentRuntime, buildCapabilitySnapshot } from '../index.js';

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
  it('builds a capability snapshot with layered presets', () => {
    const snapshot = buildCapabilitySnapshot([
      { name: 'Read', description: 'Read files' },
      { name: 'Write', description: 'Write files', isReadOnly: false, isConcurrencySafe: false },
      { name: 'Task', description: 'Spawn agents' },
      { name: 'mcp__demo__echo', description: 'Echo from MCP' },
      { name: 'ToolSearch', description: 'Load deferred tools' },
    ]);

    expect(snapshot.totalTools).toBe(5);
    expect(snapshot.summary.groupCounts.files).toBe(2);
    expect(snapshot.summary.groupCounts.coordination).toBe(1);
    expect(snapshot.summary.groupCounts.integration).toBe(2);
    expect(snapshot.summary.accessCounts['read-only']).toBe(1);
    expect(snapshot.summary.accessCounts.mutable).toBe(1);
    expect(snapshot.summary.accessCounts.meta).toBe(2);
    expect(snapshot.summary.accessCounts.external).toBe(1);
    expect(snapshot.summary.dynamicTools).toBe(1);
    expect(snapshot.summary.mcpTools).toBe(1);
    expect(snapshot.presets.map((preset) => preset.name)).toEqual([
      'files',
      'coordination',
      'integration',
    ]);
  });

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

    const snapshot = runtime.buildSnapshot();
    expect(snapshot.capabilitySnapshot.presets.map((preset) => preset.name)).toContain('integration');
    expect(snapshot.capabilitySnapshot.summary.mcpTools).toBeGreaterThan(0);
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
