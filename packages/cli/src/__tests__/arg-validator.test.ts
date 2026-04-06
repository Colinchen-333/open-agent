import { describe, expect, test } from 'bun:test';
import { validateArgs, KNOWN_CLI_FLAGS } from '../arg-validator';

describe('validateArgs', () => {
  test('passes with known flags', () => {
    const result = validateArgs(['--model', 'gpt-4', '--verbose'], KNOWN_CLI_FLAGS);
    expect(result.valid).toBe(true);
    expect(result.unknownFlags).toHaveLength(0);
  });

  test('detects unknown flags', () => {
    const result = validateArgs(['--model', 'gpt-4', '--unknown-flag'], KNOWN_CLI_FLAGS);
    expect(result.valid).toBe(false);
    expect(result.unknownFlags).toContain('--unknown-flag');
  });

  test('ignores positional arguments', () => {
    const result = validateArgs(['hello', 'world', '--verbose'], KNOWN_CLI_FLAGS);
    expect(result.valid).toBe(true);
  });

  test('handles --flag=value syntax', () => {
    const result = validateArgs(['--model=gpt-4'], KNOWN_CLI_FLAGS);
    expect(result.valid).toBe(true);
  });

  test('handles short flags', () => {
    const result = validateArgs(['-p', 'prompt', '-v'], KNOWN_CLI_FLAGS);
    expect(result.valid).toBe(true);
  });

  test('reports multiple unknown flags', () => {
    const result = validateArgs(['--foo', '--bar', '--baz'], KNOWN_CLI_FLAGS);
    expect(result.unknownFlags).toHaveLength(3);
    expect(result.warnings).toHaveLength(3);
  });
});
