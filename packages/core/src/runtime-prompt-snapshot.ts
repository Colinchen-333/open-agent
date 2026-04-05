import { buildCoordinatorContext } from './coordinator-context.js';
import type { CoordinatorContext, CoordinatorTaskNotificationLike } from './coordinator-context.js';
import type {
  RuntimePromptAgent,
  RuntimePromptCapabilitySnapshot,
  RuntimePromptDiagnostic,
  RuntimePromptDiagnosticSummary,
  RuntimePromptHook,
  RuntimePromptPlugin,
  RuntimePromptSkill,
  SystemPromptRuntimeSnapshot,
} from './runtime-prompt-sections.js';

export interface RuntimePromptSnapshotSource {
  agents: RuntimePromptAgent[];
  skills: RuntimePromptSkill[];
  mcpServers: { name: string; status: string }[];
  plugins: RuntimePromptPlugin[];
  hooks: RuntimePromptHook[];
  diagnostics: RuntimePromptDiagnostic[];
  diagnosticSummary?: RuntimePromptDiagnosticSummary;
  capabilitySnapshot?: RuntimePromptCapabilitySnapshot;
}

export interface BuildRuntimePromptSnapshotOptions {
  runtime: RuntimePromptSnapshotSource;
  tools: string[];
  activeTeam?: string;
  scratchpadDir?: string;
  taskNotifications?: CoordinatorTaskNotificationLike[];
  hookSurface?: RuntimePromptHook[];
  capabilitySnapshot?: RuntimePromptCapabilitySnapshot;
  coordinator?: CoordinatorContext;
}

export function buildSystemPromptRuntimeSnapshot(
  options: BuildRuntimePromptSnapshotOptions,
): SystemPromptRuntimeSnapshot {
  const connectedMcpServers = options.runtime.mcpServers.filter((server) => server.status === 'connected');
  const coordinator = options.coordinator ?? buildCoordinatorContext({
    workerTools: options.tools.filter((name) => name !== 'Task'),
    activeTeam: options.activeTeam,
    scratchpadDir: options.scratchpadDir,
    canUseSkills: options.tools.includes('Skill') && options.runtime.skills.length > 0,
    canUseMcpTools: connectedMcpServers.length > 0,
    taskNotifications: options.taskNotifications,
  });

  return {
    agents: options.runtime.agents,
    skills: options.runtime.skills,
    mcpServers: options.runtime.mcpServers,
    plugins: options.runtime.plugins,
    hooks: options.hookSurface ?? options.runtime.hooks,
    diagnostics: options.runtime.diagnostics,
    diagnosticSummary: options.runtime.diagnosticSummary,
    capabilitySnapshot: options.capabilitySnapshot ?? options.runtime.capabilitySnapshot,
    coordinator,
  };
}
