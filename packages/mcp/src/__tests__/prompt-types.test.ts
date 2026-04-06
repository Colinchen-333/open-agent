import { describe, expect, test } from 'bun:test';
import type { McpPromptInfo, McpPromptMessage, McpSamplingRequest } from '../types';

describe('MCP prompt types', () => {
  test('McpPromptInfo shape', () => {
    const info: McpPromptInfo = {
      name: 'code-review',
      description: 'Review code',
      arguments: [{ name: 'code', required: true }],
      serverName: 'review-server',
    };
    expect(info.name).toBe('code-review');
    expect(info.arguments![0].required).toBe(true);
    expect(info.serverName).toBe('review-server');
  });

  test('McpPromptInfo minimal shape (no optional fields)', () => {
    const info: McpPromptInfo = {
      name: 'simple',
      serverName: 'test',
    };
    expect(info.name).toBe('simple');
    expect(info.description).toBeUndefined();
    expect(info.arguments).toBeUndefined();
  });

  test('McpPromptMessage shape', () => {
    const msg: McpPromptMessage = {
      role: 'user',
      content: { type: 'text', text: 'Hello world' },
    };
    expect(msg.role).toBe('user');
    expect(msg.content.type).toBe('text');
    expect(msg.content.text).toBe('Hello world');
  });

  test('McpSamplingRequest shape', () => {
    const req: McpSamplingRequest = {
      messages: [{ role: 'user', content: { type: 'text', text: 'Hello' } }],
      maxTokens: 100,
      modelPreferences: { intelligencePriority: 0.8 },
    };
    expect(req.messages).toHaveLength(1);
    expect(req.modelPreferences?.intelligencePriority).toBe(0.8);
  });

  test('McpSamplingRequest with all optional fields', () => {
    const req: McpSamplingRequest = {
      messages: [{ role: 'user', content: { type: 'text', text: 'test' } }],
      maxTokens: 500,
      systemPrompt: 'You are helpful',
      temperature: 0.7,
      stopSequences: ['STOP', 'END'],
      includeContext: 'thisServer',
      modelPreferences: {
        hints: [{ name: 'claude-3' }],
        costPriority: 0.3,
        speedPriority: 0.5,
        intelligencePriority: 0.9,
      },
      metadata: { requestId: 'abc-123' },
    };
    expect(req.systemPrompt).toBe('You are helpful');
    expect(req.temperature).toBe(0.7);
    expect(req.stopSequences).toEqual(['STOP', 'END']);
    expect(req.includeContext).toBe('thisServer');
    expect(req.modelPreferences?.hints?.[0].name).toBe('claude-3');
    expect(req.metadata?.requestId).toBe('abc-123');
  });

  test('namespaced prompt name', () => {
    const info: McpPromptInfo = { name: 'mcp__server1__review', serverName: 'server1' };
    expect(info.name.startsWith('mcp__')).toBe(true);
    // Verify the namespacing convention: mcp__<serverName>__<promptName>
    const parts = info.name.split('__');
    expect(parts[0]).toBe('mcp');
    expect(parts[1]).toBe('server1');
    expect(parts[2]).toBe('review');
  });

  test('prompt argument with description', () => {
    const info: McpPromptInfo = {
      name: 'summarize',
      arguments: [
        { name: 'text', description: 'The text to summarize', required: true },
        { name: 'style', description: 'Summary style', required: false },
      ],
      serverName: 'summarizer',
    };
    expect(info.arguments).toHaveLength(2);
    expect(info.arguments![0].description).toBe('The text to summarize');
    expect(info.arguments![1].required).toBe(false);
  });
});
