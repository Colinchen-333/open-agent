import { describe, expect, test } from 'bun:test';
import { tool, createSdkMcpServer } from '../tool-builder';

describe('tool()', () => {
  test('creates tool definition', () => {
    const t = tool('greet', 'Say hello', { type: 'object', properties: { name: { type: 'string' } } },
      async (args: any) => ({ content: [{ type: 'text' as const, text: `Hello ${args.name}` }] }),
    );
    expect(t.name).toBe('greet');
    expect(t.description).toBe('Say hello');
  });

  test('handler executes', async () => {
    const t = tool('echo', 'Echo', {}, async (args: any) => ({
      content: [{ type: 'text' as const, text: String(args.msg) }],
    }));
    const result = await t.handler({ msg: 'hi' });
    expect(result.content[0].text).toBe('hi');
  });

  test('supports annotations and extras', () => {
    const t = tool('safe', 'Safe tool', {}, async () => ({ content: [{ type: 'text' as const, text: 'ok' }] }), {
      annotations: { readOnly: true },
      searchHint: 'safe readonly',
      alwaysLoad: true,
    });
    expect(t.annotations?.readOnly).toBe(true);
    expect(t.searchHint).toBe('safe readonly');
    expect(t.alwaysLoad).toBe(true);
  });
});

describe('createSdkMcpServer', () => {
  test('creates server with tools', () => {
    const server = createSdkMcpServer({
      name: 'test-server',
      tools: [tool('t1', 'd1', {}, async () => ({ content: [{ type: 'text' as const, text: 'ok' }] }))],
    });
    expect(server.name).toBe('test-server');
    expect(server.listTools()).toHaveLength(1);
  });

  test('callTool dispatches to handler', async () => {
    const server = createSdkMcpServer({
      name: 'test',
      tools: [tool('echo', 'echo', {}, async (args: any) => ({
        content: [{ type: 'text' as const, text: args.text }],
      }))],
    });
    const result = await server.callTool('echo', { text: 'hello' });
    expect(result.content[0].text).toBe('hello');
  });

  test('callTool throws for unknown tool', async () => {
    const server = createSdkMcpServer({ name: 'test' });
    await expect(server.callTool('unknown', {})).rejects.toThrow('not found');
  });
});
