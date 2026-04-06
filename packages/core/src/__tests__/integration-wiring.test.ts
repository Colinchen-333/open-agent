import { describe, expect, test } from 'bun:test';
import { TokenAccountant } from '../token-accounting';
import { validateConfig } from '../config-validator';
import { recordCollapseCommit, resetContextCollapse, getCollapseStats } from '../compact/index';

describe('integration wiring smoke tests', () => {
  test('TokenAccountant records and retrieves', () => {
    const acc = new TokenAccountant();
    acc.recordTurn({ inputTokens: 100, outputTokens: 50, model: 'test', durationMs: 10, timestamp: '' });
    expect(acc.getSessionUsage().totalInputTokens).toBe(100);
  });

  test('validateConfig catches invalid types', () => {
    const result = validateConfig({ model: 42 as any });
    expect(result.valid).toBe(false);
    expect(result.errors.length).toBeGreaterThan(0);
    expect(result.errors[0].path).toBe('model');
  });

  test('recordCollapseCommit updates stats', () => {
    resetContextCollapse();
    recordCollapseCommit({ id: 'test', summary: 's', messageCount: 5, tokensSaved: 100, timestamp: '' });
    expect(getCollapseStats().collapsedSpans).toBe(1);
    resetContextCollapse();
  });

  test('TokenAccountant tracks multiple turns', () => {
    const acc = new TokenAccountant();
    acc.recordTurn({ inputTokens: 100, outputTokens: 50, model: 'test', durationMs: 10, timestamp: '' });
    acc.recordTurn({ inputTokens: 200, outputTokens: 100, cacheReadTokens: 30, model: 'test', durationMs: 20, timestamp: '' });
    const usage = acc.getSessionUsage();
    expect(usage.totalInputTokens).toBe(300);
    expect(usage.totalOutputTokens).toBe(150);
    expect(usage.totalCacheReadTokens).toBe(30);
    expect(usage.turns.length).toBe(2);
  });

  test('validateConfig passes valid config through', () => {
    const result = validateConfig({ model: 'claude-sonnet-4-20250514', verbose: true });
    expect(result.valid).toBe(true);
    expect(result.errors.length).toBe(0);
    expect(result.cleaned.model).toBe('claude-sonnet-4-20250514');
  });
});
