import { describe, expect, test } from 'bun:test';
import { getModelCapability, supportsThinking, getContextWindowForModel } from '../model-capability';

describe('model capability registry', () => {
  test('getModelCapability returns Claude opus 4.6 capability', () => {
    const cap = getModelCapability('claude-opus-4-6');
    expect(cap).not.toBeNull();
    expect(cap!.contextWindow).toBe(1_000_000);
    expect(cap!.supportsThinking).toBe(true);
  });

  test('prefix match works for bracketed variants', () => {
    expect(getModelCapability('claude-opus-4-6[1m]')?.contextWindow).toBe(1_000_000);
  });

  test('returns null for truly unknown models', () => {
    expect(getModelCapability('fake-model-9000')).toBeNull();
  });

  test('supportsThinking is true for claude-opus-4-6', () => {
    expect(supportsThinking('claude-opus-4-6')).toBe(true);
  });

  test('supportsThinking is false for haiku-4-5', () => {
    expect(supportsThinking('claude-haiku-4-5')).toBe(false);
  });

  test('supportsThinking is false for glm-4.7', () => {
    expect(supportsThinking('glm-4.7')).toBe(false);
  });

  test('getContextWindowForModel returns 200_000 for unknown', () => {
    expect(getContextWindowForModel('fake-model-9000')).toBe(200_000);
  });

  test('getContextWindowForModel returns correct window for glm-4.7', () => {
    expect(getContextWindowForModel('glm-4.7')).toBe(128_000);
  });

  // ── New models: o3 and o4-mini ──────────────────────────────────────────

  test('o3 is in the registry with thinking support', () => {
    const cap = getModelCapability('o3');
    expect(cap).not.toBeNull();
    expect(cap!.supportsThinking).toBe(true);
    expect(cap!.contextWindow).toBe(200_000);
    expect(cap!.maxOutput).toBe(100_000);
  });

  test('o4-mini is in the registry with thinking support', () => {
    const cap = getModelCapability('o4-mini');
    expect(cap).not.toBeNull();
    expect(cap!.supportsThinking).toBe(true);
    expect(cap!.contextWindow).toBe(200_000);
    expect(cap!.maxOutput).toBe(100_000);
  });

  test('supportsThinking is true for o3', () => {
    expect(supportsThinking('o3')).toBe(true);
  });

  test('supportsThinking is true for o4-mini', () => {
    expect(supportsThinking('o4-mini')).toBe(true);
  });
});
