import { describe, expect, test } from 'bun:test';
import { mergeCapabilities, type NegotiatedCapabilities } from '../capability-negotiation';

describe('mergeCapabilities', () => {
  test('returns static capabilities when no probe result', () => {
    const caps = mergeCapabilities('claude-sonnet-4');
    expect(caps.supportsThinking).toBe(true);
    expect(caps.supportsVision).toBe(true);
  });

  test('runtime overrides static', () => {
    const caps = mergeCapabilities('claude-sonnet-4', {
      supportsThinking: false,
    });
    expect(caps.supportsThinking).toBe(false);
  });

  test('keeps static values for non-overridden fields', () => {
    const caps = mergeCapabilities('claude-sonnet-4', {
      supportsVision: false,
    });
    expect(caps.supportsPromptCaching).toBe(true); // not overridden
    expect(caps.supportsVision).toBe(false); // overridden
  });

  test('overrides context window', () => {
    const caps = mergeCapabilities('gpt-4o', {
      maxContextWindow: 256000,
    });
    expect(caps.contextWindow).toBe(256000);
  });

  test('overrides max output tokens', () => {
    const caps = mergeCapabilities('gpt-4o', {
      maxOutputTokens: 32000,
    });
    expect(caps.maxOutput).toBe(32000);
  });

  test('handles unknown model with fallback', () => {
    const caps = mergeCapabilities('unknown-model', {
      supportsThinking: true,
      modelAvailable: true,
    });
    expect(caps.supportsThinking).toBe(true);
    // Fallback defaults
    expect(caps.contextWindow).toBe(200_000);
    expect(caps.maxOutput).toBe(4096);
  });

  test('unknown model without probe uses conservative fallback', () => {
    const caps = mergeCapabilities('unknown-model');
    expect(caps.supportsThinking).toBe(false);
    expect(caps.supportsVision).toBe(false);
    expect(caps.supportsPromptCaching).toBe(false);
    expect(caps.contextWindow).toBe(200_000);
    expect(caps.maxOutput).toBe(4096);
  });

  test('preserves all base fields for known model', () => {
    const caps = mergeCapabilities('claude-opus-4');
    expect(caps.contextWindow).toBe(1_000_000);
    expect(caps.maxOutput).toBe(32_000);
    expect(typeof caps.supportsThinking).toBe('boolean');
    expect(typeof caps.supportsVision).toBe('boolean');
    expect(typeof caps.supportsPromptCaching).toBe('boolean');
  });

  test('does not mutate when no probe result', () => {
    const caps1 = mergeCapabilities('gpt-4o');
    const caps2 = mergeCapabilities('gpt-4o');
    // Each call should return a fresh object
    expect(caps1).not.toBe(caps2);
    expect(caps1).toEqual(caps2);
  });
});
