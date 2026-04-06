/**
 * Per-model capability registry for known LLM models.
 *
 * Provides a lookup API for context window size, max output tokens, and
 * feature flags (thinking, vision, prompt-caching). This data is compiled
 * from published model documentation and is intentionally conservative for
 * unknown models.
 */

export interface ModelCapability {
  /** Maximum tokens in the context window (input + output). */
  contextWindow: number;
  /** Maximum tokens the model can emit per response. */
  maxOutput: number;
  /** Whether the model supports extended thinking / reasoning tokens. */
  supportsThinking: boolean;
  /** Whether the model can process image inputs. */
  supportsVision: boolean;
  /** Whether the model supports prompt caching (Anthropic cache_control, etc.). */
  supportsPromptCaching: boolean;
}

// ---------------------------------------------------------------------------
// Registry — exact model IDs → capability
// ---------------------------------------------------------------------------

/**
 * Internal registry map. Keys are the canonical model identifiers exactly as
 * they would be passed to the API. Prefix matching is applied as a fallback
 * (see getModelCapability).
 */
const REGISTRY: Record<string, ModelCapability> = {
  // ── Anthropic Claude Opus 4 ─────────────────────────────────────────────
  'claude-opus-4': {
    contextWindow: 1_000_000,
    maxOutput: 32_000,
    supportsThinking: true,
    supportsVision: true,
    supportsPromptCaching: true,
  },
  'claude-opus-4-6': {
    contextWindow: 1_000_000,
    maxOutput: 32_000,
    supportsThinking: true,
    supportsVision: true,
    supportsPromptCaching: true,
  },
  'claude-opus-4-6[1m]': {
    contextWindow: 1_000_000,
    maxOutput: 32_000,
    supportsThinking: true,
    supportsVision: true,
    supportsPromptCaching: true,
  },

  // ── Anthropic Claude Sonnet 4 ────────────────────────────────────────────
  'claude-sonnet-4': {
    contextWindow: 1_000_000,
    maxOutput: 32_000,
    supportsThinking: true,
    supportsVision: true,
    supportsPromptCaching: true,
  },
  'claude-sonnet-4-6': {
    contextWindow: 1_000_000,
    maxOutput: 32_000,
    supportsThinking: true,
    supportsVision: true,
    supportsPromptCaching: true,
  },

  // ── Anthropic Claude Haiku 4.5 ───────────────────────────────────────────
  'claude-haiku-4-5': {
    contextWindow: 200_000,
    maxOutput: 16_000,
    supportsThinking: false,
    supportsVision: true,
    supportsPromptCaching: true,
  },
  'claude-haiku-4-5-20251001': {
    contextWindow: 200_000,
    maxOutput: 16_000,
    supportsThinking: false,
    supportsVision: true,
    supportsPromptCaching: true,
  },

  // ── Anthropic Claude 3.5 Sonnet ──────────────────────────────────────────
  'claude-3-5-sonnet': {
    contextWindow: 200_000,
    maxOutput: 8192,
    supportsThinking: false,
    supportsVision: true,
    supportsPromptCaching: true,
  },
  'claude-3-5-sonnet-20241022': {
    contextWindow: 200_000,
    maxOutput: 8192,
    supportsThinking: false,
    supportsVision: true,
    supportsPromptCaching: true,
  },

  // ── Anthropic Claude 3.5 Haiku ───────────────────────────────────────────
  'claude-3-5-haiku': {
    contextWindow: 200_000,
    maxOutput: 8192,
    supportsThinking: false,
    supportsVision: false,
    supportsPromptCaching: true,
  },

  // ── Anthropic Claude 3 Opus ──────────────────────────────────────────────
  'claude-3-opus': {
    contextWindow: 200_000,
    maxOutput: 4096,
    supportsThinking: false,
    supportsVision: true,
    supportsPromptCaching: false,
  },

  // ── OpenAI GPT-4o ────────────────────────────────────────────────────────
  'gpt-4o': {
    contextWindow: 128_000,
    maxOutput: 16_000,
    supportsThinking: false,
    supportsVision: true,
    supportsPromptCaching: false,
  },
  'gpt-4o-2024-11-20': {
    contextWindow: 128_000,
    maxOutput: 16_000,
    supportsThinking: false,
    supportsVision: true,
    supportsPromptCaching: false,
  },

  // ── OpenAI GPT-4o mini ───────────────────────────────────────────────────
  'gpt-4o-mini': {
    contextWindow: 128_000,
    maxOutput: 16_000,
    supportsThinking: false,
    supportsVision: true,
    supportsPromptCaching: false,
  },

  // ── OpenAI GPT-5 ─────────────────────────────────────────────────────────
  'gpt-5': {
    contextWindow: 272_000,
    maxOutput: 128_000,
    supportsThinking: true,
    supportsVision: true,
    supportsPromptCaching: false,
  },

  // ── OpenAI o3 ────────────────────────────────────────────────────────────
  'o3': {
    contextWindow: 200_000,
    maxOutput: 100_000,
    supportsThinking: true,
    supportsVision: true,
    supportsPromptCaching: false,
  },

  // ── OpenAI o4-mini ───────────────────────────────────────────────────────
  'o4-mini': {
    contextWindow: 200_000,
    maxOutput: 100_000,
    supportsThinking: true,
    supportsVision: true,
    supportsPromptCaching: false,
  },

  // ── Zhipu GLM-4.7 ────────────────────────────────────────────────────────
  'glm-4.7': {
    contextWindow: 128_000,
    maxOutput: 16_000,
    supportsThinking: false,
    supportsVision: false,
    supportsPromptCaching: false,
  },

  // ── Zhipu GLM-4 ──────────────────────────────────────────────────────────
  'glm-4': {
    contextWindow: 128_000,
    maxOutput: 8192,
    supportsThinking: false,
    supportsVision: false,
    supportsPromptCaching: false,
  },

  // ── Zhipu GLM-4-flash ────────────────────────────────────────────────────
  'glm-4-flash': {
    contextWindow: 128_000,
    maxOutput: 8192,
    supportsThinking: false,
    supportsVision: false,
    supportsPromptCaching: false,
  },
};

// Pre-compute sorted keys once for deterministic prefix matching.
// Longer keys are checked first so that `claude-opus-4-6` matches before
// `claude-opus-4` when the model string is `claude-opus-4-6-something`.
const SORTED_KEYS = Object.keys(REGISTRY).sort((a, b) => b.length - a.length);

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Look up the capability record for a model identifier.
 *
 * Matching is done in two passes:
 * 1. Exact match against the registry key.
 * 2. Prefix match — the model string starts with a registry key.
 *    Longer keys are preferred over shorter ones to avoid false positives.
 *
 * Returns `null` when no match is found.
 */
export function getModelCapability(model: string): ModelCapability | null {
  // Pass 1 — exact
  const exact = REGISTRY[model];
  if (exact !== undefined) {
    return exact;
  }

  // Pass 2 — prefix (keys sorted longest-first)
  for (const key of SORTED_KEYS) {
    if (model.startsWith(key)) {
      return REGISTRY[key]!;
    }
  }

  return null;
}

/**
 * Returns `true` when the model supports extended thinking/reasoning tokens.
 * Returns `false` for unknown models (conservative default).
 */
export function supportsThinking(model: string): boolean {
  return getModelCapability(model)?.supportsThinking ?? false;
}

/**
 * Returns the context window size (in tokens) for a known model.
 * Falls back to `200_000` as a safe conservative default for unknown models.
 */
export function getContextWindowForModel(model: string): number {
  return getModelCapability(model)?.contextWindow ?? 200_000;
}
