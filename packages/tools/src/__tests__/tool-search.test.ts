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

// Activation callback tests
test('registry-mode: activateDeferredTool is called for each matched tool', async () => {
  const deferredTools = new Map<string, ToolDefinition>([
    ['mcp__svc__alpha', { name: 'mcp__svc__alpha', description: 'Alpha workflow orchestrator', shouldDefer: true, execute: async () => null, inputSchema: {} }],
    ['mcp__svc__beta', { name: 'mcp__svc__beta', description: 'Beta metrics collector', shouldDefer: true, execute: async () => null, inputSchema: {} }],
    ['Read', { name: 'Read', description: 'Read a file from disk', execute: async () => null, inputSchema: {} }],
  ]);

  const activated: string[] = [];
  const ctx: ToolContext = {
    cwd: '/',
    sessionId: 's',
    activateDeferredTool: (name) => activated.push(name),
  };

  const tool = createToolSearchTool({ registry: deferredTools });
  // query uniquely matches alpha ("orchestrator" is only in alpha's description)
  const result = await tool.execute({ query: 'alpha orchestrator' }, ctx);
  expect(result.matches[0].name).toBe('mcp__svc__alpha');
  expect(activated).toContain('mcp__svc__alpha');
  // beta did not match, so should not be activated
  expect(activated).not.toContain('mcp__svc__beta');
  // non-deferred tool never activated
  expect(activated).not.toContain('Read');
});

test('registry-mode: activateDeferredTool gracefully absent (no crash)', async () => {
  const deferredTools = new Map<string, ToolDefinition>([
    ['mcp__svc__alpha', { name: 'mcp__svc__alpha', description: 'Alpha service action', shouldDefer: true, execute: async () => null, inputSchema: {} }],
  ]);
  // ctx without activateDeferredTool
  const ctx: ToolContext = { cwd: '/', sessionId: 's' };
  const tool = createToolSearchTool({ registry: deferredTools });
  // Must not throw
  const result = await tool.execute({ query: 'alpha service' }, ctx);
  expect(result.matches).toHaveLength(1);
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

  it('select: calls activateDeferredTool when deferred tool is found', async () => {
    const deferredTool: ToolDefinition = {
      name: 'mcp__svc__action',
      description: 'Action',
      shouldDefer: true,
      inputSchema: {},
      execute: async () => 'ok',
    };
    const activated: string[] = [];
    const ctx: ToolContext = {
      cwd: '/',
      sessionId: 's',
      activateDeferredTool: (name) => activated.push(name),
    };
    const tool = createToolSearchTool({
      searchTools: async () => [],
      selectTool: async () => deferredTool,
    });

    const out = await tool.execute({ query: 'select:mcp__svc__action' }, ctx);
    expect(String(out)).toContain('loaded successfully');
    expect(activated).toContain('mcp__svc__action');
  });

  it('select: does not call activateDeferredTool for non-deferred tools', async () => {
    const normalTool: ToolDefinition = {
      name: 'SomeTool',
      description: 'Normal',
      shouldDefer: false,
      inputSchema: {},
      execute: async () => 'ok',
    };
    const activated: string[] = [];
    const ctx: ToolContext = {
      cwd: '/',
      sessionId: 's',
      activateDeferredTool: (name) => activated.push(name),
    };
    const tool = createToolSearchTool({
      searchTools: async () => [],
      selectTool: async () => normalTool,
    });

    await tool.execute({ query: 'select:SomeTool' }, ctx);
    expect(activated).toHaveLength(0);
  });
});
