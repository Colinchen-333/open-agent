// Pricing per million tokens (USD)
const MODEL_PRICING: Record<string, { input: number; output: number }> = {
  // Anthropic — Claude 4.x family
  'claude-opus-4-6': { input: 15, output: 75 },
  'claude-sonnet-4-6': { input: 3, output: 15 },
  'claude-haiku-4-5-20251001': { input: 0.8, output: 4 },
  // Anthropic — Claude 3.5 family
  'claude-3-5-sonnet': { input: 3, output: 15 },
  'claude-3-5-haiku': { input: 0.8, output: 4 },
  // Anthropic — Claude 3 family
  'claude-3-opus': { input: 15, output: 75 },
  'claude-3-sonnet': { input: 3, output: 15 },
  'claude-3-haiku': { input: 0.25, output: 1.25 },
  // OpenAI
  'gpt-4o': { input: 2.5, output: 10 },
  'gpt-4o-mini': { input: 0.15, output: 0.6 },
  'gpt-4-turbo': { input: 10, output: 30 },
  'gpt-4': { input: 30, output: 60 },
  'o1': { input: 15, output: 60 },
  'o3': { input: 10, output: 40 },
  'o3-mini': { input: 1.1, output: 4.4 },
  'o4-mini': { input: 1.1, output: 4.4 },
  // Ollama (free/local)
  'llama3': { input: 0, output: 0 },
  'llama3.1': { input: 0, output: 0 },
  'codellama': { input: 0, output: 0 },
  'mistral': { input: 0, output: 0 },
  'deepseek': { input: 0, output: 0 },
  'qwen': { input: 0, output: 0 },
};

// Pre-sorted model prefixes by length (longest first) so that more specific
// models like "gpt-4o-mini" are matched before shorter prefixes like "gpt-4o".
const SORTED_PREFIXES = Object.keys(MODEL_PRICING).sort((a, b) => b.length - a.length);

/**
 * Calculate the cost in USD for a given number of tokens and model.
 * Returns 0 for unknown models.
 */
export function calculateCost(
  model: string,
  inputTokens: number,
  outputTokens: number,
  cacheCreationTokens = 0,
  cacheReadTokens = 0,
): number {
  // Try exact match first, then longest-prefix match
  let pricing = MODEL_PRICING[model];
  if (!pricing) {
    const prefix = SORTED_PREFIXES.find(k => model.startsWith(k));
    if (prefix) pricing = MODEL_PRICING[prefix];
  }
  if (!pricing) return 0;

  // Cache writes are billed at 1.25x input; cache reads at 0.1x input.
  const cacheWriteCost = (cacheCreationTokens * pricing.input * 1.25) / 1_000_000;
  const cacheReadCost = (cacheReadTokens * pricing.input * 0.1) / 1_000_000;
  return (inputTokens * pricing.input + outputTokens * pricing.output) / 1_000_000
    + cacheWriteCost + cacheReadCost;
}
