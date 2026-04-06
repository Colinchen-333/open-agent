/**
 * Complete SDK message type system matching Claude Code's ~25 message types.
 */

/** Tool progress during execution */
export interface SDKToolProgressMessage {
  type: 'tool_progress';
  toolUseId: string;
  toolName: string;
  progress: string;
  timestamp: string;
}

/** Tool use summary after completion */
export interface SDKToolUseSummaryMessage {
  type: 'tool_use_summary';
  toolUseId: string;
  toolName: string;
  summary: string;
  durationMs: number;
  isError?: boolean;
}

/** Streamlined text (for brief mode) */
export interface SDKStreamlinedTextMessage {
  type: 'streamlined_text';
  text: string;
}

/** Task progress */
export interface SDKTaskProgressMessage {
  type: 'task_progress';
  taskId: string;
  progress: string;
  percentComplete?: number;
}

/** Task started */
export interface SDKTaskStartedMessage {
  type: 'task_started';
  taskId: string;
  subject: string;
}

/** Hook lifecycle */
export interface SDKHookStartedMessage {
  type: 'hook_started';
  hookEvent: string;
  hookName: string;
}

export interface SDKHookProgressMessage {
  type: 'hook_progress';
  hookEvent: string;
  hookName: string;
  progress: string;
}

export interface SDKHookResponseMessage {
  type: 'hook_response';
  hookEvent: string;
  hookName: string;
  blocked: boolean;
  reason?: string;
}

/** Rate limit */
export interface SDKRateLimitEvent {
  type: 'rate_limit';
  retryAfterMs: number;
  provider: string;
  model: string;
}

/** Compact boundary */
export interface SDKCompactBoundaryMessage {
  type: 'compact_boundary';
  removedMessages: number;
  tokensSaved: number;
}

/** Session state changed */
export interface SDKSessionStateChangedMessage {
  type: 'session_state_changed';
  state: string;
  previousState?: string;
}

/** Post-turn summary */
export interface SDKPostTurnSummaryMessage {
  type: 'post_turn_summary';
  turnIndex: number;
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
  durationMs: number;
}

/** Auth status */
export interface SDKAuthStatusMessage {
  type: 'auth_status';
  authenticated: boolean;
  provider: string;
  error?: string;
}

/** Prompt suggestion */
export interface SDKPromptSuggestionMessage {
  type: 'prompt_suggestion';
  suggestions: string[];
}

/** Files persisted */
export interface SDKFilesPersistedEvent {
  type: 'files_persisted';
  files: string[];
  sessionId: string;
}

/** API retry */
export interface SDKAPIRetryMessage {
  type: 'api_retry';
  attempt: number;
  maxAttempts: number;
  delayMs: number;
  error: string;
}

/** Local command output */
export interface SDKLocalCommandOutputMessage {
  type: 'local_command_output';
  command: string;
  output: string;
}

/** Elicitation complete */
export interface SDKElicitationCompleteMessage {
  type: 'elicitation_complete';
  requestId: string;
  success: boolean;
  error?: string;
}

/** User message replay (for stream-json) */
export interface SDKUserMessageReplayMessage {
  type: 'user_message_replay';
  content: string;
}
