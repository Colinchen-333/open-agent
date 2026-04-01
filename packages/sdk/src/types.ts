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
  SDKPromptSuggestionMessage,
  SDKTaskNotificationMessage,
  ThinkingConfig,
  ModelUsage,
  SlashCommand,
  PermissionPrompter,
  SettingSource,
  SessionInfo,
} from '@open-agent/core';
import type { SandboxConfig } from '@open-agent/permissions';
import type { LLMProvider } from '@open-agent/providers';
import type { CapabilitySnapshot } from '@open-agent/runtime';
import type { SkillCatalogEntry } from '@open-agent/skills';

export type PermissionRuleValue = {
  toolName: string;
  ruleContent?: string;
};

export type PermissionUpdateDestination =
  | 'userSettings'
  | 'projectSettings'
  | 'localSettings'
  | 'session'
  | 'cliArg';

export type PermissionUpdate =
  | {
      type: 'addRules';
      rules: PermissionRuleValue[];
      behavior: 'allow' | 'deny' | 'ask';
      destination: PermissionUpdateDestination;
    }
  | {
      type: 'replaceRules';
      rules: PermissionRuleValue[];
      behavior: 'allow' | 'deny' | 'ask';
      destination: PermissionUpdateDestination;
    }
  | {
      type: 'removeRules';
      rules: PermissionRuleValue[];
      behavior: 'allow' | 'deny' | 'ask';
      destination: PermissionUpdateDestination;
    }
  | {
      type: 'setMode';
      mode: PermissionMode;
      destination: PermissionUpdateDestination;
    }
  | {
      type: 'addDirectories';
      directories: string[];
      destination: PermissionUpdateDestination;
    }
  | {
      type: 'removeDirectories';
      directories: string[];
      destination: PermissionUpdateDestination;
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
  skillDirectories?: string[];
  includePluginSkills?: boolean;
  continue?: boolean;
  cwd?: string;
  disallowedTools?: string[];
  /** Tool selection: an explicit list of names or the built-in 'claude_code' preset. */
  tools?: string[] | { type: 'preset'; preset: 'claude_code' };
  /**
   * Callback invoked after the default tool registry is created but before
   * tool filtering is applied. Use this to register additional tools (e.g.
   * Task, Team, Skill) that require runtime dependencies.
   *
   * @example
   * ```ts
   * setupTools: (registry) => {
   *   registry.register(createTaskTool({ runSubagent: ... }));
   * }
   * ```
   */
  setupTools?: (registry: import('@open-agent/tools').ToolRegistry) => void | Promise<void>;
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
  /** Explicitly specify the LLM provider backend or inject a ready provider instance. */
  provider?: 'anthropic' | 'openai' | 'ollama' | LLMProvider;
  /** API key to use with the specified provider. */
  apiKey?: string;
  /** Custom base URL for the provider API (e.g. a proxy or self-hosted endpoint). */
  baseUrl?: string;
  /** Preferred natural language for assistant replies. */
  language?: string;
  /** Session-scoped output style metadata. */
  outputStyle?: 'text' | 'stream-json';
  /** Optional user-facing title stored with session metadata. */
  sessionTitle?: string;
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
  settingSources?: SettingSource[];
  // Official SDK compatibility placeholders (currently best-effort support).
  pathToClaudeCodeExecutable?: string;
  executable?: string;
  executableArgs?: string[];
  extraArgs?: Record<string, string | null>;
  betas?: string[];
  onElicitation?: unknown;
  plugins?: unknown[];
  resumeSessionAt?: string;
  sandbox?: SandboxConfig;
  /** Server-side tools executed by the API provider (e.g. Anthropic native web search). */
  serverTools?: import('@open-agent/providers').ServerToolSpec[];
  /**
   * When `true` and the prompt is an `AsyncIterable`, the query stays alive
   * after the source iterable is exhausted, waiting for new messages pushed
   * via `streamInput()`.  Defaults to `false` for backwards compatibility.
   */
  idleOnPromptExhaustion?: boolean;
  debugFile?: string;
  spawnClaudeCodeProcess?: unknown;
  promptSuggestions?: boolean;
  strictMcpConfig?: boolean;
  stderr?: unknown;
  stdin?: unknown;
  stdout?: unknown;
  /**
   * Callback invoked when a subagent emits tool events.
   * `parentToolCallId` is the tool_use_id of the Task tool that spawned the subagent.
   * Used by desktop adapter to surface subagent progress in real-time.
   */
  onSubagentEvent?: (parentToolCallId: string, event: import('@open-agent/agents').SubagentStreamEvent) => void;
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
  language?: string;
  outputStyle?: 'text' | 'stream-json';
  sessionTitle?: string;
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
  /** Available skills resolved by the runtime. */
  skills: SkillCatalogEntry[];
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
  /** Runtime capability snapshot for routing, planning, and diagnostics. */
  capability_snapshot?: CapabilitySnapshot;
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

export interface BackgroundTaskSummary {
  task_id: string;
  type: 'bash' | 'agent';
  status: string;
  summary: string;
  session_id?: string;
  cwd?: string;
  output_file?: string;
  command?: string;
  started_at?: number;
}

export interface BackgroundTaskInspection {
  task_id: string;
  type: 'bash' | 'agent' | 'unknown';
  status: string;
  state?: string;
  summary: string;
  output_preview?: string;
  output_file?: string;
  session_id?: string;
  command?: string;
  started_at?: number;
  duration_ms?: number;
}

export interface WorkerRecord {
  workerId: string;
  workerType: string;
  name?: string;
  status: 'spawning' | 'running' | 'idle' | 'completed' | 'failed' | 'shutdown';
  parentToolCallId?: string;
  parentSessionId?: string;
  teamName?: string;
  model: string;
  mode?: string;
  startedAt: string;
  completedAt?: string;
  outputFile?: string;
  worktreePath?: string;
  worktreeBranch?: string;
  numTurns: number;
  durationMs: number;
  totalToolUseCount?: number;
  totalTokens?: number;
  summary: string;
  result?: string;
  error?: string;
}

export interface WorkerListOptions {
  teamName?: string;
}

export interface WorkerFollowUpSuggestion {
  suggestion: string;
  scaffold: NonNullable<SDKPromptSuggestionMessage['scaffold']>;
}

export interface WorkerLaunchInput {
  prompt: string;
  name?: string;
  teamName?: string;
  model?: string;
  maxTurns?: number;
  mode?: string;
  cwd?: string;
  isolation?: 'worktree';
}

export interface TaskLeaseInfo {
  owner: string;
  claimedAt: string;
  expiresAt: string;
  attempts: number;
}

export interface TaskRecord {
  id: string;
  subject: string;
  description: string;
  status: 'pending' | 'in_progress' | 'completed' | 'deleted';
  owner?: string;
  priority?: number;
  activeForm?: string;
  blocks: string[];
  blockedBy: string[];
  lease?: TaskLeaseInfo;
  createdAt: string;
  updatedAt: string;
  metadata?: Record<string, unknown>;
  teamName: string;
}

export interface TaskListOptions {
  teamName?: string;
  availableOnly?: boolean;
  now?: Date;
}

export interface TaskCreateInput {
  subject: string;
  description: string;
  activeForm?: string;
  metadata?: Record<string, unknown>;
  priority?: number;
  teamName?: string;
}

export interface TaskUpdateInput {
  taskId: string;
  teamName?: string;
  status?: TaskRecord['status'];
  subject?: string;
  description?: string;
  activeForm?: string;
  owner?: string;
  priority?: number;
  addBlocks?: string[];
  addBlockedBy?: string[];
  metadata?: Record<string, unknown>;
}

export interface TaskClaimOptions {
  teamName?: string;
  leaseMs?: number;
  now?: Date;
}

export interface TaskReleaseOptions {
  teamName?: string;
  status?: 'pending' | 'completed';
}

export interface TeamMemberRecord {
  name: string;
  agentId: string;
  agentType: string;
  model?: string;
  status: 'active' | 'idle' | 'shutdown';
}

export interface TeamRecord {
  name: string;
  description?: string;
  members: TeamMemberRecord[];
  createdAt: string;
  configPath: string;
  scratchpadPath: string;
  inboxesPath: string;
  taskQueuePath: string;
  isActive: boolean;
}

export interface TeamMessageRecord {
  teamName: string;
  type: 'message' | 'broadcast' | 'shutdown_request' | 'shutdown_response' | 'plan_approval_response' | 'idle_notification' | 'plan_approval_request';
  from: string;
  to?: string;
  content: string;
  summary?: string;
  timestamp: string;
  requestId?: string;
  approve?: boolean;
  idleReason?: string;
  routing?: {
    sender: string;
    senderColor?: string;
    target: string;
    targetColor?: string;
    summary?: string;
    content?: string;
  };
}

export interface TeamCreateInput {
  name: string;
  description?: string;
  setActive?: boolean;
}

export interface TeamMessageInput {
  teamName?: string;
  type: TeamMessageRecord['type'];
  from?: string;
  to?: string;
  recipient?: string;
  content?: string;
  summary?: string;
  approve?: boolean;
  requestId?: string;
}

export interface TeamInboxOptions {
  teamName?: string;
  memberName: string;
  consume?: boolean;
}

export type SDKOrchestrationEventKind = 'worker_lifecycle' | 'worker_tool';

export interface SDKOrchestrationEvent {
  kind: SDKOrchestrationEventKind;
  sessionId: string;
  parentToolCallId: string;
  workerId?: string;
  teamName?: string;
  raw: import('@open-agent/agents').SubagentStreamEvent;
}

export interface SubscribeOrchestrationEventsOptions {
  types?: SDKOrchestrationEventKind[];
  teamName?: string;
  signal?: AbortSignal;
}

export type SDKTimelineItemKind = 'team_message' | SDKOrchestrationEventKind | 'task_notification';

export interface SDKTimelineItem {
  kind: SDKTimelineItemKind;
  sessionId: string;
  timestamp: string;
  teamName?: string;
  workerId?: string;
  parentToolCallId?: string;
  teamMessage?: TeamMessageRecord;
  orchestrationEvent?: SDKOrchestrationEvent;
  taskNotification?: SDKTaskNotificationMessage;
}

export interface SubscribeTimelineOptions {
  teamName?: string;
  memberName?: string;
  includeTeamMessages?: boolean;
  includeOrchestration?: boolean;
  includeTaskNotifications?: boolean;
  consumeTeamInbox?: boolean;
  orchestrationTypes?: SDKOrchestrationEventKind[];
  pollIntervalMs?: number;
  signal?: AbortSignal;
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
  /** Return the resolved skill catalog for this session. */
  supportedSkills(): Promise<SkillCatalogEntry[]>;
  /** Return the runtime status of every configured MCP server. */
  mcpServerStatus(): Promise<McpServerStatus[]>;
  /** Return account/billing information for the active API key. */
  accountInfo(): Promise<AccountInfo>;
  /**
   * Return initialization metadata that matches the official SDK control
   * response shape.
   */
  initializationResult(): Promise<InitializationResult>;
  /** Return persisted metadata for the current session. */
  sessionInfo(): Promise<SessionInfo | null>;
  /** List all known teams visible to this SDK session. */
  listTeams(): Promise<TeamRecord[]>;
  /** Return one team by name, or null if it does not exist. */
  getTeam(name: string): Promise<TeamRecord | null>;
  /** Create a team and optionally make it active for this session. */
  createTeam(input: TeamCreateInput): Promise<TeamRecord>;
  /** Delete a team and return whether it existed. */
  deleteTeam(name: string): Promise<{ success: boolean }>;
  /** Return the currently active team for this session, if any. */
  getActiveTeam(): Promise<TeamRecord | null>;
  /** Change the active team for this session, or clear it with null. */
  setActiveTeam(name: string | null): Promise<TeamRecord | null>;
  /** Send a team message into the selected or named team inbox fabric. */
  sendTeamMessage(input: TeamMessageInput): Promise<TeamMessageRecord>;
  /** Read or peek a member inbox from the selected or named team. */
  readTeamInbox(options: TeamInboxOptions): Promise<TeamMessageRecord[]>;
  /** Return the unread inbox count for a member in the selected or named team. */
  getTeamInboxCount(memberName: string, options?: { teamName?: string }): Promise<number>;
  /** Read the selected team inbox and normalize messages into unified timeline items. */
  readTimelineInbox(options: TeamInboxOptions): Promise<SDKTimelineItem[]>;
  /** Subscribe to live worker orchestration events for this SDK session. */
  subscribeOrchestrationEvents(options?: SubscribeOrchestrationEventsOptions): AsyncIterable<SDKOrchestrationEvent>;
  /** Subscribe to a merged timeline of team inbox messages and worker orchestration events. */
  subscribeTimeline(options?: SubscribeTimelineOptions): AsyncIterable<SDKTimelineItem>;
  /** List known worker sessions visible to this SDK session. */
  listWorkers(options?: WorkerListOptions): Promise<WorkerRecord[]>;
  /** Return one worker session by ID, or null if it does not exist. */
  getWorker(workerId: string): Promise<WorkerRecord | null>;
  /** Build Claude Code style follow-up suggestions for a finished worker. */
  getWorkerFollowUps(workerId: string): Promise<WorkerFollowUpSuggestion[]>;
  /** Launch a background worker directly through the SDK control plane. */
  launchWorker(input: WorkerLaunchInput): Promise<WorkerRecord>;
  /** Launch a fresh background verifier directly through the SDK control plane. */
  launchVerifier(input: WorkerLaunchInput): Promise<WorkerRecord>;
  /** Resume an existing worker directly through the SDK control plane. */
  resumeWorker(workerId: string, input: WorkerLaunchInput): Promise<WorkerRecord>;
  /** Stop a live worker in the current runtime and report whether it was found. */
  stopWorker(workerId: string): Promise<{ success: boolean }>;
  /** Return visible background bash/agent tasks for the current runtime. */
  listBackgroundTasks(): Promise<BackgroundTaskSummary[]>;
  /** Return task records from the shared task control plane for the current or specified team. */
  listTasks(options?: TaskListOptions): Promise<TaskRecord[]>;
  /** Return a single task record, or null if it does not exist. */
  getTask(taskId: string, options?: { teamName?: string }): Promise<TaskRecord | null>;
  /** Create a task record in the shared task control plane. */
  createTask(input: TaskCreateInput): Promise<TaskRecord>;
  /** Update a task record in the shared task control plane. */
  updateTask(input: TaskUpdateInput): Promise<TaskRecord>;
  /** Claim the next available task for a worker, applying a lease. */
  claimNextTask(owner: string, options?: TaskClaimOptions): Promise<TaskRecord | null>;
  /** Heartbeat / renew an existing claimed task lease. */
  heartbeatTask(taskId: string, owner: string, options?: TaskClaimOptions): Promise<TaskRecord>;
  /** Release a claimed task back to pending or mark it completed. */
  releaseTask(taskId: string, owner: string, options?: TaskReleaseOptions): Promise<TaskRecord>;
  /** Return structured details for a specific background task, if found. */
  getBackgroundTask(taskId: string, options?: { block?: boolean; timeout?: number }): Promise<BackgroundTaskInspection | null>;
  /**
   * Abort the current task.  For a single `query()` call this is equivalent to
   * `interrupt()`.  The `taskId` parameter is accepted for API symmetry with
   * multi-task environments and is currently ignored.
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
  /** List all known teams visible to this SDK session. */
  listTeams(): Promise<TeamRecord[]>;
  /** Return one team by name, or null if it does not exist. */
  getTeam(name: string): Promise<TeamRecord | null>;
  /** Create a team and optionally make it active for this session. */
  createTeam(input: TeamCreateInput): Promise<TeamRecord>;
  /** Delete a team and return whether it existed. */
  deleteTeam(name: string): Promise<{ success: boolean }>;
  /** Return the currently active team for this session, if any. */
  getActiveTeam(): Promise<TeamRecord | null>;
  /** Change the active team for this session, or clear it with null. */
  setActiveTeam(name: string | null): Promise<TeamRecord | null>;
  /** Send a team message into the selected or named team inbox fabric. */
  sendTeamMessage(input: TeamMessageInput): Promise<TeamMessageRecord>;
  /** Read or peek a member inbox from the selected or named team. */
  readTeamInbox(options: TeamInboxOptions): Promise<TeamMessageRecord[]>;
  /** Return the unread inbox count for a member in the selected or named team. */
  getTeamInboxCount(memberName: string, options?: { teamName?: string }): Promise<number>;
  /** Read the selected team inbox and normalize messages into unified timeline items. */
  readTimelineInbox(options: TeamInboxOptions): Promise<SDKTimelineItem[]>;
  /** Subscribe to live worker orchestration events for this SDK session. */
  subscribeOrchestrationEvents(options?: SubscribeOrchestrationEventsOptions): AsyncIterable<SDKOrchestrationEvent>;
  /** Subscribe to a merged timeline of team inbox messages and worker orchestration events. */
  subscribeTimeline(options?: SubscribeTimelineOptions): AsyncIterable<SDKTimelineItem>;
  /** List known worker sessions visible to this SDK session. */
  listWorkers(options?: WorkerListOptions): Promise<WorkerRecord[]>;
  /** Return one worker session by ID, or null if it does not exist. */
  getWorker(workerId: string): Promise<WorkerRecord | null>;
  /** Build Claude Code style follow-up suggestions for a finished worker. */
  getWorkerFollowUps(workerId: string): Promise<WorkerFollowUpSuggestion[]>;
  /** Launch a background worker directly through the SDK control plane. */
  launchWorker(input: WorkerLaunchInput): Promise<WorkerRecord>;
  /** Launch a fresh background verifier directly through the SDK control plane. */
  launchVerifier(input: WorkerLaunchInput): Promise<WorkerRecord>;
  /** Resume an existing worker directly through the SDK control plane. */
  resumeWorker(workerId: string, input: WorkerLaunchInput): Promise<WorkerRecord>;
  /** Stop a live worker in the current runtime and report whether it was found. */
  stopWorker(workerId: string): Promise<{ success: boolean }>;
  /** Return task records from the shared task control plane for the current or specified team. */
  listTasks(options?: TaskListOptions): Promise<TaskRecord[]>;
  /** Return a single task record, or null if it does not exist. */
  getTask(taskId: string, options?: { teamName?: string }): Promise<TaskRecord | null>;
  /** Create a task record in the shared task control plane. */
  createTask(input: TaskCreateInput): Promise<TaskRecord>;
  /** Update a task record in the shared task control plane. */
  updateTask(input: TaskUpdateInput): Promise<TaskRecord>;
  /** Claim the next available task for a worker, applying a lease. */
  claimNextTask(owner: string, options?: TaskClaimOptions): Promise<TaskRecord | null>;
  /** Heartbeat / renew an existing claimed task lease. */
  heartbeatTask(taskId: string, owner: string, options?: TaskClaimOptions): Promise<TaskRecord>;
  /** Release a claimed task back to pending or mark it completed. */
  releaseTask(taskId: string, owner: string, options?: TaskReleaseOptions): Promise<TaskRecord>;
  /** Close the session and release resources. */
  close(): void;
  /** Supports `await using session = …` (TC39 explicit resource management). */
  [Symbol.asyncDispose](): Promise<void>;
}
