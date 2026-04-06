import { describe, expect, test } from 'bun:test';
import { getToolDescription, getToolPrompt, collectToolPrompts } from '../tool-description';
import type { ToolDefinition } from '../types';

function makeTool(overrides?: Partial<ToolDefinition>): ToolDefinition {
  return {
    name: 'TestTool',
    description: 'Static description',
    inputSchema: { type: 'object', properties: {} },
    execute: async () => 'ok',
    ...overrides,
  } as ToolDefinition;
}

describe('getToolDescription', () => {
  test('returns static description when no dynamic', () => {
    const tool = makeTool();
    expect(getToolDescription(tool)).toBe('Static description');
  });

  test('returns dynamic description when present', () => {
    const tool = makeTool({
      dynamicDescription: () => 'Dynamic description',
    });
    expect(getToolDescription(tool)).toBe('Dynamic description');
  });

  test('passes context to dynamic description', () => {
    const tool = makeTool({
      dynamicDescription: (ctx) => ctx?.isNonInteractive ? 'non-interactive' : 'interactive',
    });
    expect(getToolDescription(tool, { isNonInteractive: true })).toBe('non-interactive');
    expect(getToolDescription(tool, { isNonInteractive: false })).toBe('interactive');
  });
});

describe('getToolPrompt', () => {
  test('returns null when no prompt', () => {
    expect(getToolPrompt(makeTool())).toBeNull();
  });

  test('returns prompt string when present', () => {
    const tool = makeTool({ prompt: () => 'Use this tool carefully.' });
    expect(getToolPrompt(tool)).toBe('Use this tool carefully.');
  });

  test('passes context to prompt', () => {
    const tool = makeTool({
      prompt: (ctx) => ctx?.permissionMode === 'bypassPermissions' ? 'auto-approved' : 'needs approval',
    });
    expect(getToolPrompt(tool, { permissionMode: 'bypassPermissions' })).toBe('auto-approved');
  });
});

describe('collectToolPrompts', () => {
  test('collects prompts from tools that have them', () => {
    const tools = [
      makeTool({ prompt: () => 'Prompt A' }),
      makeTool(), // no prompt
      makeTool({ prompt: () => 'Prompt C' }),
    ];
    const prompts = collectToolPrompts(tools);
    expect(prompts).toEqual(['Prompt A', 'Prompt C']);
  });

  test('returns empty array when no tools have prompts', () => {
    expect(collectToolPrompts([makeTool(), makeTool()])).toEqual([]);
  });
});
