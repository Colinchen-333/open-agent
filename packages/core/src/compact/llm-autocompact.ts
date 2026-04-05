import type { MessageSummarizer, SummarizerOptions } from './summarizer.js';
import { estimateMessageTokens } from './token-estimate.js';

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
}

/**
 * Context window bands:
 *   safe:    <60%
 *   warning: 60-85%
 *   error:   >85%
 *
 * Proactive compact fires in warning or error band.
 */
export function shouldTriggerProactiveAutocompact(
  messages: ReadonlyArray<unknown>,
  options: ProactiveAutocompactTriggerOptions = {},
): boolean {
  // Circuit breaker: skip if previous compact was ineffective
  if (
    typeof options.lastReductionRatio === 'number' &&
    typeof options.minReductionRatio === 'number' &&
    options.lastReductionRatio < options.minReductionRatio
  ) {
    return false;
  }

  // Legacy path: fixed message count threshold
  const countThreshold = options.messageCountThreshold ?? 80;
  if (messages.length >= countThreshold) return true;

  // Token-aware path: compute tokens and compare against model context window band
  let tokens = options.estimatedTokens;
  if (tokens === undefined) {
    tokens = estimateMessageTokens(messages);
  }

  // Resolve threshold: explicit > derived from context window
  let threshold = options.tokenThreshold;
  if (threshold === undefined && options.contextWindow !== undefined) {
    // Warning band: 60% of window
    threshold = Math.floor(options.contextWindow * 0.6);
  }
  if (threshold === undefined && options.model) {
    // Use require to avoid a static circular import (core should not statically depend on providers)
    try {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const { getContextWindowForModel } = require('@open-agent/providers');
      const window = getContextWindowForModel(options.model);
      threshold = Math.floor(window * 0.6);
    } catch {
      /* fall through */
    }
  }

  if (threshold !== undefined && tokens >= threshold) return true;

  return false;
}

/**
 * Compute the context-window band for observability / UI display.
 */
export function getContextWindowBand(
  tokens: number,
  contextWindow: number,
): 'safe' | 'warning' | 'error' {
  const ratio = tokens / contextWindow;
  if (ratio >= 0.85) return 'error';
  if (ratio >= 0.6) return 'warning';
  return 'safe';
}
