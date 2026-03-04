import { describe, it, expect } from 'bun:test';
import { createToolSearchTool } from '../tool-search.js';
import type { ToolContext } from '../types.js';

const mockCtx: ToolContext = {
  cwd: '/tmp/test',
  sessionId: 'tool-search-test',
};

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
