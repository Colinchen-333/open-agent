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
  PermissionPrompter,
} from '@open-agent/core';

export type PermissionUpdate = {
  type: 'addRules' | 'replaceRules' | 'removeRules';
  rules: Array<{ toolName: string; ruleContent?: string }>;
  behavior: 'allow' | 'deny' | 'ask';
  destination?: string;
};

export type PermissionResult =
  | {
      behavior: 'allow';
      updatedInput?: Record<string, unknown>;
      updatedPermissions?: PermissionUpdate[];
      toolUseID?: string;
    }
  | {
      behavior: 'deny';
      message: string;
      interrupt?: boolean;
      toolUseID?: string;
    };

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
  /**
   * Custom permission callback invoked before each tool use.
   * Return `false` to deny immediately; return `true` to fall through to the
   * normal permission evaluation.
   */
  canUseTool?: (
    tool: string,
    input: Record<string, unknown>,
    context: {
      signal: AbortSignal;
      suggestions?: PermissionUpdate[];
      blockedPath?: string;
      decisionReason?: string;
      toolUseID: string;
      agentID?: string;
    },
  ) =>
    | PermissionResult
    | boolean
    | { behavior: 'allow' | 'deny' | 'ask'; reason?: string }
    | Promise<PermissionResult | boolean | { behavior: 'allow' | 'deny' | 'ask'; reason?: string }>;
  /**
   * Async permission callback used when permissionEngine returns "ask".
   * Return:
   * - 'allow'  -> allow once
   * - 'deny'   -> deny
   * - 'always' -> allow and persist rule in current session
   */
  permissionPrompter?: PermissionPrompter['prompt'];
  /**
   * Name of an MCP tool that should be used to prompt the user for permission
   * decisions instead of the built-in interactive prompt.
   */
  permissionPromptToolName?: string;
  /**
   * Control which settings sources are loaded when building the system prompt.
   * Defaults to none (no filesystem settings are loaded).
   */
  settingSources?: Array<'user' | 'project' | 'local'>;
  // Official SDK compatibility placeholders (currently best-effort support).
  pathToClaudeCodeExecutable?: string;
  executable?: string;
  executableArgs?: string[];
  extraArgs?: Record<string, string | null>;
  betas?: string[];
  onElicitation?: unknown;
  plugins?: unknown[];
  resumeSessionAt?: unknown;
  sandbox?: unknown;
  debugFile?: string;
  spawnClaudeCodeProcess?: unknown;
  promptSuggestions?: boolean;
  strictMcpConfig?: boolean;
  stderr?: unknown;
  stdin?: unknown;
  stdout?: unknown;
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
 * Snapshot of session initialization state, returned by `initializationResult()`.
 */
export interface InitializationResult {
  /** Slash command metadata. */
  commands: SlashCommand[];
  /** Built-in and custom agents available to this session. */
  agents: AgentInfo[];
  /** Current output style. */
  output_style: string;
  /** Supported output styles. */
  available_output_styles: string[];
  /** Provider-reported model list. */
  models: ModelInfo[];
  /** Account/auth context. */
  account: AccountInfo;
  /** Fast mode state from the underlying runtime when available. */
  fast_mode_state?: unknown;
  /** @deprecated Legacy extension; not part of official SDK contract. */
  tools?: string[];
  /** @deprecated Legacy extension; not part of official SDK contract. */
  model?: string;
  /** @deprecated Legacy extension; not part of official SDK contract. */
  cwd?: string;
  /** @deprecated Legacy extension; not part of official SDK contract. */
  sessionId?: string;
  /** @deprecated Legacy extension; not part of official SDK contract. */
  permissionMode?: string;
}

export interface RewindFilesOptions {
  dryRun?: boolean;
}

export interface RewindFilesResult {
  canRewind: boolean;
  filesChanged?: string[];
  insertions?: number;
  deletions?: number;
  error?: string;
  /** @deprecated Non-official extension retained for back-compat. */
  rewindCount?: number;
}

export interface AgentInfo {
  name: string;
  description: string;
  model?: string;
}

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
  /** Return available built-in agent profiles. */
  supportedAgents(): Promise<AgentInfo[]>;
  /** Return the runtime status of every configured MCP server. */
  mcpServerStatus(): Promise<McpServerStatus[]>;
  /** Return account/billing information for the active API key. */
  accountInfo(): Promise<AccountInfo>;
  /**
   * Return initialization metadata that matches the official SDK control
   * response shape.
   */
  initializationResult(): Promise<InitializationResult>;
  /**
   * Abort the current task.  For a single `query()` call this is equivalent to
   * `interrupt()`.  The optional `taskId` parameter is accepted for API
   * symmetry with multi-task environments and is currently ignored.
   */
  stopTask(taskId: string): Promise<void>;
  /** Abort and clean up – equivalent to calling `interrupt()` without awaiting. */
  close(): void;

  // ── MCP dynamic management ──────────────────────────────────────────────

  /**
   * Reconnect a specific MCP server by name (disconnect → reconnect).
   * Throws if no MCP manager is configured for this query.
   */
  reconnectMcpServer(serverName: string): Promise<void>;

  /**
   * Enable or disable a specific MCP server without removing its config.
   * Throws if no MCP manager is configured for this query.
   */
  toggleMcpServer(serverName: string, enabled: boolean): Promise<void>;

  /**
   * Dynamically replace the full set of MCP servers for this query.
   * Creates an MCP manager on the fly if one was not configured at start-up.
   * Returns the diff of added/removed servers and any connection errors.
   */
  setMcpServers(
    servers: Record<string, McpServerConfig>,
  ): Promise<{ added: string[]; removed: string[]; errors: Record<string, string> }>;

  // ── File checkpointing ──────────────────────────────────────────────────

  /**
   * Restore all files that were modified at or after the given tool-use
   * checkpoint back to the state they were in before that tool ran.
   * Returns `true` when at least one file was restored, `false` if file
   * checkpointing is not enabled or the checkpoint was not found.
   */
  rewindFiles(userMessageId: string, options?: RewindFilesOptions): Promise<RewindFilesResult>;

  // ── Mid-stream input ─────────────────────────────────────────────────────

  /**
   * Push an additional user message into the running conversation mid-stream.
   * If the conversation loop does not support live injection the message is
   * queued and a warning is logged to stderr.
   */
  streamInput(input: AsyncIterable<SDKUserMessage> | string): Promise<void>;
}

export interface ListSessionsOptions {
  dir?: string;
  limit?: number;
}

export interface SessionSummary {
  sessionId: string;
  summary: string;
  lastModified: number;
  messageCount: number;
  fileSize: number;
  cwd: string;
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
