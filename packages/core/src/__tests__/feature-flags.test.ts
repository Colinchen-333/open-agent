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
    expect(feature('TRANSCRIPT_CLASSIFIER')).toBe(false);
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
});
