import type { ToolDefinition } from './types.js';

/**
 * Applies Claude-Code-aligned defaults to a tool definition.
 * Tool-specific fields (passed in via `tool`) take precedence over defaults.
 */
export function withToolDefaults<T extends ToolDefinition>(tool: T): T {
  return {
    maxResultSizeChars: 100_000,
    interruptBehavior: 'cancel' as const,
    extractSearchText: (output: unknown): string => {
      if (typeof output === 'string') return output;
      try {
        return JSON.stringify(output).slice(0, 1000);
      } catch {
        return '';
      }
    },
    isResultTruncated: (): boolean => false,
    renderToolUseMessage: (): string => tool.name,
    renderToolResultMessage: (output: unknown): string =>
      typeof output === 'string' ? output : JSON.stringify(output),
    renderToolUseErrorMessage: (error: unknown): string => String(error),
    // Tool-specific fields override the defaults above
    ...tool,
  };
}
