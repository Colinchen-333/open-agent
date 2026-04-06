import type { ToolDefinition } from './types.js';

/**
 * Extract the file path from a tool's input using its getPath method.
 * Returns null if the tool doesn't define getPath or the input has no path.
 */
export function extractToolPath(tool: ToolDefinition, input: unknown): string | null {
  return tool.getPath?.(input) ?? null;
}

/**
 * Get the display name for a tool invocation.
 * Prefers userFacingName(input) over the static name.
 */
export function getToolDisplayName(tool: ToolDefinition, input?: unknown): string {
  if (tool.userFacingName && input !== undefined) {
    return tool.userFacingName(input);
  }
  return tool.name;
}

/**
 * Check if two invocations of the same tool are equivalent (for dedup).
 */
export function areToolInputsEquivalent(tool: ToolDefinition, a: unknown, b: unknown): boolean {
  if (tool.inputsEquivalent) {
    return tool.inputsEquivalent(a, b);
  }
  // Fallback: deep equality of JSON representation
  return JSON.stringify(a) === JSON.stringify(b);
}
