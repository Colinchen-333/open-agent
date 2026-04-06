import { describe, expect, test, beforeEach } from 'bun:test';
import { TokenAccountant } from '../token-accounting';

describe('TokenAccountant', () => {
  let accountant: TokenAccountant;

  beforeEach(() => {
    accountant = new TokenAccountant();
  });

  test('starts with empty usage', () => {
    const usage = accountant.getSessionUsage();
    expect(usage.turns).toHaveLength(0);
    expect(usage.totalInputTokens).toBe(0);
    expect(usage.totalOutputTokens).toBe(0);
  });

  test('records a turn with auto-assigned index', () => {
    accountant.recordTurn({
      inputTokens: 1000,
      outputTokens: 500,
      model: 'claude-sonnet-4-20250514',
      durationMs: 1500,
      timestamp: new Date().toISOString(),
    });
    const usage = accountant.getSessionUsage();
    expect(usage.turns).toHaveLength(1);
    expect(usage.turns[0].turnIndex).toBe(0);
    expect(usage.totalInputTokens).toBe(1000);
    expect(usage.totalOutputTokens).toBe(500);
  });

  test('accumulates across multiple turns', () => {
    accountant.recordTurn({ inputTokens: 100, outputTokens: 50, model: 'gpt-4o', durationMs: 500, timestamp: '' });
    accountant.recordTurn({ inputTokens: 200, outputTokens: 100, model: 'gpt-4o', durationMs: 800, timestamp: '' });
    const usage = accountant.getSessionUsage();
    expect(usage.turns).toHaveLength(2);
    expect(usage.totalInputTokens).toBe(300);
    expect(usage.totalOutputTokens).toBe(150);
    expect(usage.totalDurationMs).toBe(1300);
  });

  test('estimates cost based on model pricing', () => {
    accountant.recordTurn({
      inputTokens: 1_000_000,
      outputTokens: 1_000_000,
      model: 'claude-sonnet-4-20250514',
      durationMs: 1000,
      timestamp: '',
    });
    const cost = accountant.getSessionUsage().totalCostUsd;
    expect(cost).toBeGreaterThan(0);
    // Sonnet: $3/M input + $15/M output = $18 for 1M each
    expect(cost).toBeCloseTo(18, 0);
  });

  test('includes cache tokens in accounting', () => {
    accountant.recordTurn({
      inputTokens: 500,
      outputTokens: 200,
      cacheReadTokens: 300,
      cacheWriteTokens: 100,
      model: 'gpt-4o',
      durationMs: 400,
      timestamp: '',
    });
    const usage = accountant.getSessionUsage();
    expect(usage.totalCacheReadTokens).toBe(300);
    expect(usage.totalCacheWriteTokens).toBe(100);
  });

  test('getRecentTurns returns last N', () => {
    for (let i = 0; i < 5; i++) {
      accountant.recordTurn({ inputTokens: i * 10, outputTokens: i, model: 'm', durationMs: 10, timestamp: '' });
    }
    const recent = accountant.getRecentTurns(2);
    expect(recent).toHaveLength(2);
    expect(recent[0].turnIndex).toBe(3);
    expect(recent[1].turnIndex).toBe(4);
  });

  test('getTotalTokens sums input + output', () => {
    accountant.recordTurn({ inputTokens: 100, outputTokens: 50, model: 'm', durationMs: 10, timestamp: '' });
    expect(accountant.getTotalTokens()).toBe(150);
  });

  test('reset clears all state', () => {
    accountant.recordTurn({ inputTokens: 100, outputTokens: 50, model: 'm', durationMs: 10, timestamp: '' });
    accountant.reset();
    expect(accountant.getSessionUsage().turns).toHaveLength(0);
    expect(accountant.getTotalTokens()).toBe(0);
  });

  test('handles unknown model with fallback pricing', () => {
    accountant.recordTurn({ inputTokens: 1000, outputTokens: 500, model: 'unknown-model-v1', durationMs: 100, timestamp: '' });
    const cost = accountant.getSessionUsage().totalCostUsd;
    expect(cost).toBeGreaterThan(0);
  });
});
