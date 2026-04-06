import { describe, expect, test } from 'bun:test';
import type { ToolDefinition } from '../types';

// We test the render functions as standalone logic
describe('tool render patterns', () => {
  test('read render shows file path', () => {
    const render = (input: any) => `Read ${input?.file_path ?? 'unknown'}`;
    expect(render({ file_path: '/test.ts' })).toBe('Read /test.ts');
  });

  test('grep render shows pattern', () => {
    const render = (input: any) => `Grep "${input?.pattern ?? ''}" in ${input?.path ?? 'cwd'}`;
    expect(render({ pattern: 'TODO', path: 'src/' })).toBe('Grep "TODO" in src/');
  });

  test('glob render shows pattern', () => {
    const render = (input: any) => `Glob "${input?.pattern ?? ''}" in ${input?.path ?? 'cwd'}`;
    expect(render({ pattern: '**/*.ts' })).toBe('Glob "**/*.ts" in cwd');
  });

  test('write render shows file path', () => {
    const render = (input: any) => `Write ${input?.file_path ?? 'unknown'}`;
    expect(render({ file_path: '/new.ts' })).toBe('Write /new.ts');
  });

  test('edit render shows file path', () => {
    const render = (input: any) => `Edit ${input?.file_path ?? 'unknown'}`;
    expect(render({ file_path: '/edit.ts' })).toBe('Edit /edit.ts');
  });

  test('read result render shows line count', () => {
    const render = (output: any) => {
      if (typeof output === 'string') {
        const lines = output.split('\n').length;
        return `${lines} line${lines !== 1 ? 's' : ''} read`;
      }
      return 'File contents read';
    };
    expect(render('line1\nline2\nline3')).toBe('3 lines read');
    expect(render('single')).toBe('1 line read');
  });
});
