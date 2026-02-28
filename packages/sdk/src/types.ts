import type {
  SDKMessage,
  SDKResultMessage,
  SDKUserMessage,
  PermissionMode,
  HookEvent,
  ModelInfo,
  AccountInfo,
  McpServerConfig,
  McpServerStatus,
  AgentDefinition,
  ThinkingConfig,
  ModelUsage,
  SlashCommand,
} from '@open-agent/core';

// --------------------------------------------------------------------------
// V1 API Options (query())
// --------------------------------------------------------------------------

export interface QueryOptions {
  abortController?: AbortController;
  additionalDirectories?: string[];
  agent?: string;
  agents?: Record<string, AgentDefinition>;
  allowedTools?: string[];
  continue?: boolean;
  cwd?: string;
  disallowedTools?: string[];
  /** Tool selection: an explicit list of names or the built-in 'claude_code' preset. */
  tools?: string[] | { type: 'preset'; preset: 'claude_code' };
  env?: Record<string, string | undefined>;
  fallbackModel?: string;
  enableFileCheckpointing?: boolean;
  forkSession?: boolean;
  hooks?: Partial<Record<HookEvent, any[]>>;
  persistSession?: boolean;
  includePartialMessages?: boolean;
  thinking?: ThinkingConfig;
  effort?: 'low' | 'medium' | 'high' | 'max';
  maxThinkingTokens?: number;
  maxTurns?: number;
  maxBudgetUsd?: number;
  mcpServers?: Record<string, McpServerConfig>;
  model?: string;
  /** Explicitly specify the LLM provider backend. */
  provider?: 'anthropic' | 'openai' | 'ollama';
  /** API key to use with the specified provider. */
  apiKey?: string;
  /** Custom base URL for the provider API (e.g. a proxy or self-hosted endpoint). */
  baseUrl?: string;
  outputFormat?: { type: 'json_schema'; schema: Record<string, unknown> };
  permissionMode?: PermissionMode;
  allowDangerouslySkipPermissions?: boolean;
  resume?: string;
  sessionId?: string;
  systemPrompt?: string | { type: 'preset'; preset: 'claude_code'; append?: string };
  debug?: boolean;
}

// --------------------------------------------------------------------------
// V2 API Session Options (unstable_v2_*)
// --------------------------------------------------------------------------

export interface SessionOptions {
  model: string;
  cwd?: string;
  env?: Record<string, string | undefined>;
  allowedTools?: string[];
  disallowedTools?: string[];
  hooks?: Partial<Record<HookEvent, any[]>>;
  permissionMode?: PermissionMode;
}

// --------------------------------------------------------------------------
// Query interface – V1 streaming handle
// --------------------------------------------------------------------------

/**
 * Returned by `query()`.  Implements `AsyncGenerator<SDKMessage>` so callers
 * can iterate with `for await … of` as well as calling control methods.
 */
export interface Query extends AsyncGenerator<SDKMessage, void> {
  /** Abort the running conversation (fires the AbortController if provided). */
  interrupt(): Promise<void>;
  /** Dynamically change the permission mode mid-run. */
  setPermissionMode(mode: PermissionMode): Promise<void>;
  /** Swap the model mid-run (takes effect on the next LLM call). */
  setModel(model?: string): Promise<void>;
  /** Adjust the extended-thinking token budget mid-run. */
  setMaxThinkingTokens(maxThinkingTokens: number | null): Promise<void>;
  /** Return the list of available slash commands for this session. */
  supportedCommands(): Promise<SlashCommand[]>;
  /** Return the provider's model list. */
  supportedModels(): Promise<ModelInfo[]>;
  /** Return the runtime status of every configured MCP server. */
  mcpServerStatus(): Promise<McpServerStatus[]>;
  /** Return account/billing information for the active API key. */
  accountInfo(): Promise<AccountInfo>;
  /** Abort and clean up – equivalent to calling `interrupt()` without awaiting. */
  close(): void;
}

// --------------------------------------------------------------------------
// Session interface – V2 stateful session handle
// --------------------------------------------------------------------------

export interface Session {
  /** Stable identifier for this session (passed back in every SDKMessage). */
  readonly sessionId: string;
  /** Enqueue a user message to be processed by the agent. */
  send(message: string | SDKUserMessage): Promise<void>;
  /** Async-iterate over all SDKMessages produced by the session. */
  stream(): AsyncGenerator<SDKMessage, void>;
  /** Close the session and release resources. */
  close(): void;
  /** Supports `await using session = …` (TC39 explicit resource management). */
  [Symbol.asyncDispose](): Promise<void>;
}
