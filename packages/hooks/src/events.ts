/**
 * Complete hook event type system matching Claude Code's 27 event types.
 */

export const HOOK_EVENTS = [
  'PreToolUse',
  'PostToolUse',
  'PostToolUseFailure',
  'Notification',
  'UserPromptSubmit',
  'SessionStart',
  'SessionEnd',
  'Stop',
  'StopFailure',
  'SubagentStart',
  'SubagentStop',
  'PreCompact',
  'PostCompact',
  'PermissionRequest',
  'PermissionDenied',
  'Setup',
  'TeammateIdle',
  'TaskCreated',
  'TaskCompleted',
  'Elicitation',
  'ElicitationResult',
  'ConfigChange',
  'WorktreeCreate',
  'WorktreeRemove',
  'InstructionsLoaded',
  'CwdChanged',
  'FileChanged',
] as const;

export type HookEvent = typeof HOOK_EVENTS[number];

/** Base hook input — all events include these fields */
export interface BaseHookInput {
  event: HookEvent;
  sessionId: string;
  cwd: string;
  timestamp: string;
}

/** Pre-tool-use: before a tool executes */
export interface PreToolUseHookInput extends BaseHookInput {
  event: 'PreToolUse';
  toolName: string;
  toolInput: unknown;
  toolUseId: string;
}

/** Post-tool-use: after successful tool execution */
export interface PostToolUseHookInput extends BaseHookInput {
  event: 'PostToolUse';
  toolName: string;
  toolInput: unknown;
  toolUseId: string;
  toolResult: unknown;
  durationMs: number;
}

/** Post-tool-use failure */
export interface PostToolUseFailureHookInput extends BaseHookInput {
  event: 'PostToolUseFailure';
  toolName: string;
  toolInput: unknown;
  toolUseId: string;
  error: string;
}

/** User prompt submitted */
export interface UserPromptSubmitHookInput extends BaseHookInput {
  event: 'UserPromptSubmit';
  prompt: string;
}

/** Session lifecycle */
export interface SessionStartHookInput extends BaseHookInput {
  event: 'SessionStart';
  model: string;
  permissionMode: string;
}

export interface SessionEndHookInput extends BaseHookInput {
  event: 'SessionEnd';
  reason: string;
  turnCount: number;
}

/** Subagent lifecycle */
export interface SubagentStartHookInput extends BaseHookInput {
  event: 'SubagentStart';
  agentId: string;
  agentType: string;
  parentSessionId: string;
}

export interface SubagentStopHookInput extends BaseHookInput {
  event: 'SubagentStop';
  agentId: string;
  result?: string;
  error?: string;
}

/** Compaction */
export interface PreCompactHookInput extends BaseHookInput {
  event: 'PreCompact';
  messageCount: number;
  estimatedTokens: number;
}

export interface PostCompactHookInput extends BaseHookInput {
  event: 'PostCompact';
  removedMessages: number;
  tokensSaved: number;
}

/** Permission events */
export interface PermissionRequestHookInput extends BaseHookInput {
  event: 'PermissionRequest';
  toolName: string;
  toolInput: unknown;
}

export interface PermissionDeniedHookInput extends BaseHookInput {
  event: 'PermissionDenied';
  toolName: string;
  reason: string;
}

/** Task events */
export interface TaskCreatedHookInput extends BaseHookInput {
  event: 'TaskCreated';
  taskId: string;
  subject: string;
}

export interface TaskCompletedHookInput extends BaseHookInput {
  event: 'TaskCompleted';
  taskId: string;
  result?: string;
}

/** Teammate idle */
export interface TeammateIdleHookInput extends BaseHookInput {
  event: 'TeammateIdle';
  teammateName: string;
  agentId: string;
}

/** Config/file/cwd changes */
export interface ConfigChangeHookInput extends BaseHookInput {
  event: 'ConfigChange';
  key: string;
  oldValue?: unknown;
  newValue?: unknown;
}

export interface CwdChangedHookInput extends BaseHookInput {
  event: 'CwdChanged';
  oldCwd: string;
  newCwd: string;
}

export interface FileChangedHookInput extends BaseHookInput {
  event: 'FileChanged';
  filePath: string;
  changeType: 'created' | 'modified' | 'deleted';
}

/** Other events */
export interface NotificationHookInput extends BaseHookInput {
  event: 'Notification';
  message: string;
  level: 'info' | 'warning' | 'error';
}

export interface StopHookInput extends BaseHookInput {
  event: 'Stop';
  reason: string;
}

export interface StopFailureHookInput extends BaseHookInput {
  event: 'StopFailure';
  error: string;
}

export interface SetupHookInput extends BaseHookInput {
  event: 'Setup';
}

export interface ElicitationHookInput extends BaseHookInput {
  event: 'Elicitation';
  requestId: string;
  serverName: string;
  message: string;
}

export interface ElicitationResultHookInput extends BaseHookInput {
  event: 'ElicitationResult';
  requestId: string;
  action: 'approve' | 'deny';
}

export interface WorktreeCreateHookInput extends BaseHookInput {
  event: 'WorktreeCreate';
  branch: string;
  path: string;
}

export interface WorktreeRemoveHookInput extends BaseHookInput {
  event: 'WorktreeRemove';
  branch: string;
  path: string;
}

export interface InstructionsLoadedHookInput extends BaseHookInput {
  event: 'InstructionsLoaded';
  sources: string[];
}

/** Hook output — what a hook can return */
export interface HookOutput {
  /** If true, block the action (for pre-hooks) */
  blocked?: boolean;
  /** Reason for blocking */
  reason?: string;
  /** Modified input (for pre-hooks that transform) */
  modifiedInput?: unknown;
  /** Additional messages to display */
  messages?: string[];
}

/** Union type for all hook inputs */
export type HookInput =
  | PreToolUseHookInput
  | PostToolUseHookInput
  | PostToolUseFailureHookInput
  | UserPromptSubmitHookInput
  | SessionStartHookInput
  | SessionEndHookInput
  | SubagentStartHookInput
  | SubagentStopHookInput
  | PreCompactHookInput
  | PostCompactHookInput
  | PermissionRequestHookInput
  | PermissionDeniedHookInput
  | TaskCreatedHookInput
  | TaskCompletedHookInput
  | TeammateIdleHookInput
  | ConfigChangeHookInput
  | CwdChangedHookInput
  | FileChangedHookInput
  | NotificationHookInput
  | StopHookInput
  | StopFailureHookInput
  | SetupHookInput
  | ElicitationHookInput
  | ElicitationResultHookInput
  | WorktreeCreateHookInput
  | WorktreeRemoveHookInput
  | InstructionsLoadedHookInput;
