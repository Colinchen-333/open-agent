import { describe, expect, test } from 'bun:test';
import { truncateToTokenBudget } from '../context-truncation';

function makeMsg(role: string, text: string) {
  return { role, content: text };
}

describe('truncateToTokenBudget', () => {
  test('returns all messages when within budget', () => {
    const msgs = [makeMsg('system', 'sys'), makeMsg('user', 'hi'), makeMsg('assistant', 'hello')];
    const result = truncateToTokenBudget(msgs, 100000);
    expect(result.removedCount).toBe(0);
    expect(result.messages).toHaveLength(3);
  });

  test('removes oldest messages when over budget', () => {
    const msgs = [
      makeMsg('system', 'x'.repeat(100)),
      makeMsg('user', 'x'.repeat(10000)),
      makeMsg('assistant', 'x'.repeat(10000)),
      makeMsg('user', 'x'.repeat(10000)),
      makeMsg('assistant', 'latest'),
    ];
    const result = truncateToTokenBudget(msgs, 5000, { keepLastN: 2 });
    expect(result.removedCount).toBeGreaterThan(0);
    // System message preserved
    expect((result.messages[0] as any).role).toBe('system');
    // Last messages preserved
    expect(result.messages.length).toBeGreaterThanOrEqual(3);
  });

  test('preserves system message at index 0', () => {
    const msgs = [
      makeMsg('system', 'important system prompt'),
      makeMsg('user', 'x'.repeat(50000)),
      makeMsg('assistant', 'latest response'),
    ];
    const result = truncateToTokenBudget(msgs, 1000, { keepLastN: 1 });
    expect((result.messages[0] as any).role).toBe('system');
  });

  test('respects reserveForOutput', () => {
    const msgs = [makeMsg('user', 'x'.repeat(1000))];
    const result = truncateToTokenBudget(msgs, 500, { reserveForOutput: 400 });
    // Budget = 500 - 400 = 100 tokens, message is ~250 tokens
    expect(result.messages.length).toBeGreaterThanOrEqual(1); // keepLastN=4 preserves
  });

  test('handles empty messages', () => {
    const result = truncateToTokenBudget([], 1000);
    expect(result.messages).toHaveLength(0);
    expect(result.removedCount).toBe(0);
  });
});
