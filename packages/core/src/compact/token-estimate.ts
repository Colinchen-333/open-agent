/**
 * Rough token estimate for a message list. Uses character/word heuristics since
 * no tokenizer is bundled. Good enough for trigger decisions.
 *
 * Rule of thumb for English: 1 token ≈ 4 chars or ≈ 0.75 words.
 * We use 4 chars per token as a conservative overestimate.
 */
export function estimateTokens(text: string): number {
  if (!text) return 0;
  return Math.ceil(text.length / 4);
}

/**
 * Estimate tokens for a list of messages. Recursively extracts text from
 * content arrays (text blocks, tool_use inputs, tool_result contents).
 */
export function estimateMessageTokens(messages: ReadonlyArray<unknown>): number {
  let total = 0;
  for (const msg of messages) {
    total += estimateSingleMessageTokens(msg);
  }
  // Add a small fixed overhead per message for JSON structure + role tokens
  total += messages.length * 4;
  return total;
}

function estimateSingleMessageTokens(msg: unknown): number {
  if (!msg || typeof msg !== 'object') return 0;
  const m = msg as Record<string, unknown>;
  const content = m.content;
  if (typeof content === 'string') {
    return estimateTokens(content);
  }
  if (Array.isArray(content)) {
    let sum = 0;
    for (const block of content) {
      if (!block || typeof block !== 'object') continue;
      const b = block as Record<string, unknown>;
      if (b.type === 'text' && typeof b.text === 'string') {
        sum += estimateTokens(b.text);
      } else if (b.type === 'tool_use') {
        // Tool input JSON
        try { sum += estimateTokens(JSON.stringify(b.input ?? {})); } catch { /* skip */ }
      } else if (b.type === 'tool_result') {
        const innerContent = b.content;
        if (typeof innerContent === 'string') {
          sum += estimateTokens(innerContent);
        } else if (Array.isArray(innerContent)) {
          for (const inner of innerContent) {
            if (inner && typeof inner === 'object' && (inner as any).type === 'text') {
              sum += estimateTokens((inner as any).text ?? '');
            }
          }
        }
      } else if (b.type === 'thinking' && typeof b.thinking === 'string') {
        sum += estimateTokens(b.thinking);
      }
    }
    return sum;
  }
  return 0;
}
