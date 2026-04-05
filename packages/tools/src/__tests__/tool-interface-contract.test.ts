import { describe, expect, test } from 'bun:test';
import type { ToolDefinition } from '../types.js';
import { createDefaultToolRegistry } from '../registry.js';
import { createToolSearchTool } from '../tool-search.js';
import { createTaskTool } from '../task-tool.js';
import { createTeamCreateTool, createTeamDeleteTool, createSendMessageTool } from '../team-tools.js';
import { createTaskCreateTool, createTaskUpdateTool, createTaskGetTool, createTaskListTool } from '../task-tools.js';
import { createListMcpResourcesTool, createReadMcpResourceTool } from '../mcp-tools.js';
import { createEnterPlanModeTool, createExitPlanModeTool } from '../plan-mode.js';
import { createSkillTool } from '../skill-tool.js';

/**
 * Checks whether a tool satisfies the expanded ToolDefinition contract.
 * All fields must be present (either from the tool itself or from withToolDefaults).
 */
function satisfiesContract(tool: ToolDefinition): boolean {
  return (
    typeof tool.name === 'string' &&
    typeof tool.description === 'string' &&
    typeof tool.inputSchema === 'object' &&
    typeof tool.execute === 'function' &&
    // New contract fields (all with sensible defaults provided by withToolDefaults)
    typeof tool.maxResultSizeChars === 'number' &&
    (tool.interruptBehavior === 'cancel' || tool.interruptBehavior === 'block') &&
    typeof tool.extractSearchText === 'function' &&
    typeof tool.isResultTruncated === 'function' &&
    typeof tool.renderToolUseMessage === 'function' &&
    typeof tool.renderToolResultMessage === 'function' &&
    typeof tool.renderToolUseErrorMessage === 'function'
  );
}

/**
 * Build a registry containing all tools, including those that require
 * dependency injection. Uses minimal no-op stubs for injected deps.
 */
function buildAllTools(): ToolDefinition[] {
  // Default registry tools (no deps needed)
  const registry = createDefaultToolRegistry('/tmp');
  const tools: ToolDefinition[] = [...registry.list()];

  // ToolSearch — registry-based variant
  tools.push(createToolSearchTool({ registry: new Map() }));

  // Task tool — requires runSubagent
  tools.push(createTaskTool({
    runSubagent: async () => 'stub result',
  }));

  // Team tools
  const teamDeps = {
    createTeam: async () => ({ teamName: 'stub', configPath: '/tmp' }),
    deleteTeam: async () => ({ success: true }),
    sendMessage: async () => ({ success: true, message: 'sent' }),
  };
  tools.push(createTeamCreateTool(teamDeps));
  tools.push(createTeamDeleteTool(teamDeps));
  tools.push(createSendMessageTool(teamDeps));

  // Task CRUD tools
  const taskDeps = {
    createTask: async () => ({ id: '1', subject: 'stub' }),
    updateTask: async () => ({ success: true }),
    getTask: async () => null,
    listTasks: async () => [],
  };
  tools.push(createTaskCreateTool(taskDeps));
  tools.push(createTaskUpdateTool(taskDeps));
  tools.push(createTaskGetTool(taskDeps));
  tools.push(createTaskListTool(taskDeps));

  // MCP tools
  const mcpDeps = {
    listResources: async () => [],
    readResource: async () => '',
  };
  tools.push(createListMcpResourcesTool(mcpDeps));
  tools.push(createReadMcpResourceTool(mcpDeps));

  // Plan mode tools (legacy deps form)
  const planDeps = {
    enterPlanMode: () => {},
    exitPlanMode: () => {},
    isPlanMode: () => false,
  };
  tools.push(createEnterPlanModeTool(planDeps));
  tools.push(createExitPlanModeTool(planDeps));

  // Skill tool
  tools.push(createSkillTool({
    listSkills: () => [],
  }));

  return tools;
}

describe('ToolDefinition expanded contract', () => {
  test('all registered tools satisfy the expanded contract', () => {
    const tools = buildAllTools();

    // Ensure we have a reasonable number of tools
    expect(tools.length).toBeGreaterThanOrEqual(20);

    for (const tool of tools) {
      const passes = satisfiesContract(tool);
      if (!passes) {
        // Provide a helpful failure message
        const missing: string[] = [];
        if (typeof tool.maxResultSizeChars !== 'number') missing.push('maxResultSizeChars');
        if (tool.interruptBehavior !== 'cancel' && tool.interruptBehavior !== 'block') missing.push('interruptBehavior');
        if (typeof tool.extractSearchText !== 'function') missing.push('extractSearchText');
        if (typeof tool.isResultTruncated !== 'function') missing.push('isResultTruncated');
        if (typeof tool.renderToolUseMessage !== 'function') missing.push('renderToolUseMessage');
        if (typeof tool.renderToolResultMessage !== 'function') missing.push('renderToolResultMessage');
        if (typeof tool.renderToolUseErrorMessage !== 'function') missing.push('renderToolUseErrorMessage');
        throw new Error(`Tool "${tool.name}" is missing contract fields: ${missing.join(', ')}`);
      }
    }
  });

  test('withToolDefaults sets correct default values', async () => {
    const { withToolDefaults } = await import('../tool-defaults.js');
    const minimal: ToolDefinition = {
      name: 'MinimalTool',
      description: 'A minimal tool for testing',
      inputSchema: { type: 'object', properties: {} },
      execute: async () => 'ok',
    };
    const wrapped = withToolDefaults(minimal);

    expect(wrapped.maxResultSizeChars).toBe(100_000);
    expect(wrapped.interruptBehavior).toBe('cancel');
    expect(typeof wrapped.extractSearchText).toBe('function');
    expect(typeof wrapped.isResultTruncated).toBe('function');
    expect(typeof wrapped.renderToolUseMessage).toBe('function');
    expect(typeof wrapped.renderToolResultMessage).toBe('function');
    expect(typeof wrapped.renderToolUseErrorMessage).toBe('function');

    // Verify default behaviours
    expect(wrapped.extractSearchText!('hello world')).toBe('hello world');
    expect(wrapped.extractSearchText!({ foo: 'bar' })).toBe('{"foo":"bar"}');
    expect(wrapped.isResultTruncated!({})).toBe(false);
    expect(wrapped.renderToolUseMessage!({})).toBe('MinimalTool');
    expect(wrapped.renderToolResultMessage!('result')).toBe('result');
    expect(wrapped.renderToolResultMessage!({ x: 1 })).toBe('{"x":1}');
    expect(wrapped.renderToolUseErrorMessage!(new Error('oops'))).toBe('Error: oops');
  });

  test('tool-specific overrides take precedence over defaults', async () => {
    const { withToolDefaults } = await import('../tool-defaults.js');
    const custom: ToolDefinition = {
      name: 'CustomTool',
      description: 'Custom',
      inputSchema: { type: 'object' },
      execute: async () => '',
      maxResultSizeChars: 50_000,
      interruptBehavior: 'block',
      isResultTruncated: () => true,
    };
    const wrapped = withToolDefaults(custom);

    expect(wrapped.maxResultSizeChars).toBe(50_000);
    expect(wrapped.interruptBehavior).toBe('block');
    expect(wrapped.isResultTruncated!({})).toBe(true);
  });

  test('Bash tool has isSearchOrReadCommand specialization', () => {
    const registry = createDefaultToolRegistry('/tmp');
    const bash = registry.get('Bash')!;

    expect(typeof bash.isSearchOrReadCommand).toBe('function');

    expect(bash.isSearchOrReadCommand!({ command: 'grep foo bar.ts' })).toEqual({
      isSearch: true, isRead: false, isList: false,
    });
    expect(bash.isSearchOrReadCommand!({ command: 'cat README.md' })).toEqual({
      isSearch: false, isRead: true, isList: false,
    });
    expect(bash.isSearchOrReadCommand!({ command: 'ls -la' })).toEqual({
      isSearch: false, isRead: true, isList: true,
    });
    expect(bash.isSearchOrReadCommand!({ command: 'git commit -m "test"' })).toEqual({
      isSearch: false, isRead: false, isList: false,
    });
  });

  test('Read tool has extractSearchText specialization', () => {
    const registry = createDefaultToolRegistry('/tmp');
    const read = registry.get('Read')!;

    expect(typeof read.extractSearchText).toBe('function');

    // Extracts content from file output
    const output = { file: { content: 'line 1\nline 2', numLines: 2, startLine: 1, totalLines: 2 } };
    expect(read.extractSearchText!(output)).toBe('line 1\nline 2');

    // Falls back gracefully for image/other outputs
    expect(read.extractSearchText!({ type: 'image' })).toBe('');
  });

  test('Grep tool has isResultTruncated specialization', () => {
    const registry = createDefaultToolRegistry('/tmp');
    const grep = registry.get('Grep')!;

    expect(typeof grep.isResultTruncated).toBe('function');

    // Not truncated by default
    expect(grep.isResultTruncated!({ numLines: 10, filenames: [] })).toBe(false);
    // Explicit truncated flag
    expect(grep.isResultTruncated!({ truncated: true })).toBe(true);
    // matches array at threshold
    expect(grep.isResultTruncated!({ matches: new Array(250).fill(null) })).toBe(true);
    expect(grep.isResultTruncated!({ matches: new Array(249).fill(null) })).toBe(false);
  });
});
