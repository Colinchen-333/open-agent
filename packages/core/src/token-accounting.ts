/**
 * Centralized per-turn token accounting.
 * Tracks input/output tokens, cache read/write, and cumulative cost.
 */

export interface TurnUsage {
  turnIndex: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  model: string;
  durationMs: number;
  timestamp: string;
  /** Estimated cost in USD (based on model pricing) */
  costUsd?: number;
}

export interface SessionUsage {
  turns: TurnUsage[];
  totalInputTokens: number;
  totalOutputTokens: number;
  totalCacheReadTokens: number;
  totalCacheWriteTokens: number;
  totalCostUsd: number;
  totalDurationMs: number;
}

/** Approximate pricing per 1M tokens (input/output) */
const MODEL_PRICING: Record<string, { input: number; output: number; cacheRead?: number }> = {
  'claude-sonnet-4-20250514': { input: 3, output: 15, cacheRead: 0.3 },
  'claude-opus-4-20250514': { input: 15, output: 75, cacheRead: 1.5 },
  'claude-haiku-3-20241022': { input: 0.8, output: 4, cacheRead: 0.08 },
  'gpt-4o': { input: 2.5, output: 10 },
  'gpt-4o-mini': { input: 0.15, output: 0.6 },
  'o3': { input: 10, output: 40 },
  // Fallback for unknown models
  default: { input: 3, output: 15 },
};

function getPricing(model: string): { input: number; output: number; cacheRead: number } {
  // Try exact match, then prefix match
  const exact = MODEL_PRICING[model];
  if (exact) return { input: exact.input, output: exact.output, cacheRead: exact.cacheRead ?? exact.input * 0.1 };

  for (const [key, pricing] of Object.entries(MODEL_PRICING)) {
    if (key !== 'default' && model.startsWith(key.split('-').slice(0, 2).join('-'))) {
      return { input: pricing.input, output: pricing.output, cacheRead: pricing.cacheRead ?? pricing.input * 0.1 };
    }
  }

  const fallback = MODEL_PRICING.default!;
  return { input: fallback.input, output: fallback.output, cacheRead: fallback.input * 0.1 };
}

function estimateCost(usage: TurnUsage): number {
  const pricing = getPricing(usage.model);
  const inputCost = (usage.inputTokens / 1_000_000) * pricing.input;
  const outputCost = (usage.outputTokens / 1_000_000) * pricing.output;
  const cacheCost = ((usage.cacheReadTokens ?? 0) / 1_000_000) * pricing.cacheRead;
  return inputCost + outputCost + cacheCost;
}

export class TokenAccountant {
  private turns: TurnUsage[] = [];

  /** Record a completed turn's token usage. */
  recordTurn(usage: Omit<TurnUsage, 'turnIndex' | 'costUsd'>): void {
    const turnIndex = this.turns.length;
    const costUsd = estimateCost({ ...usage, turnIndex, costUsd: 0 });
    this.turns.push({ ...usage, turnIndex, costUsd });
  }

  /** Get the full session usage summary. */
  getSessionUsage(): SessionUsage {
    let totalInput = 0, totalOutput = 0, totalCacheRead = 0, totalCacheWrite = 0, totalCost = 0, totalDuration = 0;
    for (const t of this.turns) {
      totalInput += t.inputTokens;
      totalOutput += t.outputTokens;
      totalCacheRead += t.cacheReadTokens ?? 0;
      totalCacheWrite += t.cacheWriteTokens ?? 0;
      totalCost += t.costUsd ?? 0;
      totalDuration += t.durationMs;
    }
    return {
      turns: [...this.turns],
      totalInputTokens: totalInput,
      totalOutputTokens: totalOutput,
      totalCacheReadTokens: totalCacheRead,
      totalCacheWriteTokens: totalCacheWrite,
      totalCostUsd: totalCost,
      totalDurationMs: totalDuration,
    };
  }

  /** Get the last N turns. */
  getRecentTurns(n: number): TurnUsage[] {
    return this.turns.slice(-n);
  }

  /** Get total token count (input + output). */
  getTotalTokens(): number {
    return this.turns.reduce((sum, t) => sum + t.inputTokens + t.outputTokens, 0);
  }

  /** Reset all accounting (new session). */
  reset(): void {
    this.turns = [];
  }
}
