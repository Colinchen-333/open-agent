// @open-agent/tools - Built-in tool implementations
// Provides file system, shell, and search tools

export type {
  FileReadInput,
  FileWriteInput,
  FileEditInput,
  BashInput,
  GlobInput,
  GrepInput,
  BashOutput,
  GlobOutput,
  GrepOutput,
  ToolDefinition,
  ToolContext,
} from './types.js';

export { ToolRegistry, createDefaultToolRegistry } from './registry.js';
export { createReadTool } from './read.js';
export { createWriteTool } from './write.js';
export { createEditTool } from './edit.js';
export { createBashTool } from './bash.js';
export { createGlobTool } from './glob.js';
export { createGrepTool } from './grep.js';
export { createWebFetchTool } from './web-fetch.js';
export { createNotebookEditTool } from './notebook-edit.js';
export { createAskUserTool } from './ask-user.js';
export { createTaskTool, type TaskToolDeps } from './task-tool.js';
export {
  createTeamCreateTool,
  createTeamDeleteTool,
  createSendMessageTool,
  type TeamToolsDeps,
} from './team-tools.js';
export {
  createTaskCreateTool,
  createTaskUpdateTool,
  createTaskGetTool,
  createTaskListTool,
  type TaskToolsDeps,
} from './task-tools.js';
export {
  createListMcpResourcesTool,
  createReadMcpResourceTool,
  type McpToolsDeps,
} from './mcp-tools.js';
export { createWebSearchTool } from './web-search.js';
export {
  createEnterPlanModeTool,
  createExitPlanModeTool,
  type PlanModeDeps,
} from './plan-mode.js';
export { createEnterWorktreeTool } from './worktree.js';
export { createConfigTool } from './config-tool.js';
export {
  createTaskOutputTool,
  createTaskStopTool,
  getBackgroundTasks,
} from './task-management.js';
export { createToolSearchTool, type ToolSearchDeps } from './tool-search.js';
export { createSkillTool, type SkillDeps } from './skill-tool.js';
export { getToolPromptDescriptions } from './tool-descriptions.js';
