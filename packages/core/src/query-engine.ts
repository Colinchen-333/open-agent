/**
 * Query engine abstraction for structured LLM queries.
 * Encapsulates turn budget, retry logic, abort handling,
 * and token tracking into a single query lifecycle.
 */

export interface QueryOptions {
  /** Maximum turns for this query */
  maxTurns?: number;
  /** Abort signal */
  abortSignal?: AbortSignal;
  /** Retry count on provider errors */
  maxRetries?: number;
  /** Base delay between retries in ms */
  retryDelayMs?: number;
  /** Token budget for the query */
  maxTokens?: number;
  /** Whether this is a background query (lower priority) */
  isBackground?: boolean;
}

export interface QueryResult {
  /** Final assistant message text */
  text: string;
  /** Number of turns used */
  turnsUsed: number;
  /** Whether the query was aborted */
  aborted: boolean;
  /** Whether the query exhausted its turn budget */
  exhaustedBudget: boolean;
  /** Total tokens used */
  totalTokens: number;
  /** Total wall-clock time in ms */
  durationMs: number;
  /** Number of retries that were needed */
  retriesUsed: number;
}

/**
 * Exponential backoff with jitter for retry delays.
 */
export function calculateRetryDelay(attempt: number, baseMs: number): number {
  const exponential = baseMs * Math.pow(2, attempt);
  const jitter = Math.random() * exponential * 0.1;
  return Math.min(exponential + jitter, 30_000); // cap at 30s
}

/**
 * Check if an error is retryable (rate limit, server error, network).
 */
export function isRetryableError(error: unknown): boolean {
  if (error instanceof Error) {
    const msg = error.message.toLowerCase();
    return (
      msg.includes('rate limit') ||
      msg.includes('429') ||
      msg.includes('500') ||
      msg.includes('502') ||
      msg.includes('503') ||
      msg.includes('timeout') ||
      msg.includes('econnreset') ||
      msg.includes('econnrefused') ||
      msg.includes('fetch failed')
    );
  }
  return false;
}

/**
 * Execute a function with retry logic.
 */
export async function withRetry<T>(
  fn: () => Promise<T>,
  opts?: { maxRetries?: number; baseDelayMs?: number; signal?: AbortSignal },
): Promise<{ result: T; retriesUsed: number }> {
  const maxRetries = opts?.maxRetries ?? 3;
  const baseDelay = opts?.baseDelayMs ?? 1000;
  let retriesUsed = 0;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      if (opts?.signal?.aborted) throw new Error('Aborted');
      const result = await fn();
      return { result, retriesUsed };
    } catch (error) {
      if (attempt === maxRetries || !isRetryableError(error)) throw error;
      retriesUsed++;
      const delay = calculateRetryDelay(attempt, baseDelay);
      await new Promise(resolve => setTimeout(resolve, delay));
    }
  }

  throw new Error('Unreachable');
}
