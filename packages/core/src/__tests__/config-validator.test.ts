import { describe, expect, test } from 'bun:test';
import { validateConfig, mergeConfigWithValidation } from '../config-validator';

describe('validateConfig', () => {
  test('valid config passes', () => {
    const result = validateConfig({ model: 'gpt-4', verbose: true });
    expect(result.valid).toBe(true);
    expect(result.errors).toHaveLength(0);
  });

  test('wrong type reports error', () => {
    const result = validateConfig({ model: 123 });
    expect(result.valid).toBe(false);
    expect(result.errors[0].path).toBe('model');
    expect(result.errors[0].message).toContain('string');
  });

  test('invalid enum reports error', () => {
    const result = validateConfig({ provider: 'invalid' });
    expect(result.valid).toBe(false);
    expect(result.errors[0].path).toBe('provider');
  });

  test('strips invalid fields from cleaned output', () => {
    const result = validateConfig({ model: 123, verbose: true });
    expect(result.cleaned.model).toBeUndefined();
    expect(result.cleaned.verbose).toBe(true);
  });

  test('unknown fields are preserved', () => {
    const result = validateConfig({ customField: 'value' });
    expect(result.valid).toBe(true);
    expect(result.cleaned.customField).toBe('value');
  });
});

describe('mergeConfigWithValidation', () => {
  test('valid override merges', () => {
    const { merged, errors } = mergeConfigWithValidation(
      { model: 'old' },
      { model: 'new' },
    );
    expect(merged.model).toBe('new');
    expect(errors).toHaveLength(0);
  });

  test('invalid override is skipped', () => {
    const { merged, errors } = mergeConfigWithValidation(
      { model: 'old' },
      { model: 123 as any },
    );
    expect(merged.model).toBe('old'); // preserved
    expect(errors).toHaveLength(1);
  });
});
