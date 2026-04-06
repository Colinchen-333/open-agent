import { describe, expect, test } from 'bun:test';
import type { ToolDefinition } from '../types';

describe('ToolDefinition metadata fields', () => {
  test('searchHint is optional string', () => {
    const tool: Partial<ToolDefinition> = { searchHint: 'test search hint' };
    expect(tool.searchHint).toBe('test search hint');
  });

  test('isEnabled as boolean', () => {
    const tool: Partial<ToolDefinition> = { isEnabled: false };
    expect(tool.isEnabled).toBe(false);
  });

  test('isEnabled as function', () => {
    const tool: Partial<ToolDefinition> = { isEnabled: () => true };
    expect(typeof tool.isEnabled).toBe('function');
    expect((tool.isEnabled as () => boolean)()).toBe(true);
  });

  test('toAutoClassifierInput returns string', () => {
    const tool: Partial<ToolDefinition> = {
      toAutoClassifierInput: (input: any) => `Bash ${input.command}`,
    };
    expect(tool.toAutoClassifierInput!({ command: 'ls' })).toBe('Bash ls');
  });

  test('checkPermissions returns decision', () => {
    const tool: Partial<ToolDefinition> = {
      checkPermissions: () => 'allow',
    };
    expect(tool.checkPermissions!({})).toBe('allow');
  });
});
