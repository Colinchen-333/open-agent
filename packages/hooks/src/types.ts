import type { HookEvent } from '@open-agent/core';

// Re-export HookEvent so consumers only need to import from this package
export type { HookEvent };

// ---------------------------------------------------------------------------
// Base input shared by all hook events
// ---------------------------------------------------------------------------

export interface BaseHookInput {
  session_id: string;
  transcript_path: string;
  cwd: string;
  permission_mode?: string;
}

// ---------------------------------------------------------------------------
// Per-event input shapes
// ---------------------------------------------------------------------------

export interface PreToolUseHookInput extends BaseHookInput {
  hook_event_name: 'PreToolUse';
  tool_name: string;
  tool_input: unknown;
  tool_use_id: string;
}

export interface PostToolUseHookInput extends BaseHookInput {
  hook_event_name: 'PostToolUse';
  tool_name: string;
  tool_input: unknown;
  tool_response: unknown;
  tool_use_id: string;
}

export interface PostToolUseFailureHookInput extends BaseHookInput {
  hook_event_name: 'PostToolUseFailure';
  tool_name: string;
  tool_input: unknown;
  tool_use_id: string;
  error: string;
}

export interface UserPromptSubmitHookInput extends BaseHookInput {
  hook_event_name: 'UserPromptSubmit';
  prompt: string;
}

export interface SessionStartHookInput extends BaseHookInput {
  hook_event_name: 'SessionStart';
  source: 'startup' | 'resume' | 'clear' | 'compact';
  agent_type?: string;
  model?: string;
}

export interface SessionEndHookInput extends BaseHookInput {
  hook_event_name: 'SessionEnd';
  reason: string;
}

export interface StopHookInput extends BaseHookInput {
  hook_event_name: 'Stop';
  stop_hook_active: boolean;
  last_assistant_message?: string;
}

export interface NotificationHookInput extends BaseHookInput {
  hook_event_name: 'Notification';
  message: string;
  title?: string;
  notification_type: string;
}

export interface SubagentStartHookInput extends BaseHookInput {
  hook_event_name: 'SubagentStart';
  agent_id: string;
  agent_type: string;
}

export interface SubagentStopHookInput extends BaseHookInput {
  hook_event_name: 'SubagentStop';
  stop_hook_active: boolean;
  agent_id: string;
  agent_transcript_path: string;
  agent_type: string;
  last_assistant_message?: string;
}

export interface PreCompactHookInput extends BaseHookInput {
  hook_event_name: 'PreCompact';
  trigger: 'manual' | 'auto';
  custom_instructions: string | null;
}

export interface PermissionRequestHookInput extends BaseHookInput {
  hook_event_name: 'PermissionRequest';
  tool_name: string;
  tool_input: unknown;
  tool_use_id: string;
  reason?: string;
  stage: 'before_prompt';
  metadata?: {
    readOnly?: boolean;
    destructive?: boolean;
    openWorld?: boolean;
    source?: 'builtin' | 'dynamic' | 'mcp';
    serverName?: string;
    capability?: {
      category?: string;
      risk?: 'low' | 'medium' | 'high';
      needsWorkspaceWrite?: boolean;
    };
  };
}

export interface SetupHookInput extends BaseHookInput {
  hook_event_name: 'Setup';
  trigger: 'init' | 'maintenance';
}

export interface TeammateIdleHookInput extends BaseHookInput {
  hook_event_name: 'TeammateIdle';
  teammate_name: string;
  team_name: string;
}

export interface TaskCompletedHookInput extends BaseHookInput {
  hook_event_name: 'TaskCompleted';
  task_id: string;
  task_subject: string;
  task_description?: string;
  teammate_name?: string;
  team_name?: string;
}

export interface ConfigChangeHookInput extends BaseHookInput {
  hook_event_name: 'ConfigChange';
  source: string;
  file_path?: string;
}

export interface WorktreeCreateHookInput extends BaseHookInput {
  hook_event_name: 'WorktreeCreate';
  name: string;
}

export interface WorktreeRemoveHookInput extends BaseHookInput {
  hook_event_name: 'WorktreeRemove';
  worktree_path: string;
}

// ---------------------------------------------------------------------------
// Discriminated union of all hook inputs
// ---------------------------------------------------------------------------

export type HookInput =
  | PreToolUseHookInput
  | PostToolUseHookInput
  | PostToolUseFailureHookInput
  | UserPromptSubmitHookInput
  | SessionStartHookInput
  | SessionEndHookInput
  | StopHookInput
  | NotificationHookInput
  | SubagentStartHookInput
  | SubagentStopHookInput
  | PreCompactHookInput
  | PermissionRequestHookInput
  | SetupHookInput
  | TeammateIdleHookInput
  | TaskCompletedHookInput
  | ConfigChangeHookInput
  | WorktreeCreateHookInput
  | WorktreeRemoveHookInput;

// ---------------------------------------------------------------------------
// Hook output — all fields are optional; absent means "no opinion"
// ---------------------------------------------------------------------------

export interface HookOutput {
  /** When false, the agent should halt the current operation. Defaults to true. */
  continue?: boolean;
  /** When true, the hook result should not be surfaced to the user. */
  suppressOutput?: boolean;
  /** Human-readable reason for stopping (used when continue === false). */
  stopReason?: string;
  /** Used by PermissionRequest hooks. */
  decision?: 'approve' | 'block';
  /** Extra context injected as a system message into the conversation. */
  systemMessage?: string;
  /** Human-readable explanation accompanying a decision. */
  reason?: string;
  /** Additional context appended to the tool result or system message. */
  additionalContext?: string;
  /** Overrides for fields of the original hook input. */
  updatedInput?: Record<string, unknown>;
  /** Fine-grained permission decision. */
  permissionDecision?: 'allow' | 'deny' | 'ask';
  /** Event-specific output overrides (e.g., MCP tool result rewriting). */
  hookSpecificOutput?: Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Hook registration types
// ---------------------------------------------------------------------------

/**
 * Describes a shell-command hook registered via config or the API.
 * The command is executed as `bash -c <command>`. The serialised HookInput is
 * piped to stdin and also available as the HOOK_INPUT environment variable.
 * The command should write a JSON HookOutput to stdout (or nothing, which is
 * interpreted as `{ continue: true }`).
 */
export interface HookDefinition {
  /** Shell command to execute. */
  command: string;
  /** Timeout in seconds (default: 30). */
  timeout?: number;
  /**
   * When set, the hook runs asynchronously in fire-and-forget mode; the caller
   * returns `{ continue: true }` immediately without waiting for the process to
   * finish. The hook still has up to `asyncTimeout` seconds to complete in the
   * background, after which it receives SIGTERM.
   */
  asyncTimeout?: number;
  /**
   * Optional glob / regex pattern matched against tool_name for tool-related
   * events (PreToolUse, PostToolUse, PostToolUseFailure, PermissionRequest).
   * When absent the hook runs for every invocation of the event.
   */
  matcher?: string;
}

/**
 * Injects static or templated text into the system prompt when this event
 * fires. The template may reference the following placeholders:
 *   {{toolName}}  — the name of the tool (tool-related events only)
 *   {{event}}     — the hook_event_name string
 *   {{sessionId}} — the session identifier
 *
 * The rendered text is returned as `additionalContext` in HookOutput so the
 * conversation loop can append it to the system prompt.
 */
export interface PromptHookDefinition {
  type: 'prompt';
  /** Text to inject. Supports {{toolName}}, {{event}}, {{sessionId}} placeholders. */
  template: string;
  /**
   * Optional matcher pattern. Same semantics as HookDefinition.matcher.
   */
  matcher?: string;
  /** Timeout in seconds. Prompt hooks resolve synchronously, so this is unused
   *  but kept for API symmetry. */
  timeout?: number;
}

/**
 * Sends an HTTP POST request to the given URL when this event fires.
 * The serialised HookInput is the request body (Content-Type: application/json).
 * The response body, if valid JSON, is treated as a HookOutput; otherwise the
 * raw text is attached as `additionalContext`.
 */
export interface HttpHookDefinition {
  type: 'http';
  /** Endpoint to POST the event payload to. */
  url: string;
  /** Additional request headers (e.g. Authorization). */
  headers?: Record<string, string>;
  /**
   * Optional matcher pattern. Same semantics as HookDefinition.matcher.
   */
  matcher?: string;
  /** Timeout in seconds for the HTTP request (default: 30). */
  timeout?: number;
}

/**
 * Spawns a named subagent when this event fires. The caller is responsible
 * for dispatching the returned `agentName` / `prompt` pair; the executor
 * surfaces them via `hookSpecificOutput` in the HookOutput.
 */
export interface AgentHookDefinition {
  type: 'agent';
  /** Name of the agent to spawn (must be registered with the AgentLoader). */
  agentName: string;
  /**
   * Optional prompt to pass to the spawned agent. Supports the same
   * {{toolName}}, {{event}}, {{sessionId}} placeholders as PromptHookDefinition.
   */
  prompt?: string;
  /**
   * Optional matcher pattern. Same semantics as HookDefinition.matcher.
   */
  matcher?: string;
  /** Timeout in seconds (unused at dispatch time; kept for API symmetry). */
  timeout?: number;
}

/**
 * Union of all hook definition types that can be registered for an event.
 * The legacy `HookDefinition` (shell command) is included as the implicit
 * default (no `type` field needed; presence of `command` identifies it).
 */
export type AnyHookDefinition =
  | HookDefinition
  | PromptHookDefinition
  | HttpHookDefinition
  | AgentHookDefinition;

/**
 * Programmatic hook callback signature.
 * Returning a partial HookOutput (or an empty object) is always valid.
 */
export interface HookCallbackFn {
  (
    input: HookInput,
    toolUseId?: string,
    options?: { signal: AbortSignal },
  ): Promise<HookOutput>;
}

/**
 * Groups one or more callback functions under an optional matcher pattern.
 */
export interface HookCallbackMatcher {
  /** Same semantics as HookDefinition.matcher. */
  matcher?: string;
  hooks: HookCallbackFn[];
  /** Timeout in seconds (default: 30). */
  timeout?: number;
}
