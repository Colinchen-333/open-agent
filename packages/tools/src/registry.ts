import type { ToolDefinition } from './types.js';
import { createReadTool } from './read.js';
import { createWriteTool } from './write.js';
import { createEditTool } from './edit.js';
import { createBashTool } from './bash.js';
import { createGlobTool } from './glob.js';
import { createGrepTool } from './grep.js';
import { createWebFetchTool } from './web-fetch.js';
import { createNotebookEditTool } from './notebook-edit.js';
import { createAskUserTool } from './ask-user.js';
import { createWebSearchTool } from './web-search.js';
import { createConfigTool } from './config-tool.js';
import { createTaskOutputTool, createTaskStopTool } from './task-management.js';
import { createEnterWorktreeTool } from './worktree.js';

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

  /** Remove a tool by name. */
  unregister(name: string): boolean {
    return this.tools.delete(name);
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
  registry.register(createWebFetchTool());
  registry.register(createNotebookEditTool());
  registry.register(createAskUserTool());
  registry.register(createWebSearchTool());
  registry.register(createConfigTool());
  registry.register(createTaskOutputTool());
  registry.register(createTaskStopTool());
  registry.register(createEnterWorktreeTool());
  return registry;
}

// The following tools are NOT included in createDefaultToolRegistry() because they
// require runtime dependencies injected by ConversationLoop or AgentRunner:
//
//   ToolSearch  (tool-search.ts)   — needs searchTools/selectTool callbacks from the MCP/deferred tool system
//   Skill       (skill-tool.ts)    — needs a skill-lookup callback provided by the CLI layer
//
//   EnterPlanMode / ExitPlanMode   (plan-mode.ts)   — need a PlanModeManager instance
//
//   TeamCreate / TeamDelete / SendMessage  (team-tools.ts)  — need a TeamManager instance
//
//   TaskCreate / TaskUpdate / TaskGet / TaskList  (task-tools.ts) — need a TaskManager instance
//
// These are registered at runtime by ConversationLoop (or the relevant subsystem) after
// the required dependency objects have been constructed.
