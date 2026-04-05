import { describe, expect, test } from 'bun:test';
import { runCompactPipeline } from '../compact';

describe('runCompactPipeline', () => {
  test('applies snip then microcompact in sequence', () => {
    const huge = 'y'.repeat(200_000);
    const messages = [
      { role: 'user', content: [{ type: 'text', text: 'turn 1' }] },
      { role: 'assistant', content: [{ type: 'tool_use', id: 't1', name: 'R', input: {} }] },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: huge }] },
      { role: 'user', content: [{ type: 'text', text: 'turn 2' }] },
      { role: 'assistant', content: [{ type: 'tool_use', id: 't2', name: 'R', input: {} }] },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't2', content: huge }] },
    ];

    const out = runCompactPipeline(messages, { keepLastN: 1, maxResultSizeChars: 50_000 });

    // t1 is an older turn — snip replaces its content with a short placeholder
    const t1Result = (out[2].content[0] as any).content as string;
    expect(t1Result.length).toBeLessThan(200);
    expect(t1Result).toContain('snipped');

    // t2 is the most recent turn — snip keeps it, then microcompact truncates it
    const t2Result = (out[5].content[0] as any).content as string;
    expect(t2Result.length).toBeGreaterThan(50_000);
    expect(t2Result.length).toBeLessThan(60_000);
    expect(t2Result).toContain('truncated');
  });

  test('returns a new array without mutating originals', () => {
    const messages = [
      { role: 'assistant', content: [{ type: 'tool_use', id: 't1', name: 'R', input: {} }] },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: 'x'.repeat(200_000) }] },
    ];
    const out = runCompactPipeline(messages, { keepLastN: 0, maxResultSizeChars: 50_000 });
    expect(out).not.toBe(messages);
    expect((messages[1].content[0] as any).content.length).toBe(200_000);
  });

  test('handles empty message array', () => {
    const out = runCompactPipeline([], { keepLastN: 1, maxResultSizeChars: 100_000 });
    expect(out).toEqual([]);
  });
});
