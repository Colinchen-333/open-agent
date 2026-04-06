import type { ToolDefinition } from './types.js';

export interface ToolDescriptionContext {
  isNonInteractive?: boolean;
  permissionMode?: string;
  cwd?: string;
  tools?: string[];
}

/**
 * Get the description for a tool, preferring dynamic over static.
 */
export function getToolDescription(tool: ToolDefinition, context?: ToolDescriptionContext): string {
  if (tool.dynamicDescription) {
    return tool.dynamicDescription(context);
  }
  return tool.description;
}

/**
 * Get the system prompt section for a tool (may be empty).
 */
export function getToolPrompt(tool: ToolDefinition, context?: ToolDescriptionContext): string | null {
  if (tool.prompt) {
    return tool.prompt(context);
  }
  return null;
}

/**
 * Collect all tool prompts for active tools.
 */
export function collectToolPrompts(
  tools: ToolDefinition[],
  context?: ToolDescriptionContext,
): string[] {
  const prompts: string[] = [];
  for (const tool of tools) {
    const p = getToolPrompt(tool, context);
    if (p) prompts.push(p);
  }
  return prompts;
}
