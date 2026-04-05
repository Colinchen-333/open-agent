import { describe, it, expect, test } from 'bun:test';
import { createToolSearchTool } from '../tool-search.js';
import type { ToolContext, ToolDefinition } from '../types.js';

const mockCtx: ToolContext = {
  cwd: '/tmp/test',
  sessionId: 'tool-search-test',
};

// Registry-based (shouldDefer) tests
test('tool-search ranks deferred tools by keyword overlap', async () => {
  const deferredTools = new Map<string, ToolDefinition>([
    ['mcp__linear__list_issues', { name: 'mcp__linear__list_issues', description: 'List Linear issues for a team', shouldDefer: true, execute: async () => null, inputSchema: {} }],
    ['mcp__github__search_code', { name: 'mcp__github__search_code', description: 'Search code on GitHub repositories', shouldDefer: true, execute: async () => null, inputSchema: {} }],
    ['Read', { name: 'Read', description: 'Read a file from disk', execute: async () => null, inputSchema: {} }],
  ]);

  const tool = createToolSearchTool({ registry: deferredTools });
  const result = await tool.execute({ query: 'github code search' }, { cwd: '/', sessionId: 's' });
  expect(result.matches[0].name).toBe('mcp__github__search_code');
});

test('tool-search does not return non-deferred tools', async () => {
  const tools = new Map<string, ToolDefinition>([
    ['Read', { name: 'Read', description: 'Read a file from disk', execute: async () => null, inputSchema: {} }],
  ]);
  const tool = createToolSearchTool({ registry: tools });
  const result = await tool.execute({ query: 'read file' }, { cwd: '/', sessionId: 's' });
  expect(result.matches).toHaveLength(0);
});

describe('ToolSearch tool', () => {
  it('returns guidance when query is empty', async () => {
    const tool = createToolSearchTool({
      searchTools: async () => [{ name: 'Read', description: 'Read files' }],
      selectTool: async () => null,
    });

    const out = await tool.execute({ query: '' }, mockCtx);
    expect(typeof out).toBe('string');
    expect(String(out)).toContain('provide keywords');
  });

  it('returns actionable message when select target is missing', async () => {
    const tool = createToolSearchTool({
      searchTools: async () => [],
      selectTool: async () => null,
    });

    const out = await tool.execute({ query: 'select:' }, mockCtx);
    expect(String(out)).toContain('Missing tool name');
  });

  it('includes original query in no-match response', async () => {
    const tool = createToolSearchTool({
      searchTools: async () => [],
      selectTool: async () => null,
    });

    const out = await tool.execute({ query: 'non-existent-tool' }, mockCtx);
    expect(String(out)).toContain('non-existent-tool');
    expect(String(out)).toContain('No matching tools found');
  });
});
