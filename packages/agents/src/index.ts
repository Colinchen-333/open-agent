// @open-agent/agents - Agent system
// Provides AgentRunner, subagent spawning, and task coordination

export * from './types';
export { AgentLoader } from './agent-loader';
export type { AgentLoaderDiagnostic } from './agent-loader';
export { AgentRunner, type AgentRunnerOptions, type AgentResult, type AgentUsage, type SubagentStreamEvent } from './agent-runner';
export { TeamManager } from './team-manager';
export { TaskManager } from './task-manager';
export { AgentExecutor } from './agent-executor';
export type { AgentSession, AgentState, ExecuteOptions, ExecuteForkedOptions, AgentHookExecutor } from './agent-executor';
export {
  getMailbox,
  sendMessage,
  readMessages,
  getAllMessages,
  resetMailboxes,
  resolveAgentMode,
  type AgentMode,
  type TeammateSpec,
  type CoordinatorState,
  type TeammateStatus,
  type AgentMailbox,
  type MailboxMessage,
} from './agent-taxonomy.js';
