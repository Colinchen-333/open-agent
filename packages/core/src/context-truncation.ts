/**
 * Provider-agnostic context window truncation.
 * Removes oldest message pairs to fit within a token budget.
 */

import { estimateMessageTokens } from './compact/index.js';

export interface TruncationResult {
  messages: unknown[];
  removedCount: number;
  estimatedTokens: number;
}

/**
 * Estimate tokens for a single message by wrapping it in an array
 * for compatibility with estimateMessageTokens (which expects an array).
 */
function estimateSingleMessage(msg: unknown): number {
  return estimateMessageTokens([msg]);
}

/**
 * Truncate messages to fit within a token budget.
 * Removes oldest assistant+user pairs first, preserving:
 * - The system prompt (if present as first message)
 * - The most recent N messages
 *
 * This is the centralized version of what was in openai.ts.
 */
export function truncateToTokenBudget(
  messages: unknown[],
  maxTokens: number,
  opts?: {
    /** Minimum messages to always keep at the end */
    keepLastN?: number;
    /** Reserve tokens for the response */
    reserveForOutput?: number;
  },
): TruncationResult {
  const keepLast = opts?.keepLastN ?? 4;
  const reserve = opts?.reserveForOutput ?? 0;
  const budget = maxTokens - reserve;

  if (budget <= 0) {
    return { messages: messages.slice(-keepLast), removedCount: messages.length - keepLast, estimatedTokens: 0 };
  }

  // Check if messages already fit
  let totalTokens = 0;
  for (const msg of messages) {
    totalTokens += estimateSingleMessage(msg);
  }

  if (totalTokens <= budget) {
    return { messages: [...messages], removedCount: 0, estimatedTokens: totalTokens };
  }

  // Remove from the front, preserving the first message (system) and last N
  const result = [...messages];
  let removedCount = 0;
  const protectedTail = keepLast;

  // Start removing from index 1 (after system message) up to length - keepLast
  while (totalTokens > budget && result.length > protectedTail + 1) {
    const removeIdx = 1; // Always remove the oldest non-system message
    const removed = result.splice(removeIdx, 1)[0];
    totalTokens -= estimateSingleMessage(removed);
    removedCount++;

    // If we removed an assistant message, also remove its following tool_result if present
    if (result[removeIdx] && (result[removeIdx] as any)?.role === 'user') {
      const content = (result[removeIdx] as any)?.content;
      if (Array.isArray(content) && content[0]?.type === 'tool_result') {
        totalTokens -= estimateSingleMessage(result[removeIdx]);
        result.splice(removeIdx, 1);
        removedCount++;
      }
    }
  }

  return { messages: result, removedCount, estimatedTokens: totalTokens };
}
