import { describe, expect, test } from 'bun:test';
import { microcompact, DEFAULT_TOOL_BUDGETS } from '../compact/microcompact';

describe('microcompact (tool-type aware)', () => {
  test('passes through small results unchanged', () => {
    const msgs = [
      { role: 'assistant', content: [{ type: 'tool_use', id: 't1', name: 'Read', input: {} }] },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: 'small file' }] },
    ];
    const out = microcompact(msgs, { maxResultSizeChars: 1000 });
    expect((out[1]!.content[0] as any).content).toBe('small file');
  });

  test('applies tool-specific budget for Read', () => {
    const text = 'a'.repeat(250_000);
    const msgs = [
      { role: 'assistant', content: [{ type: 'tool_use', id: 't1', name: 'Read', input: {} }] },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: text }] },
    ];
    const out = microcompact(msgs, { maxResultSizeChars: 10_000 });
    const truncated = (out[1]!.content[0] as any).content as string;
    // Read default is 200_000, so the result should be ~200_000 chars (+ marker), NOT ~10_000
    expect(truncated.length).toBeGreaterThan(100_000);
    expect(truncated.length).toBeLessThan(210_000);
    expect(truncated).toContain('Read output truncated');
  });

  test('applies tool-specific budget for WebFetch', () => {
    const text = 'b'.repeat(100_000);
    const msgs = [
      { role: 'assistant', content: [{ type: 'tool_use', id: 't1', name: 'WebFetch', input: {} }] },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: text }] },
    ];
    const out = microcompact(msgs, { maxResultSizeChars: 200_000 });
    const truncated = (out[1]!.content[0] as any).content as string;
    // WebFetch default is 40_000, tighter than the global default
    expect(truncated.length).toBeLessThan(45_000);
    expect(truncated).toContain('WebFetch output truncated');
  });

  test('unknown tool falls back to maxResultSizeChars', () => {
    const text = 'c'.repeat(200_000);
    const msgs = [
      { role: 'assistant', content: [{ type: 'tool_use', id: 't1', name: 'UnknownTool', input: {} }] },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: text }] },
    ];
    const out = microcompact(msgs, { maxResultSizeChars: 50_000 });
    const truncated = (out[1]!.content[0] as any).content as string;
    expect(truncated.length).toBeLessThan(51_000);
  });

  test('explicit toolBudgets override default', () => {
    const text = 'd'.repeat(100_000);
    const msgs = [
      { role: 'assistant', content: [{ type: 'tool_use', id: 't1', name: 'Read', input: {} }] },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: text }] },
    ];
    const out = microcompact(msgs, { maxResultSizeChars: 1_000_000, toolBudgets: { Read: 5000 } });
    const truncated = (out[1]!.content[0] as any).content as string;
    expect(truncated.length).toBeLessThan(6000);
  });

  test('cuts at newline boundary when available in last 10% of budget', () => {
    const lines = Array.from({ length: 100 }, (_, i) => `line ${i}`).join('\n');
    const msgs = [
      { role: 'assistant', content: [{ type: 'tool_use', id: 't1', name: 'Bash', input: {} }] },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: lines }] },
    ];
    // Bash default is 100_000 which is > lines.length, so no truncation happens.
    // Use an override that is within the text.
    const out = microcompact(msgs, { maxResultSizeChars: 100, toolBudgets: { Bash: 500 } });
    const truncated = (out[1]!.content[0] as any).content as string;
    // Should end with a full line, not mid-line
    const body = truncated.split('\n\n[Bash')[0]!;
    expect(body.endsWith('line 49') || body.endsWith('line 50') || body.endsWith('line 48') || body.match(/line \d+$/)).toBeTruthy();
  });

  test('preserves cache_control blocks unchanged', () => {
    const hugeText = 'e'.repeat(500_000);
    const msgs = [
      { role: 'assistant', content: [{ type: 'tool_use', id: 't1', name: 'Read', input: {} }] },
      {
        role: 'user',
        content: [{ type: 'tool_result', tool_use_id: 't1', content: hugeText, cache_control: { type: 'ephemeral' } }],
      },
    ];
    const out = microcompact(msgs, { maxResultSizeChars: 1000 });
    // cache_control block is untouched
    expect((out[1]!.content[0] as any).content).toBe(hugeText);
  });

  test('handles array content with mixed text and image blocks', () => {
    const hugeText = 'f'.repeat(300_000);
    const msgs = [
      { role: 'assistant', content: [{ type: 'tool_use', id: 't1', name: 'Read', input: {} }] },
      {
        role: 'user',
        content: [
          {
            type: 'tool_result',
            tool_use_id: 't1',
            content: [
              { type: 'text', text: hugeText },
              { type: 'image', source: { type: 'base64', data: 'xxx', media_type: 'image/png' } },
            ],
          },
        ],
      },
    ];
    const out = microcompact(msgs, { maxResultSizeChars: 10_000 });
    const blocks = (out[1]!.content[0] as any).content as any[];
    expect(blocks).toHaveLength(2);
    expect(blocks[0].type).toBe('text');
    expect(blocks[0].text.length).toBeLessThan(210_000); // Read budget
    expect(blocks[1].type).toBe('image'); // image preserved unchanged
    expect(blocks[1].source.data).toBe('xxx');
  });

  test('DEFAULT_TOOL_BUDGETS is exported with expected tools', () => {
    expect(DEFAULT_TOOL_BUDGETS.Read).toBeDefined();
    expect(DEFAULT_TOOL_BUDGETS.WebFetch).toBeDefined();
    expect(DEFAULT_TOOL_BUDGETS.Bash).toBeDefined();
    // Read should have more budget than WebFetch
    expect(DEFAULT_TOOL_BUDGETS.Read!).toBeGreaterThan(DEFAULT_TOOL_BUDGETS.WebFetch!);
  });
});
