import { describe, expect, test } from 'bun:test';
import type { ToolDefinition } from '../types';

describe('ToolDefinition extended fields', () => {
  test('aliases is optional string array', () => {
    const tool: Partial<ToolDefinition> = { aliases: ['FileRead', 'Cat'] };
    expect(tool.aliases).toEqual(['FileRead', 'Cat']);
  });

  test('alwaysLoad is optional boolean', () => {
    const tool: Partial<ToolDefinition> = { alwaysLoad: true };
    expect(tool.alwaysLoad).toBe(true);
  });

  test('isDestructive as boolean', () => {
    const tool: Partial<ToolDefinition> = { isDestructive: true };
    expect(tool.isDestructive).toBe(true);
  });

  test('isDestructive as function', () => {
    const tool: Partial<ToolDefinition> = {
      isDestructive: (input: any) => input?.force === true,
    };
    expect(typeof tool.isDestructive).toBe('function');
    expect((tool.isDestructive as Function)({ force: true })).toBe(true);
    expect((tool.isDestructive as Function)({ force: false })).toBe(false);
  });

  test('isOpenWorld as boolean', () => {
    const tool: Partial<ToolDefinition> = { isOpenWorld: true };
    expect(tool.isOpenWorld).toBe(true);
  });

  test('isOpenWorld as function', () => {
    const tool: Partial<ToolDefinition> = {
      isOpenWorld: (input: any) => !!input?.url,
    };
    expect((tool.isOpenWorld as Function)({ url: 'http://example.com' })).toBe(true);
    expect((tool.isOpenWorld as Function)({})).toBe(false);
  });
});
