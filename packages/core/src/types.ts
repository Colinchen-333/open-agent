// Permission types
export type PermissionMode = 'default' | 'acceptEdits' | 'bypassPermissions' | 'plan' | 'dontAsk';
export type PermissionBehavior = 'allow' | 'deny' | 'ask';

// Hook events
export const HOOK_EVENTS = [
  'PreToolUse',
  'PostToolUse',
  'PostToolUseFailure',
  'Notification',
  'UserPromptSubmit',
  'SessionStart',
  'SessionEnd',
  'Stop',
  'SubagentStart',
  'SubagentStop',
  'PreCompact',
  'PermissionRequest',
  'Setup',
  'TeammateIdle',
  'TaskCompleted',
  'ConfigChange',
  'WorktreeCreate',
  'WorktreeRemove',
] as const;
export type HookEvent = (typeof HOOK_EVENTS)[number];

// Exit reasons
export const EXIT_REASONS = [
  'clear',
  'logout',
  'prompt_input_exit',
  'other',
  'bypass_permissions_disabled',
] as const;
export type ExitReason = (typeof EXIT_REASONS)[number];

// Model information
export interface ModelInfo {
  value: string;
  displayName: string;
  description: string;
  supportsEffort?: boolean;
  supportedEffortLevels?: ('low' | 'medium' | 'high' | 'max')[];
  supportsAdaptiveThinking?: boolean;
}

// Model usage statistics
export interface ModelUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadInputTokens: number;
  cacheCreationInputTokens: number;
  webSearchRequests: number;
  costUSD: number;
  contextWindow: number;
  maxOutputTokens: number;
}

// Thinking configuration
export type ThinkingConfig =
  | { type: 'adaptive' }
  | { type: 'enabled'; budgetTokens?: number }
  | { type: 'disabled' };

// Account information
export interface AccountInfo {
  email?: string;
  organization?: string;
  subscriptionType?: string;
  tokenSource?: string;
  apiKeySource?: string;
}

// Agent MCP server spec — server name reference or inline config
export type AgentMcpServerSpec = string | Record<string, McpStdioServerConfig | McpSSEServerConfig | McpHttpServerConfig | McpSdkServerConfig>;

// Agent definition
export interface AgentDefinition {
  description: string;
  tools?: string[];
  disallowedTools?: string[];
  prompt: string;
  model?: 'sonnet' | 'opus' | 'haiku' | 'inherit';
  maxTurns?: number;
  skills?: string[];
  mcpServers?: AgentMcpServerSpec[];
  criticalSystemReminder_EXPERIMENTAL?: string;
  name?: string;
  mode?: PermissionMode;
  isolation?: 'worktree' | 'none';
  timeoutMs?: number;
  allowBackgroundExecution?: boolean;
}

// MCP server configurations
export interface McpStdioServerConfig {
  type?: 'stdio';
  command: string;
  args?: string[];
  env?: Record<string, string>;
}

export interface McpSSEServerConfig {
  type: 'sse';
  url: string;
  headers?: Record<string, string>;
}

export interface McpHttpServerConfig {
  type: 'http';
  url: string;
  headers?: Record<string, string>;
}

export interface McpSdkServerConfig {
  type: 'sdk';
  name: string;
}

export interface McpClaudeAIProxyServerConfig {
  type: 'claudeai-proxy';
  url: string;
  id: string;
}

export type McpServerConfig =
  | McpStdioServerConfig
  | McpSSEServerConfig
  | McpHttpServerConfig
  | McpSdkServerConfig;

// SDK assistant message error types
export type SDKAssistantMessageError =
  | 'authentication_failed'
  | 'billing_error'
  | 'rate_limit'
  | 'invalid_request'
  | 'server_error'
  | 'unknown';

// SDK message types
export interface SDKAssistantMessage {
  type: 'assistant';
  message: any; // BetaMessage
  parent_tool_use_id: string | null;
  error?: SDKAssistantMessageError;
  uuid: string;
  session_id: string;
}

export interface SDKUserMessage {
  type: 'user';
  message: any; // MessageParam
  parent_tool_use_id: string | null;
  isSynthetic?: boolean;
  tool_use_result?: unknown;
  uuid?: string;
  session_id: string;
}

export interface SDKUserMessageReplay {
  type: 'user';
  message: any; // MessageParam
  parent_tool_use_id: string | null;
  isSynthetic?: boolean;
  tool_use_result?: unknown;
  uuid: string;
  session_id: string;
  isReplay: true;
}

export interface SDKResultSuccess {
  type: 'result';
  subtype: 'success';
  duration_ms: number;
  duration_api_ms: number;
  is_error: boolean;
  num_turns: number;
  result: string;
  stop_reason: string | null;
  total_cost_usd: number;
  usage: any;
  modelUsage: Record<string, ModelUsage>;
  permission_denials: PermissionDenial[];
  structured_output?: unknown;
  uuid: string;
  session_id: string;
}

export interface SDKResultError {
  type: 'result';
  subtype: 'error_during_execution' | 'error_max_turns' | 'error_max_budget_usd' | 'error_max_structured_output_retries';
  duration_ms: number;
  duration_api_ms: number;
  is_error: boolean;
  num_turns: number;
  stop_reason: string | null;
  total_cost_usd: number;
  usage: any;
  modelUsage: Record<string, ModelUsage>;
  permission_denials: PermissionDenial[];
  errors: string[];
  uuid: string;
  session_id: string;
}

export type SDKResultMessage = SDKResultSuccess | SDKResultError;

export interface PermissionDenial {
  tool_name: string;
  tool_use_id: string;
  tool_input: Record<string, unknown>;
}

export type ApiKeySource = 'user' | 'project' | 'org' | 'temporary' | 'oauth';

export interface SDKSystemMessage {
  type: 'system';
  subtype: 'init';
  tools: string[];
  model: string;
  permissionMode: PermissionMode;
  cwd: string;
  agents?: string[];
  apiKeySource?: ApiKeySource;
  betas?: string[];
  claude_code_version?: string;
  mcp_servers?: { name: string; status: string }[];
  slash_commands?: string[];
  output_style?: string;
  skills?: string[];
  plugins?: { name: string; path: string }[];
  uuid: string;
  session_id: string;
}

export interface SDKStatusMessage {
  type: 'system';
  subtype: 'status';
  status: 'compacting' | null;
  permissionMode?: PermissionMode;
  uuid: string;
  session_id: string;
}

export interface SDKCompactBoundaryMessage {
  type: 'system';
  subtype: 'compact_boundary';
  compact_metadata: {
    trigger: 'manual' | 'auto';
    pre_tokens: number;
  };
  uuid: string;
  session_id: string;
}

export interface SDKPartialAssistantMessage {
  type: 'stream_event';
  event: any; // BetaRawMessageStreamEvent
  parent_tool_use_id: string | null;
  uuid: string;
  session_id: string;
}

export interface SDKToolResultMessage {
  type: 'tool_result';
  tool_name: string;
  tool_use_id: string;
  result: string;
  /** Full untruncated tool result for transcript persistence (not for display). */
  _fullResult?: string;
  is_error: boolean;
  uuid: string;
  session_id: string;
}

export interface SDKTaskStartedMessage {
  type: 'system';
  subtype: 'task_started';
  task_id: string;
  tool_use_id?: string;
  description: string;
  task_type?: string;
  uuid: string;
  session_id: string;
}

export interface SDKTaskProgressMessage {
  type: 'system';
  subtype: 'task_progress';
  task_id: string;
  tool_use_id?: string;
  description: string;
  usage: {
    total_tokens: number;
    tool_uses: number;
    duration_ms: number;
  };
  last_tool_name?: string;
  uuid: string;
  session_id: string;
}

export interface SDKTaskNotificationMessage {
  type: 'system';
  subtype: 'task_notification';
  task_id: string;
  tool_use_id?: string;
  status: 'completed' | 'failed' | 'stopped';
  output_file: string;
  summary: string;
  usage?: {
    total_tokens: number;
    tool_uses: number;
    duration_ms: number;
  };
  uuid: string;
  session_id: string;
}

export interface SDKToolProgressMessage {
  type: 'tool_progress';
  tool_use_id: string;
  tool_name: string;
  parent_tool_use_id: string | null;
  elapsed_time_seconds: number;
  task_id?: string;
  uuid: string;
  session_id: string;
}

export interface SDKHookStartedMessage {
  type: 'system';
  subtype: 'hook_started';
  hook_id: string;
  hook_name: string;
  hook_event: string;
  uuid: string;
  session_id: string;
}

export interface SDKHookProgressMessage {
  type: 'system';
  subtype: 'hook_progress';
  hook_id: string;
  hook_name: string;
  hook_event: string;
  stdout: string;
  stderr: string;
  output: string;
  uuid: string;
  session_id: string;
}

export interface SDKHookResponseMessage {
  type: 'system';
  subtype: 'hook_response';
  hook_id: string;
  hook_name: string;
  hook_event: string;
  output: string;
  stdout: string;
  stderr: string;
  exit_code?: number;
  outcome: 'success' | 'error' | 'cancelled';
  uuid: string;
  session_id: string;
}

export interface SDKAuthStatusMessage {
  type: 'auth_status';
  isAuthenticating: boolean;
  output: string[];
  error?: string;
  uuid: string;
  session_id: string;
}

export interface SDKFilesPersistedEvent {
  type: 'system';
  subtype: 'files_persisted';
  files: { filename: string; file_id: string }[];
  failed: { filename: string; error: string }[];
  processed_at: string;
  uuid: string;
  session_id: string;
}

export interface SDKToolUseSummaryMessage {
  type: 'tool_use_summary';
  summary: string;
  preceding_tool_use_ids: string[];
  uuid: string;
  session_id: string;
}

export interface SDKRateLimitEvent {
  type: 'rate_limit_event';
  rate_limit_info: {
    status: 'allowed' | 'allowed_warning' | 'rejected';
    resetsAt?: number;
    utilization?: number;
  };
  uuid: string;
  session_id: string;
}

export interface SDKPromptSuggestionMessage {
  type: 'prompt_suggestion';
  suggestion: string;
  uuid: string;
  session_id: string;
}

export type SDKMessage =
  | SDKAssistantMessage
  | SDKUserMessage
  | SDKUserMessageReplay
  | SDKResultMessage
  | SDKSystemMessage
  | SDKStatusMessage
  | SDKCompactBoundaryMessage
  | SDKPartialAssistantMessage
  | SDKToolResultMessage
  | SDKTaskStartedMessage
  | SDKTaskProgressMessage
  | SDKTaskNotificationMessage
  | SDKToolProgressMessage
  | SDKHookStartedMessage
  | SDKHookProgressMessage
  | SDKHookResponseMessage
  | SDKAuthStatusMessage
  | SDKFilesPersistedEvent
  | SDKToolUseSummaryMessage
  | SDKRateLimitEvent
  | SDKPromptSuggestionMessage;

// Slash command definition
export interface SlashCommand {
  name: string;
  description: string;
  argumentHint: string;
}

// MCP server runtime status
export interface McpServerStatusTool {
  name: string;
  description?: string;
  annotations?: {
    readOnly?: boolean;
    destructive?: boolean;
    openWorld?: boolean;
  };
}

export type McpServerStatusConfig = McpServerConfig | McpClaudeAIProxyServerConfig;

export interface McpServerStatus {
  name: string;
  status: 'connected' | 'failed' | 'needs-auth' | 'pending' | 'disabled';
  serverInfo?: { name: string; version: string };
  error?: string;
  config?: McpServerStatusConfig;
  scope?: string;
  tools?: McpServerStatusTool[];
}

// Configuration scope and source
export type ConfigScope = 'local' | 'user' | 'project';
export type SettingSource = 'user' | 'project' | 'local';
