import type { ToolDefinition } from './types.js';
import { createReadTool } from './read.js';
import { createWriteTool } from './write.js';
import { createEditTool } from './edit.js';
import { createBashTool } from './bash.js';
import { createGlobTool } from './glob.js';
import { createGrepTool } from './grep.js';

/**
 * Central registry for all available tools.
 * Tools are stored by name and can be retrieved individually or listed
 * in the format expected by the Anthropic / OpenAI function-calling API.
 */
export class ToolRegistry {
  private tools = new Map<string, ToolDefinition>();

  /** Register a tool. Overwrites any existing tool with the same name. */
  register(tool: ToolDefinition): void {
    this.tools.set(tool.name, tool);
  }

  /** Retrieve a tool by name, or undefined if not registered. */
  get(name: string): ToolDefinition | undefined {
    return this.tools.get(name);
  }

  /** Return all registered tools. */
  list(): ToolDefinition[] {
    return Array.from(this.tools.values());
  }

  /**
   * Return tool definitions in the format expected by LLM APIs
   * (Anthropic tool_use / OpenAI function-calling style).
   */
  getForLLM(): { name: string; description: string; input_schema: Record<string, any> }[] {
    return this.list().map(tool => ({
      name: tool.name,
      description: tool.description,
      input_schema: tool.inputSchema,
    }));
  }
}

/**
 * Create a ToolRegistry pre-populated with all built-in tools.
 * @param cwd - Working directory used as default context for tools.
 */
export function createDefaultToolRegistry(_cwd: string): ToolRegistry {
  const registry = new ToolRegistry();
  registry.register(createReadTool());
  registry.register(createWriteTool());
  registry.register(createEditTool());
  registry.register(createBashTool());
  registry.register(createGlobTool());
  registry.register(createGrepTool());
  return registry;
}
