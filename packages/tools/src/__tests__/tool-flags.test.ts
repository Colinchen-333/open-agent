import { describe, expect, test } from 'bun:test';
import type { ToolDefinition } from '../types';

describe('ToolDefinition protocol flags', () => {
  test('isMcp flag', () => {
    const tool: Partial<ToolDefinition> = { isMcp: true };
    expect(tool.isMcp).toBe(true);
  });

  test('isLsp flag', () => {
    const tool: Partial<ToolDefinition> = { isLsp: true };
    expect(tool.isLsp).toBe(true);
  });

  test('strict mode flag', () => {
    const tool: Partial<ToolDefinition> = { strict: true };
    expect(tool.strict).toBe(true);
  });

  test('defaults to undefined (not set)', () => {
    const tool: Partial<ToolDefinition> = { name: 'Test' };
    expect(tool.isMcp).toBeUndefined();
    expect(tool.isLsp).toBeUndefined();
    expect(tool.strict).toBeUndefined();
  });
});
