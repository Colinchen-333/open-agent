/**
 * An abstract summarizer: takes a batch of messages and returns a short text digest.
 * The conversation-loop provides the implementation (a closure over the real LLM provider).
 */
export interface MessageSummarizer {
  summarize(messagesToSummarize: ReadonlyArray<unknown>, options?: SummarizerOptions): Promise<string>;
}

export interface SummarizerOptions {
  /** Max tokens for the summary. */
  maxTokens?: number;
  /** Style hint: 'brief' | 'detailed'. */
  style?: 'brief' | 'detailed';
  /** Abort signal. */
  signal?: AbortSignal;
}

/** No-op summarizer: returns a placeholder. Used as a safe default when no LLM is wired. */
export const NOOP_SUMMARIZER: MessageSummarizer = {
  async summarize(messages) {
    return `[${messages.length} messages auto-compacted — no summarizer wired; use a real LLM summarizer for better results]`;
  },
};
