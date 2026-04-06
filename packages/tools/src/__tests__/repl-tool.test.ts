import { describe, expect, test, afterEach } from 'bun:test';
import { createREPLTool } from '../repl-tool';
import { setFeatureDefault, clearFeatureOverrides } from '@open-agent/core';

const ctx = { cwd: '/tmp', sessionId: 'repl-test', toolUseId: 'r1' } as any;

describe('REPL tool', () => {
  afterEach(() => clearFeatureOverrides());

  test('returns error when feature flag is off', async () => {
    const tool = createREPLTool();
    const result = await tool.execute({ code: '1 + 1' }, ctx);
    expect(result.error).toContain('not enabled');
  });

  test('evaluates simple expression', async () => {
    setFeatureDefault('REPL_TOOL', true);
    const tool = createREPLTool();
    // No explicit `return` needed — last expression value is captured via eval
    const result = await tool.execute({ code: '2 + 3' }, ctx);
    expect(result.output).toContain('5');
    expect(result.exitCode).toBe(0);
  });

  test('evaluates multiline code', async () => {
    setFeatureDefault('REPL_TOOL', true);
    const tool = createREPLTool();
    const result = await tool.execute({
      code: 'const x = [1,2,3]; x.map(n => n * 2)',
    }, ctx);
    // JSON.stringify pretty-prints arrays; check individual values
    expect(result.output).toContain('2');
    expect(result.output).toContain('4');
    expect(result.output).toContain('6');
  });

  test('captures errors in user code', async () => {
    setFeatureDefault('REPL_TOOL', true);
    const tool = createREPLTool();
    const result = await tool.execute({ code: 'throw new Error("boom")' }, ctx);
    expect(result.exitCode).not.toBe(0);
  });

  test('rejects empty code', async () => {
    setFeatureDefault('REPL_TOOL', true);
    const tool = createREPLTool();
    const result = await tool.execute({ code: '   ' }, ctx);
    expect(result.error).toContain('non-empty');
  });

  test('times out long-running code', async () => {
    setFeatureDefault('REPL_TOOL', true);
    const tool = createREPLTool({ timeout: 500 });
    const result = await tool.execute({
      code: 'await new Promise(r => setTimeout(r, 10000))',
    }, ctx);
    expect(result.error).toContain('timed out');
  }, 5000);
});
