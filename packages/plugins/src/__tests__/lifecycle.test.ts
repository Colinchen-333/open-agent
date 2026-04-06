import { describe, expect, test } from 'bun:test';
import { validateManifest, type PluginManifest, type PluginValidationResult } from '../lifecycle';

describe('validateManifest', () => {
  test('valid manifest passes', () => {
    const result = validateManifest({ name: 'test-plugin', version: '1.0.0' });
    expect(result.valid).toBe(true);
    expect(result.errors).toHaveLength(0);
  });

  test('missing name fails', () => {
    const result = validateManifest({ version: '1.0.0' });
    expect(result.valid).toBe(false);
    expect(result.errors.some(e => e.includes('name'))).toBe(true);
  });

  test('missing version fails', () => {
    const result = validateManifest({ name: 'test' });
    expect(result.valid).toBe(false);
    expect(result.errors.some(e => e.includes('version'))).toBe(true);
  });

  test('invalid name format fails', () => {
    const result = validateManifest({ name: 'Invalid Name!', version: '1.0.0' });
    expect(result.valid).toBe(false);
    expect(result.errors.some(e => e.includes('lowercase'))).toBe(true);
  });

  test('non-object fails', () => {
    expect(validateManifest(null).valid).toBe(false);
    expect(validateManifest('string').valid).toBe(false);
    expect(validateManifest(42).valid).toBe(false);
  });

  test('extra fields produce warnings not errors', () => {
    const result = validateManifest({ name: 'test', version: '1.0.0', description: 123 });
    expect(result.valid).toBe(true); // description wrong type is a warning
    expect(result.warnings.length).toBeGreaterThan(0);
  });

  test('full manifest validates', () => {
    const manifest: PluginManifest = {
      name: 'my-plugin',
      version: '2.0.0',
      description: 'A test plugin',
      author: 'Test Author',
      main: 'index.js',
      capabilities: { tools: true, hooks: true },
    };
    expect(validateManifest(manifest).valid).toBe(true);
  });
});
