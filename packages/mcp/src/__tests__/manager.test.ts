import { describe, expect, it } from 'bun:test';
import { McpManager } from '../manager';

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
    });

    const status = manager.getStatus().find((entry) => entry.name === 'demo');
    expect(status?.status).toBe('connected');
    expect(status?.tools).toEqual([
      {
        name: 'inspect',
        description: 'Inspect remote state',
        inputSchema: { type: 'object', properties: {} },
        serverName: 'demo',
        annotations: {
          readOnly: true,
          openWorld: true,
        },
      },
    ]);

    expect(manager.getAllTools()).toEqual(status?.tools);
    expect(await manager.callTool('demo', 'inspect', { value: 'ok' })).toEqual({ echoed: 'ok' });
  });
});
