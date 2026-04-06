import { describe, expect, test, afterEach } from 'bun:test';
import {
  feature,
  setFeatureDefault,
  clearFeatureOverrides,
  FEATURE_FLAG_DEFAULTS,
  type FeatureFlagName,
} from '../feature-flags';

describe('feature flags', () => {
  afterEach(() => {
    clearFeatureOverrides();
    // Also clear any env vars we set
    for (const name of Object.keys(FEATURE_FLAG_DEFAULTS) as FeatureFlagName[]) {
      delete process.env[`OPEN_AGENT_FEATURE_${name}`];
    }
  });

  test('returns compile-time default when no override and no env', () => {
    expect(feature('REACTIVE_COMPACT')).toBe(true);
    // TRANSCRIPT_CLASSIFIER is enabled by default — classifier + hooks are fully wired
    expect(feature('TRANSCRIPT_CLASSIFIER')).toBe(true);
  });

  test('env var "1" enables a flag', () => {
    process.env.OPEN_AGENT_FEATURE_TRANSCRIPT_CLASSIFIER = '1';
    expect(feature('TRANSCRIPT_CLASSIFIER')).toBe(true);
  });

  test('env var "true" enables a flag', () => {
    process.env.OPEN_AGENT_FEATURE_FILE_HISTORY = 'true';
    expect(feature('FILE_HISTORY')).toBe(true);
  });

  test('env var "0" disables a default-true flag', () => {
    process.env.OPEN_AGENT_FEATURE_REACTIVE_COMPACT = '0';
    expect(feature('REACTIVE_COMPACT')).toBe(false);
  });

  test('TRANSCRIPT_CLASSIFIER defaults to true (classifier + hooks fully wired)', () => {
    expect(FEATURE_FLAG_DEFAULTS.TRANSCRIPT_CLASSIFIER).toBe(true);
    expect(feature('TRANSCRIPT_CLASSIFIER')).toBe(true);
  });

  test('TRANSCRIPT_CLASSIFIER can be disabled via env var for opt-out', () => {
    process.env.OPEN_AGENT_FEATURE_TRANSCRIPT_CLASSIFIER = '0';
    expect(feature('TRANSCRIPT_CLASSIFIER')).toBe(false);
  });

  test('TRANSCRIPT_CLASSIFIER can be disabled via setFeatureDefault', () => {
    setFeatureDefault('TRANSCRIPT_CLASSIFIER', false);
    expect(feature('TRANSCRIPT_CLASSIFIER')).toBe(false);
  });

  test('setFeatureDefault overrides env and compile-time', () => {
    process.env.OPEN_AGENT_FEATURE_REACTIVE_COMPACT = '1';
    setFeatureDefault('REACTIVE_COMPACT', false);
    expect(feature('REACTIVE_COMPACT')).toBe(false);
  });

  test('clearFeatureOverrides resets all runtime overrides', () => {
    setFeatureDefault('REACTIVE_COMPACT', false);
    clearFeatureOverrides();
    expect(feature('REACTIVE_COMPACT')).toBe(FEATURE_FLAG_DEFAULTS.REACTIVE_COMPACT);
  });

  test('invalid env value falls through to default', () => {
    process.env.OPEN_AGENT_FEATURE_REACTIVE_COMPACT = 'maybe';
    expect(feature('REACTIVE_COMPACT')).toBe(FEATURE_FLAG_DEFAULTS.REACTIVE_COMPACT);
  });

  test('DARWIN_SANDBOX defaults to true on darwin, false elsewhere', () => {
    const expected = process.platform === 'darwin';
    expect(FEATURE_FLAG_DEFAULTS.DARWIN_SANDBOX).toBe(expected);
    expect(feature('DARWIN_SANDBOX')).toBe(expected);
  });

  test('DARWIN_SANDBOX can be overridden via setFeatureDefault', () => {
    setFeatureDefault('DARWIN_SANDBOX', true);
    expect(feature('DARWIN_SANDBOX')).toBe(true);
    clearFeatureOverrides();
    setFeatureDefault('DARWIN_SANDBOX', false);
    expect(feature('DARWIN_SANDBOX')).toBe(false);
  });

  test('all flags in FEATURE_FLAG_DEFAULTS are valid FeatureFlagName values', () => {
    const flagNames: FeatureFlagName[] = Object.keys(FEATURE_FLAG_DEFAULTS) as FeatureFlagName[];
    // Verifies DARWIN_SANDBOX is present alongside all previously declared flags
    expect(flagNames).toContain('DARWIN_SANDBOX');
    expect(flagNames).toContain('REACTIVE_COMPACT');
    expect(flagNames).toContain('TRANSCRIPT_CLASSIFIER');
    expect(flagNames).toContain('FORK_SUBAGENT');
    expect(flagNames).toContain('THINKING_ADAPTIVE');
    expect(flagNames).toContain('FILE_HISTORY');
    expect(flagNames).toContain('WORKFLOW_SCRIPTS');
    expect(flagNames).toContain('EXIT_PLAN_MODE_V2');
  });
});
