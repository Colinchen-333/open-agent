import { describe, expect, test } from 'bun:test';
import { calculateRetryDelay, isRetryableError, withRetry } from '../query-engine';

describe('calculateRetryDelay', () => {
  test('increases exponentially', () => {
    const d0 = calculateRetryDelay(0, 1000);
    const d1 = calculateRetryDelay(1, 1000);
    const d2 = calculateRetryDelay(2, 1000);
    expect(d1).toBeGreaterThan(d0);
    expect(d2).toBeGreaterThan(d1);
  });

  test('caps at 30 seconds', () => {
    const d = calculateRetryDelay(10, 1000);
    expect(d).toBeLessThanOrEqual(33000); // 30s + 10% jitter
  });
});

describe('isRetryableError', () => {
  test('rate limit is retryable', () => {
    expect(isRetryableError(new Error('rate limit exceeded'))).toBe(true);
  });

  test('429 is retryable', () => {
    expect(isRetryableError(new Error('HTTP 429'))).toBe(true);
  });

  test('500 is retryable', () => {
    expect(isRetryableError(new Error('500 Internal Server Error'))).toBe(true);
  });

  test('auth error is NOT retryable', () => {
    expect(isRetryableError(new Error('unauthorized'))).toBe(false);
  });

  test('non-Error is not retryable', () => {
    expect(isRetryableError('string error')).toBe(false);
  });
});

describe('withRetry', () => {
  test('succeeds on first try', async () => {
    const { result, retriesUsed } = await withRetry(async () => 'ok');
    expect(result).toBe('ok');
    expect(retriesUsed).toBe(0);
  });

  test('retries on retryable error', async () => {
    let attempt = 0;
    const { result, retriesUsed } = await withRetry(
      async () => {
        if (attempt++ < 2) throw new Error('rate limit');
        return 'success';
      },
      { maxRetries: 3, baseDelayMs: 10 },
    );
    expect(result).toBe('success');
    expect(retriesUsed).toBe(2);
  });

  test('throws on non-retryable error', async () => {
    expect(
      withRetry(async () => { throw new Error('unauthorized'); }, { maxRetries: 3 }),
    ).rejects.toThrow('unauthorized');
  });

  test('throws after max retries', async () => {
    expect(
      withRetry(async () => { throw new Error('rate limit'); }, { maxRetries: 1, baseDelayMs: 10 }),
    ).rejects.toThrow('rate limit');
  });

  test('respects abort signal', async () => {
    const controller = new AbortController();
    controller.abort();
    expect(
      withRetry(async () => 'ok', { signal: controller.signal }),
    ).rejects.toThrow('Aborted');
  });
});
