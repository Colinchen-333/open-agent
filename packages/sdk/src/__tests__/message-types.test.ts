import { describe, expect, test } from 'bun:test';
import type {
  SDKToolProgressMessage,
  SDKToolUseSummaryMessage,
  SDKRateLimitEvent,
  SDKCompactBoundaryMessage,
  SDKPostTurnSummaryMessage,
  SDKAPIRetryMessage,
} from '../message-types';

describe('SDK message types', () => {
  test('SDKToolProgressMessage shape', () => {
    const msg: SDKToolProgressMessage = {
      type: 'tool_progress',
      toolUseId: 'tu-1',
      toolName: 'Bash',
      progress: 'Running command...',
      timestamp: new Date().toISOString(),
    };
    expect(msg.type).toBe('tool_progress');
  });

  test('SDKRateLimitEvent shape', () => {
    const msg: SDKRateLimitEvent = {
      type: 'rate_limit',
      retryAfterMs: 5000,
      provider: 'anthropic',
      model: 'claude-sonnet-4',
    };
    expect(msg.retryAfterMs).toBe(5000);
  });

  test('SDKPostTurnSummaryMessage shape', () => {
    const msg: SDKPostTurnSummaryMessage = {
      type: 'post_turn_summary',
      turnIndex: 3,
      inputTokens: 1000,
      outputTokens: 500,
      costUsd: 0.01,
      durationMs: 1500,
    };
    expect(msg.turnIndex).toBe(3);
  });

  test('SDKAPIRetryMessage shape', () => {
    const msg: SDKAPIRetryMessage = {
      type: 'api_retry',
      attempt: 2,
      maxAttempts: 3,
      delayMs: 2000,
      error: 'rate limit',
    };
    expect(msg.attempt).toBe(2);
  });
});
