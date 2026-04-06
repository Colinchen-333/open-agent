import { describe, expect, test } from 'bun:test';
import type { ToolDefinition, ValidationResult } from '../types';

describe('validateInput', () => {
  test('returns null for valid input', () => {
    const validate = (input: any): ValidationResult | null => {
      if (!input.file_path) return { valid: false, errorCode: 'MISSING_PATH', errorMessage: 'file_path required' };
      return null;
    };
    expect(validate({ file_path: '/test' })).toBeNull();
  });

  test('returns ValidationResult for invalid input', () => {
    const validate = (input: any): ValidationResult | null => {
      if (!input.command) return { valid: false, errorCode: 'EMPTY_COMMAND', errorMessage: 'command required' };
      return null;
    };
    const result = validate({});
    expect(result).not.toBeNull();
    expect(result!.valid).toBe(false);
    expect(result!.errorCode).toBe('EMPTY_COMMAND');
  });

  test('ValidationResult shape is correct', () => {
    const result: ValidationResult = { valid: false, errorCode: 'TEST', errorMessage: 'test error' };
    expect(result.valid).toBe(false);
    expect(typeof result.errorCode).toBe('string');
    expect(typeof result.errorMessage).toBe('string');
  });
});

describe('mapToolResultToToolResultBlockParam', () => {
  test('maps string output', () => {
    const mapper = (output: unknown, toolUseId: string) => ({
      type: 'tool_result' as const,
      tool_use_id: toolUseId,
      content: `Result: ${output}`,
    });
    const result = mapper('hello', 'tu-123');
    expect(result.type).toBe('tool_result');
    expect(result.tool_use_id).toBe('tu-123');
    expect(result.content).toBe('Result: hello');
  });

  test('maps structured output with array content', () => {
    const mapper = (output: unknown, toolUseId: string) => ({
      type: 'tool_result' as const,
      tool_use_id: toolUseId,
      content: [{ type: 'text' as const, text: JSON.stringify(output) }],
    });
    const result = mapper({ status: 200 }, 'tu-456');
    expect(Array.isArray(result.content)).toBe(true);
  });

  test('maps error output', () => {
    const mapper = (output: unknown, toolUseId: string) => ({
      type: 'tool_result' as const,
      tool_use_id: toolUseId,
      content: `Error: ${output}`,
      is_error: true,
    });
    const result = mapper('not found', 'tu-789');
    expect(result.is_error).toBe(true);
  });
});
