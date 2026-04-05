import type { MessageSummarizer, SummarizerOptions } from './summarizer.js';
import { estimateMessageTokens } from './token-estimate.js';

// ---------------------------------------------------------------------------
// Effective context window
// ---------------------------------------------------------------------------

export interface ContextWindowConfig {
  /** Raw model context window (tokens). */
  contextWindow: number;
  /** Reserved tokens for the model's output. Default: 16_000. */
  reservedOutputTokens?: number;
  /** Safety buffer as a fraction of contextWindow. Default: 0.1. */
  safetyBufferRatio?: number;
}

/**
 * Compute the effective context window: the number of tokens the conversation
 * history can use before the model hits the wall.
 *
 * effective = contextWindow - reservedOutput - safetyBuffer
 *
 * The safety buffer (10% by default) prevents racing the absolute token limit
 * and accounts for system-prompt overhead that is not tracked in message tokens.
 */
export function computeEffectiveContextWindow(config: ContextWindowConfig): number {
  const reserved = config.reservedOutputTokens ?? 16_000;
  const buffer = Math.floor(config.contextWindow * (config.safetyBufferRatio ?? 0.1));
  return Math.max(0, config.contextWindow - reserved - buffer);
}

export interface LlmAutocompactOptions {
  /** Messages in the "protected tail" (most recent N turns) that must not be summarized. */
  protectedTailSize?: number;
  /** Summarizer style. */
  style?: 'brief' | 'detailed';
  /** Max tokens for the summary. */
  maxSummaryTokens?: number;
  /** Abort signal. */
  signal?: AbortSignal;
}

export interface LlmAutocompactResult {
  /** Compacted message list. */
  messages: unknown[];
  /** True if a summary was actually generated. */
  didCompact: boolean;
  /** The generated summary text (empty string if didCompact === false). */
  summaryText: string;
  /** Number of messages replaced by the summary. */
  messagesReplaced: number;
}

/**
 * Ask an LLM to summarize old turns and replace them with a single system message.
 *
 * Algorithm:
 *   1. Split `messages` into `toSummarize` (old) + `protectedTail` (last N turns kept verbatim)
 *   2. If `toSummarize` is empty or too short to matter, return unchanged
 *   3. Call summarizer.summarize(toSummarize) → digest text
 *   4. Replace `toSummarize` with a single system message: { role: 'system', content: `[Conversation summary]\n${digest}` }
 *   5. Return the new array + protectedTail
 */
export async function llmAutocompact(
  messages: ReadonlyArray<unknown>,
  summarizer: MessageSummarizer,
  options: LlmAutocompactOptions = {},
): Promise<LlmAutocompactResult> {
  const protectedTailSize = options.protectedTailSize ?? 4;
  if (messages.length <= protectedTailSize + 2) {
    // Not enough material to summarize meaningfully
    return {
      messages: [...messages],
      didCompact: false,
      summaryText: '',
      messagesReplaced: 0,
    };
  }

  const splitAt = messages.length - protectedTailSize;
  const toSummarize = messages.slice(0, splitAt);
  const protectedTail = messages.slice(splitAt);

  const summarizerOptions: SummarizerOptions = {
    maxTokens: options.maxSummaryTokens ?? 2000,
    style: options.style ?? 'brief',
    signal: options.signal,
  };

  const summary = await summarizer.summarize(toSummarize, summarizerOptions);

  const summaryMessage = {
    role: 'system',
    content: `[Conversation summary — ${toSummarize.length} earlier messages compacted]\n\n${summary}`,
  };

  return {
    messages: [summaryMessage, ...protectedTail],
    didCompact: true,
    summaryText: summary,
    messagesReplaced: toSummarize.length,
  };
}

export interface ProactiveAutocompactTriggerOptions {
  /** Legacy: absolute message count threshold. */
  messageCountThreshold?: number;
  /** Explicit token threshold. If omitted, derived from model context window. */
  tokenThreshold?: number;
  /** Model name for context window lookup. */
  model?: string;
  /** Model context window (tokens). If omitted, resolved via getContextWindowForModel(model). */
  contextWindow?: number;
  /** Pre-computed estimated token count. If omitted, computed via estimateMessageTokens(messages). */
  estimatedTokens?: number;
  /** Circuit breaker: if the last compact produced less than this reduction ratio, don't retry. */
  minReductionRatio?: number;
  /** Circuit breaker: last observed ratio (from a prior compact). */
  lastReductionRatio?: number;
  /**
   * Effective context window config. When provided, the effective window
   * (contextWindow - reservedOutput - safetyBuffer) is used as the denominator
   * for band thresholds instead of the raw contextWindow at 60%.
   */
  windowConfig?: ContextWindowConfig;
  /**
   * Number of consecutive compacts that failed to reduce size meaningfully
   * (< 15% reduction). Tracked by the caller across turns.
   */
  consecutiveIneffectiveCompacts?: number;
  /**
   * Maximum consecutive ineffective compacts before the circuit breaker trips
   * and compact is suppressed entirely. Default: 3.
   */
  maxConsecutiveIneffective?: number;
}

/**
 * Context window bands (applied against the *effective* context window):
 *   safe:    < 60%
 *   warning: 60–85%
 *   error:   ≥ 85%
 *
 * Proactive compact fires in warning or error band.
 *
 * Priority of circuit breakers (highest → lowest):
 *  1. Consecutive-failure counter ≥ maxConsecutiveIneffective → back off entirely
 *  2. Legacy single-ratio breaker (minReductionRatio / lastReductionRatio)
 *  3. Band evaluation against effective window (windowConfig preferred)
 *  4. Raw contextWindow × 0.6 (legacy)
 *  5. Explicit tokenThreshold
 *  6. Message count threshold (legacy fallback)
 */
export function shouldTriggerProactiveAutocompact(
  messages: ReadonlyArray<unknown>,
  options: ProactiveAutocompactTriggerOptions = {},
): boolean {
  // ── Circuit breaker 1: N consecutive ineffective compacts ─────────────────
  const maxFails = options.maxConsecutiveIneffective ?? 3;
  if ((options.consecutiveIneffectiveCompacts ?? 0) >= maxFails) {
    // Back off completely until an external reset (user /compact or new session)
    return false;
  }

  // ── Circuit breaker 2: legacy single-ratio breaker ────────────────────────
  if (
    typeof options.lastReductionRatio === 'number' &&
    typeof options.minReductionRatio === 'number' &&
    options.lastReductionRatio < options.minReductionRatio
  ) {
    return false;
  }

  // ── Legacy path: fixed message count threshold ────────────────────────────
  const countThreshold = options.messageCountThreshold ?? 80;
  if (messages.length >= countThreshold) return true;

  // ── Token-aware path ──────────────────────────────────────────────────────
  const tokens = options.estimatedTokens ?? estimateMessageTokens(messages);

  if (options.windowConfig) {
    // ── New path: full effective-window band evaluation ───────────────────
    // Compute effective = contextWindow - reservedOutput - safetyBuffer, then
    // apply warning (60%) and error (85%) bands against that effective figure.
    const effectiveWindow = computeEffectiveContextWindow(options.windowConfig);
    const warningThreshold = Math.floor(effectiveWindow * 0.6);
    const errorThreshold  = Math.floor(effectiveWindow * 0.85);

    if (tokens >= warningThreshold) return true;
    if (tokens >= errorThreshold)   return true;
  } else {
    // ── Legacy path: flat contextWindow × 0.6 threshold ──────────────────
    // Preserved for backward compatibility when only contextWindow (not
    // windowConfig) is supplied.
    let legacyThreshold: number | undefined = options.tokenThreshold;

    if (legacyThreshold === undefined && options.contextWindow !== undefined) {
      legacyThreshold = Math.floor(options.contextWindow * 0.6);
    }
    if (legacyThreshold === undefined && options.model) {
      try {
        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const { getContextWindowForModel } = require('@open-agent/providers');
        const modelWindow: number = getContextWindowForModel(options.model);
        legacyThreshold = Math.floor(modelWindow * 0.6);
      } catch {
        /* fall through */
      }
    }

    if (legacyThreshold !== undefined && tokens >= legacyThreshold) return true;
  }

  return false;
}

/**
 * Compute the context-window band for observability / UI display.
 *
 * Accepts either a raw number (legacy — bands are raw-window fractions) or a
 * ContextWindowConfig (bands are effective-window fractions after subtracting
 * reserved output tokens and the safety buffer).
 */
export function getContextWindowBand(
  tokens: number,
  contextWindowOrConfig: number | ContextWindowConfig,
): 'safe' | 'warning' | 'error' {
  const effective =
    typeof contextWindowOrConfig === 'number'
      ? contextWindowOrConfig
      : computeEffectiveContextWindow(contextWindowOrConfig);

  const ratio = tokens / effective;
  if (ratio >= 0.85) return 'error';
  if (ratio >= 0.6) return 'warning';
  return 'safe';
}
