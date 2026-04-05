import { describe, it, expect } from 'bun:test';
import {
  thinkingBudgetFromEffort,
  resolveWantsThinking,
  buildAnthropicThinkingParam,
} from '../thinking.js';
import type { ChatOptions } from '../types.js';

// ---------------------------------------------------------------------------
// thinkingBudgetFromEffort
// ---------------------------------------------------------------------------

describe('thinkingBudgetFromEffort', () => {
  it('maps "low" to 8_000 tokens', () => {
    expect(thinkingBudgetFromEffort('low')).toBe(8_000);
  });

  it('maps "medium" to 16_000 tokens', () => {
    expect(thinkingBudgetFromEffort('medium')).toBe(16_000);
  });

  it('maps "high" to 32_000 tokens', () => {
    expect(thinkingBudgetFromEffort('high')).toBe(32_000);
  });

  it('maps "max" to 60_000 tokens', () => {
    expect(thinkingBudgetFromEffort('max')).toBe(60_000);
  });

  it('falls back to 16_000 (medium) when effort is undefined', () => {
    expect(thinkingBudgetFromEffort(undefined)).toBe(16_000);
  });
});

// ---------------------------------------------------------------------------
// resolveWantsThinking
// ---------------------------------------------------------------------------

describe('resolveWantsThinking', () => {
  it('returns false for undefined', () => {
    expect(resolveWantsThinking(undefined)).toBe(false);
  });

  it('returns false for { type: "disabled" }', () => {
    expect(resolveWantsThinking({ type: 'disabled' })).toBe(false);
  });

  it('returns true for { type: "enabled" }', () => {
    expect(resolveWantsThinking({ type: 'enabled' })).toBe(true);
  });

  it('returns true for { type: "enabled", budgetTokens: 5000 }', () => {
    expect(resolveWantsThinking({ type: 'enabled', budgetTokens: 5_000 })).toBe(true);
  });

  it('returns true for { type: "adaptive" } (Phase 1 — treated as enabled)', () => {
    expect(resolveWantsThinking({ type: 'adaptive' })).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// buildAnthropicThinkingParam
// ---------------------------------------------------------------------------

describe('buildAnthropicThinkingParam', () => {
  // Helper: a thinking-capable model
  const thinkingModel = 'claude-sonnet-4-6';
  // Helper: a model that does NOT support thinking (per model-capability registry)
  const nonThinkingModel = 'glm-4.7';

  it('returns undefined when thinking is disabled', () => {
    const result = buildAnthropicThinkingParam({
      model: thinkingModel,
      thinking: { type: 'disabled' },
    });
    expect(result).toBeUndefined();
  });

  it('returns undefined when thinking is undefined', () => {
    const result = buildAnthropicThinkingParam({
      model: thinkingModel,
      thinking: undefined,
    });
    expect(result).toBeUndefined();
  });

  it('returns undefined when model does not support thinking (even if enabled)', () => {
    const result = buildAnthropicThinkingParam({
      model: nonThinkingModel,
      thinking: { type: 'enabled' },
    });
    expect(result).toBeUndefined();
  });

  it('returns thinking param with budget derived from effort when enabled without explicit budget', () => {
    const result = buildAnthropicThinkingParam({
      model: thinkingModel,
      thinking: { type: 'enabled' },
      effort: 'high',
    });
    expect(result).toBeDefined();
    expect(result!.type).toBe('enabled');
    expect(result!.budget_tokens).toBe(32_000); // 'high' → 32_000
  });

  it('respects explicit budgetTokens over effort-derived budget', () => {
    const result = buildAnthropicThinkingParam({
      model: thinkingModel,
      thinking: { type: 'enabled', budgetTokens: 5_000 },
      effort: 'low',
    });
    expect(result).toBeDefined();
    expect(result!.budget_tokens).toBe(5_000);
  });

  it('uses 16_000 (medium fallback) when enabled without effort or budget', () => {
    const result = buildAnthropicThinkingParam({
      model: thinkingModel,
      thinking: { type: 'enabled' },
    });
    expect(result).toBeDefined();
    expect(result!.budget_tokens).toBe(16_000);
  });

  it('returns enabled param for adaptive mode on a capable model', () => {
    const result = buildAnthropicThinkingParam({
      model: thinkingModel,
      thinking: { type: 'adaptive' },
      effort: 'medium',
    });
    expect(result).toBeDefined();
    expect(result!.type).toBe('enabled');
    expect(result!.budget_tokens).toBe(16_000);
  });

  it('returns undefined for adaptive mode on a non-thinking model', () => {
    const result = buildAnthropicThinkingParam({
      model: nonThinkingModel,
      thinking: { type: 'adaptive' },
    });
    expect(result).toBeUndefined();
  });

  // ---- temperature contract (documented via options shape) ----

  it('returns type "enabled" (caller is responsible for setting temperature 1.0 when non-undefined)', () => {
    // The function itself doesn't set temperature — the caller (chat()) does.
    // This test just verifies the returned shape is correct so chat() can use it.
    const result = buildAnthropicThinkingParam({
      model: thinkingModel,
      thinking: { type: 'enabled' },
      effort: 'max',
    });
    expect(result?.type).toBe('enabled');
    expect(result?.budget_tokens).toBe(60_000);
  });
});
