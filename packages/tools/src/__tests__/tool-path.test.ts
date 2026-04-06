import { describe, expect, test } from 'bun:test';
import { extractToolPath, getToolDisplayName, areToolInputsEquivalent } from '../tool-path';
import type { ToolDefinition } from '../types';

function makeTool(overrides?: Partial<ToolDefinition>): ToolDefinition {
  return {
    name: 'Test',
    description: 'test',
    inputSchema: { type: 'object' },
    execute: async () => 'ok',
    ...overrides,
  } as ToolDefinition;
}

describe('extractToolPath', () => {
  test('returns path from getPath', () => {
    const tool = makeTool({ getPath: (input: any) => input?.file_path ?? null });
    expect(extractToolPath(tool, { file_path: '/test.ts' })).toBe('/test.ts');
  });

  test('returns null when no getPath', () => {
    expect(extractToolPath(makeTool(), { file_path: '/test.ts' })).toBeNull();
  });

  test('returns null when input has no path', () => {
    const tool = makeTool({ getPath: (input: any) => input?.file_path ?? null });
    expect(extractToolPath(tool, {})).toBeNull();
  });
});

describe('getToolDisplayName', () => {
  test('returns userFacingName when present', () => {
    const tool = makeTool({ userFacingName: (input: any) => `Bash(${input?.cmd})` });
    expect(getToolDisplayName(tool, { cmd: 'ls' })).toBe('Bash(ls)');
  });

  test('falls back to static name', () => {
    expect(getToolDisplayName(makeTool())).toBe('Test');
  });

  test('falls back when no input provided', () => {
    const tool = makeTool({ userFacingName: () => 'Dynamic' });
    expect(getToolDisplayName(tool)).toBe('Test');
  });
});

describe('areToolInputsEquivalent', () => {
  test('uses custom comparator', () => {
    const tool = makeTool({
      inputsEquivalent: (a: any, b: any) => a?.path === b?.path,
    });
    expect(areToolInputsEquivalent(tool, { path: '/a' }, { path: '/a' })).toBe(true);
    expect(areToolInputsEquivalent(tool, { path: '/a' }, { path: '/b' })).toBe(false);
  });

  test('falls back to JSON equality', () => {
    const tool = makeTool();
    expect(areToolInputsEquivalent(tool, { a: 1 }, { a: 1 })).toBe(true);
    expect(areToolInputsEquivalent(tool, { a: 1 }, { a: 2 })).toBe(false);
  });
});
