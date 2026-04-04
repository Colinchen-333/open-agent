import { describe, expect, it } from 'bun:test';
import { ToolRegistry, type ToolDefinition } from '@open-agent/tools';
import { OpenAgentRuntime, buildCapabilitySnapshot, filterCapabilitySnapshot } from '../index.js';

function createSdkServer(
  toolName: string,
  description = 'MCP tool',
  annotations?: { readOnly?: boolean; destructive?: boolean; openWorld?: boolean },
) {
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
          annotations,
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
      {
        name: 'Read',
        description: 'Read files',
        capability: {
          category: 'filesystem',
          readOnly: true,
          concurrencySafe: true,
          risk: 'low',
          needsWorkspaceWrite: false,
        },
      },
      {
        name: 'Write',
        description: 'Write files',
        capability: {
          category: 'filesystem',
          readOnly: false,
          concurrencySafe: false,
          risk: 'medium',
          needsWorkspaceWrite: true,
        },
      },
      {
        name: 'Task',
        description: 'Spawn agents',
        capability: {
          category: 'agent',
          readOnly: false,
          concurrencySafe: true,
          risk: 'medium',
          needsWorkspaceWrite: false,
        },
      },
      {
        name: 'mcp__demo__echo',
        description: 'Echo from MCP',
        capability: {
          category: 'mcp',
          readOnly: true,
          concurrencySafe: true,
          risk: 'low',
          needsWorkspaceWrite: false,
        },
      },
      {
        name: 'ToolSearch',
        description: 'Load deferred tools',
        capability: {
          category: 'utility',
          readOnly: true,
          concurrencySafe: true,
          risk: 'low',
          needsWorkspaceWrite: false,
        },
      },
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
    expect(snapshot.profiles.find((profile) => profile.toolName === 'Write')?.needsWorkspaceWrite).toBe(true);
    expect(snapshot.profiles.find((profile) => profile.toolName === 'Write')?.risk).toBe('medium');
    expect(snapshot.presets.map((preset) => preset.name)).toEqual([
      'files',
      'coordination',
      'integration',
    ]);
  });

  it('filters capability snapshots to the current session toolset', () => {
    const snapshot = buildCapabilitySnapshot([
      {
        name: 'Read',
        description: 'Read files',
        capability: {
          category: 'filesystem',
          readOnly: true,
          concurrencySafe: true,
          risk: 'low',
          needsWorkspaceWrite: false,
        },
      },
      {
        name: 'Write',
        description: 'Write files',
        capability: {
          category: 'filesystem',
          readOnly: false,
          concurrencySafe: false,
          risk: 'medium',
          needsWorkspaceWrite: true,
        },
      },
      {
        name: 'mcp__demo__deploy',
        description: 'Deploy from MCP',
        capability: {
          category: 'mcp',
          readOnly: false,
          concurrencySafe: false,
          risk: 'high',
          needsWorkspaceWrite: false,
          tags: ['mcp', 'demo', 'external', 'network', 'destructive'],
        },
      },
    ]);

    const filtered = filterCapabilitySnapshot(snapshot, ['Read', 'mcp__demo__deploy']);

    expect(filtered.totalTools).toBe(2);
    expect(filtered.profiles.map((profile) => profile.toolName)).toEqual([
      'Read',
      'mcp__demo__deploy',
    ]);
    expect(filtered.summary.accessCounts['read-only']).toBe(1);
    expect(filtered.summary.accessCounts.external).toBe(1);
    expect(filtered.summary.accessCounts.mutable).toBe(0);
    expect(filtered.summary.mcpTools).toBe(1);
    expect(filtered.presets.map((preset) => preset.name)).toEqual([
      'files',
      'integration',
    ]);
    expect(filtered.profiles.find((profile) => profile.toolName === 'mcp__demo__deploy')?.tags).toEqual(
      expect.arrayContaining(['external', 'network', 'destructive']),
    );
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
    expect(snapshot.diagnosticSummary.total).toBe(0);
  });

  it('maps MCP annotations into runtime tool capability metadata', async () => {
    const registry = new ToolRegistry();
    const runtime = new OpenAgentRuntime({
      cwd: '/tmp',
      toolRegistry: registry,
      mcp: {
        toolNameStyle: 'namespaced',
      },
    });

    await runtime.initialize();
    await runtime.setMcpServers({
      demo: createSdkServer('deploy', 'Deploy remotely', {
        destructive: true,
        openWorld: true,
      }),
    });

    const tool = registry.get('mcp__demo__deploy');
    expect(tool?.isReadOnly).toBe(false);
    expect(tool?.capability?.category).toBe('mcp');
    expect(tool?.capability?.risk).toBe('high');
    expect(tool?.capability?.tags).toEqual(expect.arrayContaining(['mcp', 'demo', 'external', 'network', 'destructive']));

    const snapshot = runtime.buildSnapshot();
    const profile = snapshot.capabilitySnapshot.profiles.find((entry) => entry.toolName === 'mcp__demo__deploy');
    expect(profile?.source).toBe('mcp');
    expect(profile?.risk).toBe('high');
    expect(profile?.tags).toEqual(expect.arrayContaining(['external', 'network']));
    expect(snapshot.diagnosticSummary).toEqual({
      total: 0,
      info: 0,
      warning: 0,
      error: 0,
      bySource: {},
    });
  });

  it('maps read-only MCP annotations into runtime access metadata', async () => {
    const registry = new ToolRegistry();
    const runtime = new OpenAgentRuntime({
      cwd: '/tmp',
      toolRegistry: registry,
      mcp: {
        toolNameStyle: 'namespaced',
      },
    });

    await runtime.initialize();
    await runtime.setMcpServers({
      demo: createSdkServer('inspect', 'Inspect deployment state', {
        readOnly: true,
      }),
    });

    const tool = registry.get('mcp__demo__inspect');
    expect(tool?.isReadOnly).toBe(true);
    expect(tool?.capability?.risk).toBe('low');
    expect(tool?.capability?.readOnly).toBe(true);
    expect(tool?.capability?.concurrencySafe).toBe(true);
    expect(tool?.capability?.tags).toEqual(expect.arrayContaining(['mcp', 'demo', 'read-only']));

    const snapshot = runtime.buildSnapshot();
    const profile = snapshot.capabilitySnapshot.profiles.find((entry) => entry.toolName === 'mcp__demo__inspect');
    expect(profile?.access).toBe('external');
    expect(profile?.readOnly).toBe(true);
    expect(profile?.risk).toBe('low');
    expect(profile?.tags).toEqual(expect.arrayContaining(['read-only']));
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

  it('includes plugin, hook, and diagnostic summaries in runtime snapshots', async () => {
    const registry = new ToolRegistry();
    const runtime = new OpenAgentRuntime({
      cwd: '/tmp',
      toolRegistry: registry,
      plugins: [{
        name: 'review-kit',
        path: '/tmp/review-kit',
        version: '1.2.3',
        enabled: true,
        agentCount: 2,
        skillCount: 1,
        commandCount: 1,
        mcpServerCount: 0,
        hookEventCount: 2,
        hookCount: 3,
      }],
      hooks: [{
        event: 'PreToolUse',
        count: 2,
        sources: ['review-kit'],
      }],
      diagnostics: [{
        code: 'plugin_agent_collision',
        message: 'Plugin agent "reviewer" overrides an earlier plugin agent definition.',
        severity: 'warning',
        source: 'plugin',
      }],
    });

    await runtime.initialize();
    const snapshot = runtime.buildSnapshot();
    expect(snapshot.plugins).toHaveLength(1);
    expect(snapshot.plugins[0]?.name).toBe('review-kit');
    expect(snapshot.hooks).toEqual([{
      event: 'PreToolUse',
      count: 2,
      sources: ['review-kit'],
    }]);
    expect(snapshot.diagnostics).toEqual([{
      code: 'plugin_agent_collision',
      message: 'Plugin agent "reviewer" overrides an earlier plugin agent definition.',
      severity: 'warning',
      source: 'plugin',
    }]);
    expect(snapshot.diagnosticSummary).toEqual({
      total: 1,
      info: 0,
      warning: 1,
      error: 0,
      bySource: { plugin: 1 },
    });
  });
});
