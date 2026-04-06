import { describe, expect, test } from 'bun:test';
import { McpWsClient } from '../ws-transport';

describe('McpWsClient', () => {
  test('constructs with url and server name', () => {
    const client = new McpWsClient('test-server', 'ws://localhost:3000');
    expect(client).toBeDefined();
  });

  test('constructs with headers', () => {
    const client = new McpWsClient('test', 'ws://localhost:3000', {
      Authorization: 'Bearer x',
    });
    expect(client).toBeDefined();
  });

  test('listTools returns empty before connect', async () => {
    const client = new McpWsClient('test', 'ws://localhost:3000');
    const tools = await client.listTools();
    expect(tools).toEqual([]);
  });

  test('listResources returns empty before connect', async () => {
    const client = new McpWsClient('test', 'ws://localhost:3000');
    const resources = await client.listResources();
    expect(resources).toEqual([]);
  });

  test('listPrompts returns empty before connect', async () => {
    const client = new McpWsClient('test', 'ws://localhost:3000');
    const prompts = await client.listPrompts();
    expect(prompts).toEqual([]);
  });

  test('callTool throws when not connected', async () => {
    const client = new McpWsClient('test', 'ws://localhost:3000');
    expect(client.callTool('test', {})).rejects.toThrow('Not connected');
  });

  test('readResource throws when not connected', async () => {
    const client = new McpWsClient('test', 'ws://localhost:3000');
    expect(client.readResource('file:///test')).rejects.toThrow('Not connected');
  });

  test('getPrompt returns empty before connect', async () => {
    const client = new McpWsClient('test', 'ws://localhost:3000');
    const messages = await client.getPrompt('test-prompt');
    expect(messages).toEqual([]);
  });

  test('getUnderlyingClient returns null before connect', () => {
    const client = new McpWsClient('test', 'ws://localhost:3000');
    expect(client.getUnderlyingClient()).toBeNull();
  });
});
