import { describe, expect, it, test } from 'bun:test';
import { McpManager } from '../manager';

describe('McpManager readResource', () => {
  test('McpManager exposes readResource method', () => {
    const manager = new McpManager();
    expect(typeof manager.readResource).toBe('function');
  });
});

describe('McpManager SDK servers', () => {
  it('保留 SDK 工具 annotations 并允许直接调用 handler', async () => {
    const manager = new McpManager();

    await manager.addServer('demo', {
      type: 'sdk',
      name: 'demo',
      instance: {
        tools: [
          {
            name: 'inspect',
            description: 'Inspect remote state',
            annotations: {
              readOnly: true,
              openWorld: true,
            },
            handler: async (args: Record<string, unknown>) => ({
              echoed: args.value ?? null,
            }),
          },
        ],
      },
    } as any);

    const status = manager.getStatus().find((entry) => entry.name === 'demo');
    expect(status?.status).toBe('connected');
    expect(status?.tools).toEqual([
      {
        name: 'mcp__demo__inspect',
        description: 'Inspect remote state',
        inputSchema: { type: 'object', properties: {} },
        serverName: 'demo',
        mcpInfo: { serverName: 'demo', toolName: 'inspect' },
        annotations: {
          readOnly: true,
          openWorld: true,
        },
      },
    ]);

    expect(manager.getAllTools()).toEqual(status?.tools ?? []);
    expect(await manager.callTool('demo', 'inspect', { value: 'ok' })).toEqual({ echoed: 'ok' });
  });
});
