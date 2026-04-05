import { describe, expect, test } from 'bun:test';
import { estimateTokens, estimateMessageTokens } from '../compact/token-estimate';

describe('token estimator', () => {
  test('estimateTokens counts ~ chars/4', () => {
    expect(estimateTokens('')).toBe(0);
    expect(estimateTokens('hi')).toBe(1);  // ceil(2/4) = 1
    expect(estimateTokens('a'.repeat(40))).toBe(10);
  });

  test('estimateMessageTokens extracts text blocks', () => {
    const msgs = [
      { role: 'user', content: 'hello world, this is a test message' },
      { role: 'assistant', content: [{ type: 'text', text: 'response text' }] },
    ];
    const tokens = estimateMessageTokens(msgs);
    expect(tokens).toBeGreaterThan(10);
  });

  test('estimateMessageTokens extracts tool_use input JSON', () => {
    const msgs = [
      { role: 'assistant', content: [{ type: 'tool_use', id: 't1', name: 'Read', input: { file_path: '/tmp/x.txt' } }] },
    ];
    const tokens = estimateMessageTokens(msgs);
    expect(tokens).toBeGreaterThan(5);
  });

  test('estimateMessageTokens extracts tool_result content', () => {
    const msgs = [
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: 'file contents here' }] },
    ];
    const tokens = estimateMessageTokens(msgs);
    expect(tokens).toBeGreaterThan(3);
  });

  test('estimateMessageTokens extracts thinking blocks', () => {
    const msgs = [
      { role: 'assistant', content: [{ type: 'thinking', thinking: 'internal reasoning about the problem' }] },
    ];
    expect(estimateMessageTokens(msgs)).toBeGreaterThan(5);
  });
});
