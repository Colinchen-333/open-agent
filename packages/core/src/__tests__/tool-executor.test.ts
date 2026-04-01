import { describe, it, expect, mock } from 'bun:test';
import { StreamingToolExecutor } from '../tool-executor.js';
import type { ToolDefinition, ToolContext } from '@open-agent/tools';

function makeTool(name: string, opts: {
  concurrent?: boolean;
  result?: any;
  delay?: number;
  onExecute?: () => void;
} = {}): ToolDefinition {
  return {
    name,
    description: `test tool ${name}`,
    inputSchema: { type: 'object', properties: {} },
    isConcurrencySafe: opts.concurrent ?? true,
    async execute(input: any, ctx: ToolContext) {
      opts.onExecute?.();
      if (opts.delay) await new Promise(r => setTimeout(r, opts.delay));
      return opts.result ?? { ok: true };
    },
  };
}

function makeCtx(): ToolContext {
  return { cwd: '/tmp', sessionId: 'test-session' };
}

describe('StreamingToolExecutor', () => {
  it('executes a single tool and yields result', async () => {
    const tools = new Map([['read', makeTool('read', { result: 'file content' })]]);
    const executor = new StreamingToolExecutor(tools, makeCtx(), 'test-session');

    executor.addTool({ id: 'tu_1', name: 'read', input: {} });

    const results: any[] = [];
    for await (const event of executor.getResults()) {
      results.push(event);
    }

    expect(results).toHaveLength(1);
    expect(results[0].type).toBe('tool_result');
    expect(results[0].tool_name).toBe('read');
    expect(results[0].result).toBe('"file content"');
  });

  it('runs concurrent-safe tools in parallel', async () => {
    const order: string[] = [];
    const tools = new Map([
      ['a', makeTool('a', { concurrent: true, delay: 50, onExecute: () => order.push('a-start') })],
      ['b', makeTool('b', { concurrent: true, delay: 10, onExecute: () => order.push('b-start') })],
    ]);
    const executor = new StreamingToolExecutor(tools, makeCtx(), 'test-session');

    executor.addTool({ id: 'tu_1', name: 'a', input: {} });
    executor.addTool({ id: 'tu_2', name: 'b', input: {} });

    const results: any[] = [];
    for await (const event of executor.getResults()) {
      results.push(event);
    }

    // Both should have started before either finished
    expect(order).toEqual(['a-start', 'b-start']);
    // Results come back in add order, not completion order
    expect(results[0].tool_name).toBe('a');
    expect(results[1].tool_name).toBe('b');
  });

  it('runs non-concurrent tools sequentially', async () => {
    const order: string[] = [];
    const tools = new Map([
      ['a', makeTool('a', { concurrent: false, delay: 30, onExecute: () => order.push('a') })],
      ['b', makeTool('b', { concurrent: false, delay: 10, onExecute: () => order.push('b') })],
    ]);
    const executor = new StreamingToolExecutor(tools, makeCtx(), 'test-session');

    executor.addTool({ id: 'tu_1', name: 'a', input: {} });
    executor.addTool({ id: 'tu_2', name: 'b', input: {} });

    const results: any[] = [];
    for await (const event of executor.getResults()) {
      results.push(event);
    }

    expect(results[0].tool_name).toBe('a');
    expect(results[1].tool_name).toBe('b');
  });

  it('yields results in add order even when fast tool finishes first', async () => {
    const tools = new Map([
      ['slow', makeTool('slow', { concurrent: true, delay: 80, result: 'slow-done' })],
      ['fast', makeTool('fast', { concurrent: true, delay: 10, result: 'fast-done' })],
    ]);
    const executor = new StreamingToolExecutor(tools, makeCtx(), 'test-session');

    executor.addTool({ id: 'tu_1', name: 'slow', input: {} });
    executor.addTool({ id: 'tu_2', name: 'fast', input: {} });

    const results: any[] = [];
    for await (const event of executor.getResults()) {
      results.push(event);
    }

    expect(results[0].result).toBe('"slow-done"');
    expect(results[1].result).toBe('"fast-done"');
  });

  it('handles tool execution errors gracefully', async () => {
    const tools = new Map([
      ['fail', {
        name: 'fail',
        description: 'fails',
        inputSchema: { type: 'object', properties: {} },
        isConcurrencySafe: true,
        async execute() { throw new Error('boom'); },
      } as ToolDefinition],
    ]);
    const executor = new StreamingToolExecutor(tools, makeCtx(), 'test-session');

    executor.addTool({ id: 'tu_1', name: 'fail', input: {} });

    const results: any[] = [];
    for await (const event of executor.getResults()) {
      results.push(event);
    }

    expect(results[0].type).toBe('tool_result');
    expect(results[0].is_error).toBe(true);
    expect(results[0].result).toContain('boom');
  });

  it('handles unknown tool gracefully', async () => {
    const tools = new Map<string, ToolDefinition>();
    const executor = new StreamingToolExecutor(tools, makeCtx(), 'test-session');

    executor.addTool({ id: 'tu_1', name: 'nonexistent', input: {} });

    const results: any[] = [];
    for await (const event of executor.getResults()) {
      results.push(event);
    }

    expect(results[0].is_error).toBe(true);
    expect(results[0].result).toContain('Unknown tool');
  });

  it('abort() cancels pending tools', async () => {
    const tools = new Map([
      ['slow', makeTool('slow', { concurrent: true, delay: 5000, result: 'done' })],
    ]);
    const executor = new StreamingToolExecutor(tools, makeCtx(), 'test-session');

    executor.addTool({ id: 'tu_1', name: 'slow', input: {} });

    setTimeout(() => executor.abort(), 20);

    const results: any[] = [];
    for await (const event of executor.getResults()) {
      results.push(event);
    }

    expect(results[0].type).toBe('tool_result');
    expect(results[0].is_error).toBe(true);
  });
});
