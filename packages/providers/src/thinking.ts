import type Anthropic from '@anthropic-ai/sdk';
import type { ThinkingConfig } from '@open-agent/core';
import type { ChatOptions } from './types.js';
import { supportsThinking } from './model-capability.js';

// ---------------------------------------------------------------------------
// Effort → budget mapping
// ---------------------------------------------------------------------------

/**
 * Derive an Anthropic thinking `budget_tokens` value from an effort level.
 *
 * These are conservative defaults chosen to stay within practical cost/latency
 * budgets while providing meaningful reasoning depth per level.
 */
export function thinkingBudgetFromEffort(effort: ChatOptions['effort'] | undefined): number {
  switch (effort) {
    case 'low':    return 8_000;
    case 'medium': return 16_000;
    case 'high':   return 32_000;
    case 'max':    return 60_000;
    default:       return 16_000; // fallback = medium
  }
}

// ---------------------------------------------------------------------------
// ThinkingConfig → boolean
// ---------------------------------------------------------------------------

/**
 * Resolve a `ThinkingConfig` (or absence thereof) into a plain boolean that
 * indicates whether the caller wants extended thinking enabled.
 *
 * - `{ type: 'enabled' }` → true
 * - `{ type: 'adaptive' }` → true  (treated as enabled in Phase 1; adaptive
 *   routing is future work)
 * - `{ type: 'disabled' }` → false
 * - `undefined` → false
 */
export function resolveWantsThinking(thinking: ThinkingConfig | undefined): boolean {
  if (thinking === undefined) return false;
  return thinking.type !== 'disabled';
}

// ---------------------------------------------------------------------------
// Pure request-body helper
// ---------------------------------------------------------------------------

/**
 * Build the Anthropic `thinking` parameter for a `messages.stream` call,
 * gating on both the caller's config and the model's capability.
 *
 * Returns `undefined` when thinking should be omitted from the request body
 * (disabled by config, or the model doesn't support it).
 *
 * When thinking IS enabled this function also enforces the Anthropic API
 * constraint that `temperature` must be `1.0`.
 */
export function buildAnthropicThinkingParam(
  options: Pick<ChatOptions, 'thinking' | 'effort' | 'model'>,
): Anthropic.Messages.ThinkingConfigEnabled | undefined {
  if (!resolveWantsThinking(options.thinking)) return undefined;
  if (!supportsThinking(options.model)) return undefined;

  const thinking = options.thinking as ThinkingConfig;

  // If the caller explicitly supplied a budget, honour it; otherwise derive
  // from the effort level using the conservative defaults table.
  const budgetTokens =
    thinking.type === 'enabled' && thinking.budgetTokens !== undefined
      ? thinking.budgetTokens
      : thinkingBudgetFromEffort(options.effort);

  return {
    type: 'enabled',
    budget_tokens: budgetTokens,
  };
}
