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

// Agent definition
export interface AgentDefinition {
  description: string;
  tools?: string[];
  disallowedTools?: string[];
  prompt: string;
  model?: 'sonnet' | 'opus' | 'haiku' | 'inherit';
  maxTurns?: number;
  skills?: string[];
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

export type McpServerConfig =
  | McpStdioServerConfig
  | McpSSEServerConfig
  | McpHttpServerConfig
  | McpSdkServerConfig;

// SDK message types
export interface SDKAssistantMessage {
  type: 'assistant';
  message: any; // BetaMessage
  parent_tool_use_id: string | null;
  error?: string;
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
  permission_denials: any[];
  structured_output?: unknown;
  uuid: string;
  session_id: string;
}

export interface SDKResultError {
  type: 'result';
  subtype: 'error_during_execution' | 'error_max_turns' | 'error_max_budget_usd';
  duration_ms: number;
  duration_api_ms: number;
  is_error: boolean;
  num_turns: number;
  stop_reason: string | null;
  total_cost_usd: number;
  usage: any;
  modelUsage: Record<string, ModelUsage>;
  permission_denials: any[];
  errors: string[];
  uuid: string;
  session_id: string;
}

export type SDKResultMessage = SDKResultSuccess | SDKResultError;

export interface SDKSystemMessage {
  type: 'system';
  subtype: 'init';
  tools: string[];
  model: string;
  permissionMode: PermissionMode;
  cwd: string;
  uuid: string;
  session_id: string;
}

export interface SDKStatusMessage {
  type: 'system';
  subtype: 'status';
  status: 'compacting' | null;
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
  is_error: boolean;
  uuid: string;
  session_id: string;
}

export type SDKMessage =
  | SDKAssistantMessage
  | SDKUserMessage
  | SDKResultMessage
  | SDKSystemMessage
  | SDKStatusMessage
  | SDKPartialAssistantMessage
  | SDKToolResultMessage;

// Slash command definition
export interface SlashCommand {
  name: string;
  description: string;
  argumentHint: string;
}

// MCP server runtime status
export interface McpServerStatus {
  name: string;
  status: 'connected' | 'connecting' | 'error' | 'disconnected';
  error?: string;
  tools?: string[];
}

// Configuration scope and source
export type ConfigScope = 'local' | 'user' | 'project';
export type SettingSource = 'user' | 'project' | 'local';
