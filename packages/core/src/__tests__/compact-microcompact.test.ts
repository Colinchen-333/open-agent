import { describe, expect, test } from 'bun:test';
import { microcompact } from '../compact/microcompact';

describe('microcompact', () => {
  test('truncates oversized tool_result content', () => {
    const huge = 'x'.repeat(200_000);
    const messages = [
      { role: 'assistant', content: [{ type: 'tool_use', id: 't1', name: 'Read', input: {} }] },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: huge }] },
    ];
    const out = microcompact(messages, { maxResultSizeChars: 100_000 });
    const block = out[1].content[0] as any;
    // Length must be within budget plus marker overhead
    expect(block.content.length).toBeLessThanOrEqual(100_000 + 200);
    expect(block.content).toContain('truncated');
    expect(block.content).toContain('100000 chars dropped');
  });

  test('leaves small results alone', () => {
    const messages = [
      { role: 'assistant', content: [{ type: 'tool_use', id: 't1', name: 'Read', input: {} }] },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: 'small' }] },
    ];
    const out = microcompact(messages, { maxResultSizeChars: 100_000 });
    expect((out[1].content[0] as any).content).toBe('small');
  });

  test('keeps tool_use blocks untouched', () => {
    const messages = [
      { role: 'assistant', content: [{ type: 'tool_use', id: 't1', name: 'Read', input: { path: '/foo' } }] },
    ];
    const out = microcompact(messages, { maxResultSizeChars: 10 });
    expect(out[0].content[0]).toEqual({ type: 'tool_use', id: 't1', name: 'Read', input: { path: '/foo' } });
  });

  test('preserves other block properties when truncating', () => {
    const huge = 'a'.repeat(200_000);
    const messages = [
      {
        role: 'user',
        content: [{ type: 'tool_result', tool_use_id: 'tx', content: huge, is_error: false }],
      },
    ];
    const out = microcompact(messages, { maxResultSizeChars: 1_000 });
    const block = out[0].content[0] as any;
    expect(block.tool_use_id).toBe('tx');
    expect(block.is_error).toBe(false);
  });

  test('does not mutate the original messages array', () => {
    const huge = 'z'.repeat(200_000);
    const messages = [
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: huge }] },
    ];
    const out = microcompact(messages, { maxResultSizeChars: 100_000 });
    expect(out).not.toBe(messages);
    expect((messages[0].content[0] as any).content.length).toBe(200_000);
  });
});
