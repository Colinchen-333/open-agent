import { describe, it, expect } from 'bun:test';
import { createSdkMcpServer, tool } from '../mcp-helpers.js';

describe('tool()', () => {
  it('creates a tool definition with all fields', () => {
    const handler = async (args: { name: string }) => `Hello ${args.name}`;
    const t = tool('greet', 'Say hello', { name: { type: 'string' } }, handler);

    expect(t.name).toBe('greet');
    expect(t.description).toBe('Say hello');
    expect(t.inputSchema).toEqual({ name: { type: 'string' } });
    expect(t.handler).toBe(handler);
  });

  it('throws if name is empty', () => {
    expect(() => tool('', 'desc', {}, async () => '')).toThrow('name is required');
  });

  it('throws if description is empty', () => {
    expect(() => tool('t', '', {}, async () => '')).toThrow('description is required');
  });
});

describe('createSdkMcpServer()', () => {
  it('creates a valid MCP server config with type sdk', () => {
    const server = createSdkMcpServer({ name: 'test-server' });

    expect(server.type).toBe('sdk');
    expect((server as any).name).toBe('test-server');
    expect(server.instance).toBeDefined();
    expect(server.instance.name).toBe('test-server');
    expect(server.instance.version).toBe('1.0.0');
    expect(server.instance.tools).toEqual([]);
  });

  it('includes tools in the instance', () => {
    const myTool = tool('echo', 'Echo input', { text: { type: 'string' } }, async ({ text }) => text);
    const server = createSdkMcpServer({
      name: 'echo-server',
      version: '2.0.0',
      tools: [myTool],
    });

    expect(server.instance.version).toBe('2.0.0');
    expect(server.instance.tools).toHaveLength(1);
    expect(server.instance.tools[0].name).toBe('echo');
  });

  it('throws if name is empty', () => {
    expect(() => createSdkMcpServer({ name: '' })).toThrow('name is required');
  });
});
