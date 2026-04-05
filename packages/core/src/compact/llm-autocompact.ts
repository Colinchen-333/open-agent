import type { MessageSummarizer, SummarizerOptions } from './summarizer.js';

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

/** Decide whether to fire proactive autocompact based on message count + token estimate. */
export function shouldTriggerProactiveAutocompact(
  messages: ReadonlyArray<unknown>,
  options: { messageCountThreshold?: number; tokenThreshold?: number; estimatedTokens?: number } = {},
): boolean {
  const countThreshold = options.messageCountThreshold ?? 80;
  if (messages.length >= countThreshold) return true;
  if (options.estimatedTokens !== undefined && options.tokenThreshold !== undefined) {
    if (options.estimatedTokens >= options.tokenThreshold) return true;
  }
  return false;
}
