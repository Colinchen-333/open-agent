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
import type { PluginConfig } from '@open-agent/plugins';
import type { SkillCatalogEntry } from '@open-agent/skills';
import type { ToolCapabilityExportEntry, ToolDefinition } from '@open-agent/tools';

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
  /** Advanced/internal transcript adapter used by higher-level session wrappers. */
  sessionManager?: {
    ensureSession(cwd: string, sessionId: string, model: string, metadata?: Record<string, unknown>): unknown;
    appendToTranscript(cwd: string, sessionId: string, message: unknown): void;
    readTranscript(cwd: string, sessionId: string): unknown[];
    getSession(cwd: string, sessionId: string): SessionInfo | null;
    touchSession?(cwd: string, sessionId: string): unknown;
  };
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
  plugins?: PluginConfig[];
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

export interface RuntimeDiagnosticRecord {
  code: string;
  message: string;
  severity: 'info' | 'warning' | 'error';
  source?: 'plugin' | 'hook' | 'agent' | 'runtime';
}

export interface RuntimeControlPlanePluginRecord {
  name: string;
  path: string;
  version: string;
  enabled: boolean;
  agentCount: number;
  skillCount: number;
  commandCount: number;
  mcpServerCount: number;
  hookEventCount: number;
  hookCount: number;
}

export interface RuntimeControlPlaneHookRecord {
  event: string;
  count: number;
  sources: string[];
}

export interface RuntimeControlPlaneMcpServerRecord {
  name: string;
  status: 'connected' | 'connecting' | 'disconnected' | 'error';
  toolCount: number;
  error?: string;
}

export interface RuntimeControlPlaneCapabilitySummary {
  totalTools: number;
  mcpTools: number;
  dynamicTools: number;
}

export interface SessionStateSnapshot {
  sessionId: string;
  status: 'idle' | 'running' | 'closed' | 'failed';
  activeTurn: boolean;
  canAcceptInput: boolean;
  pendingInputCount: number;
  model: string;
  permissionMode: PermissionMode;
  activeTeamName: string | null;
  lastActivityAt: string;
  lastResultAt?: string;
  idleReason?: string;
  lastError?: string;
}

export interface ProviderCapabilityRecord {
  provider: string;
  model: string;
  thinkingMode: 'native' | 'best_effort' | 'unsupported';
  structuredOutputMode: 'native' | 'best_effort' | 'unsupported';
  toolUseMode: 'native' | 'best_effort' | 'unsupported';
  serverToolsMode: 'native' | 'best_effort' | 'unsupported';
  supportsThinking: boolean;
  supportsAdaptiveThinking: boolean;
  supportsStructuredOutput: boolean;
  supportsImages: boolean;
  supportsServerTools: boolean;
  supportsEffort: boolean;
  supportedEffortLevels: NonNullable<ModelInfo['supportedEffortLevels']>;
}

export interface RuntimeToolMutationResult {
  added: string[];
  replaced: string[];
}

export interface RuntimeToolRemovalResult {
  removed: string[];
}

export interface RuntimeControlPlaneSnapshot {
  sessionId: string;
  cwd: string;
  model: string;
  permissionMode: PermissionMode;
  activeTeamName: string | null;
  mcpServers: RuntimeControlPlaneMcpServerRecord[];
  runtime: {
    agentNames: string[];
    skillNames: string[];
    plugins: RuntimeControlPlanePluginRecord[];
    hooks: RuntimeControlPlaneHookRecord[];
    diagnostics: RuntimeDiagnosticRecord[];
    capabilitySummary: RuntimeControlPlaneCapabilitySummary;
  };
}

export interface RuntimeDiagnosticListOptions {
  severity?: RuntimeDiagnosticRecord['severity'];
  source?: NonNullable<RuntimeDiagnosticRecord['source']>;
}

export interface OrchestrationControlPlaneOptions {
  teamName?: string;
}

export interface OrchestrationControlPlaneSummary {
  taskCount: number;
  pendingTaskCount: number;
  inProgressTaskCount: number;
  completedTaskCount: number;
  deletedTaskCount: number;
  leasedTaskCount: number;
  workerCount: number;
  runningWorkerCount: number;
  idleWorkerCount: number;
  terminalWorkerCount: number;
  dispatcherCount: number;
  liveDispatcherCount: number;
  ledgerDispatcherCount: number;
  transcriptDispatcherCount: number;
  runningDispatcherCount: number;
  drainingDispatcherCount: number;
  stoppedDispatcherCount: number;
  activeAssignmentCount: number;
  unhealthyDispatcherCount: number;
  dispatcherErrorCount: number;
  dispatcherWarningCount: number;
}

export interface OrchestrationControlPlaneSnapshot {
  sessionId: string;
  activeTeamName: string | null;
  summary: OrchestrationControlPlaneSummary;
  tasks: TaskRecord[];
  workers: WorkerRecord[];
  dispatchers: TaskDispatcherRecord[];
  dispatcherDiagnoses: TaskDispatcherHealthReport[];
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

export type SubagentRecord = WorkerRecord;

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

export interface TaskDispatchInput extends TaskClaimOptions {
  owner: string;
  workerType?: 'worker' | 'verifier';
  name?: string;
  prompt?: string;
  model?: string;
  maxTurns?: number;
  mode?: string;
  cwd?: string;
  isolation?: 'worktree';
}

export interface TaskDispatchResult {
  task: TaskRecord;
  worker: WorkerRecord;
}

export interface TaskDispatcherStartInput extends TaskDispatchInput {
  dispatcherId?: string;
  pollIntervalMs?: number;
  maxConcurrentWorkers?: number;
}

export interface TaskDispatcherAssignmentRecord {
  taskId: string;
  workerId: string;
  claimedAt?: string;
  lastHeartbeatAt?: string;
  leaseExpiresAt?: string;
  attempts?: number;
}

export interface TaskDispatcherRecord {
  dispatcherId: string;
  owner: string;
  teamName: string;
  source: 'live' | 'ledger' | 'transcript';
  workerType: 'worker' | 'verifier';
  status: 'running' | 'draining' | 'stopped';
  pollIntervalMs: number;
  leaseMs: number;
  maxConcurrentWorkers: number;
  name?: string;
  prompt?: string;
  model?: string;
  maxTurns?: number;
  mode?: string;
  cwd?: string;
  isolation?: 'worktree';
  activeTaskIds: string[];
  activeWorkerIds: string[];
  activeAssignments: TaskDispatcherAssignmentRecord[];
  startedAt: string;
  updatedAt: string;
  stoppedAt?: string;
  lastDispatchAt?: string;
}

export interface TaskDispatcherListOptions {
  teamName?: string;
  status?: TaskDispatcherRecord['status'];
}

export interface TaskDispatcherStopResult {
  success: boolean;
  dispatcher: TaskDispatcherRecord | null;
}

export interface TaskDispatcherRequeueInput {
  dispatcherId: string;
  workerId?: string;
  taskId?: string;
  stopWorker?: boolean;
}

export interface TaskDispatcherRequeueResult {
  success: boolean;
  dispatcher: TaskDispatcherRecord | null;
  task: TaskRecord | null;
  workerStop?: { success: boolean };
}

export type TaskDispatcherHealthCode =
  | 'stuck_assignment'
  | 'worker_missing'
  | 'task_missing'
  | 'assignment_drift'
  | 'lease_expired'
  | 'draining_timeout';

export interface TaskDispatcherHealthFinding {
  code: TaskDispatcherHealthCode;
  severity: 'warning' | 'error';
  message: string;
  observedAt: string;
  taskId?: string;
  workerId?: string;
}

export interface TaskDispatcherHealthSummary {
  totalFindings: number;
  errorCount: number;
  warningCount: number;
  affectedTaskIds: string[];
  affectedWorkerIds: string[];
}

export interface TaskDispatcherHealthOptions {
  now?: string | Date;
  heartbeatGraceMs?: number;
  drainingTimeoutMs?: number;
}

export interface TaskDispatcherDiagnosisListOptions {
  teamName?: string;
  healthy?: boolean;
}

export interface TaskDispatcherHealthReport {
  dispatcherId: string;
  source: TaskDispatcherRecord['source'];
  observedAt: string;
  healthy: boolean;
  dispatcher: TaskDispatcherRecord;
  findings: TaskDispatcherHealthFinding[];
  summary: TaskDispatcherHealthSummary;
  followUps: WorkerFollowUpSuggestion[];
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
  messageId?: string;
  teamName: string;
  type: 'message' | 'broadcast' | 'shutdown_request' | 'shutdown_response' | 'plan_approval_response' | 'idle_notification' | 'plan_approval_request';
  from: string;
  to?: string;
  content: string;
  summary?: string;
  timestamp: string;
  readAt?: string;
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
  acknowledge?: boolean;
  unreadOnly?: boolean;
  after?: string;
  limit?: number;
}

export interface TeamInboxAcknowledgeInput {
  teamName?: string;
  memberName: string;
  messageIds: string[];
}

export type TeamApprovalRequestType = 'shutdown_request' | 'plan_approval_request';

export type TeamApprovalResponseType = 'shutdown_response' | 'plan_approval_response';

export interface TeamApprovalRecord {
  messageId?: string;
  teamName: string;
  memberName: string;
  requestType: TeamApprovalRequestType;
  requestId: string;
  from: string;
  to?: string;
  content: string;
  summary?: string;
  timestamp: string;
  readAt?: string;
}

export interface TeamApprovalListOptions {
  teamName?: string;
  memberName: string;
  unreadOnly?: boolean;
  after?: string;
  limit?: number;
}

export interface TeamApprovalResponseInput {
  teamName?: string;
  memberName: string;
  messageId?: string;
  requestId?: string;
  approve: boolean;
  from?: string;
  feedback?: string;
  acknowledge?: boolean;
}

export interface TeamApprovalResponseResult {
  acknowledged: number;
  request: TeamApprovalRecord;
  response: TeamMessageRecord;
}

export type SDKTaskDispatcherEventType =
  | 'started'
  | 'dispatched'
  | 'task_completed'
  | 'task_requeued'
  | 'draining'
  | 'stopped';

export interface SDKTaskDispatcherEvent {
  type: SDKTaskDispatcherEventType;
  dispatcherId: string;
  owner: string;
  teamName: string;
  workerType: 'worker' | 'verifier';
  source: TaskDispatcherRecord['source'];
  status: TaskDispatcherRecord['status'];
  timestamp: string;
  pollIntervalMs: number;
  leaseMs: number;
  maxConcurrentWorkers: number;
  name?: string;
  prompt?: string;
  model?: string;
  maxTurns?: number;
  mode?: string;
  cwd?: string;
  isolation?: 'worktree';
  taskId?: string;
  workerId?: string;
  taskStatus?: TaskRecord['status'];
  activeTaskIds: string[];
  activeWorkerIds: string[];
  activeAssignments: TaskDispatcherAssignmentRecord[];
  startedAt: string;
  updatedAt: string;
  lastDispatchAt?: string;
  stoppedAt?: string;
  followUps: WorkerFollowUpSuggestion[];
}

export type SDKOrchestrationEventKind = 'worker_lifecycle' | 'worker_tool' | 'task_dispatcher';

export interface SDKOrchestrationEvent {
  kind: SDKOrchestrationEventKind;
  sessionId: string;
  parentToolCallId: string;
  workerId?: string;
  dispatcherId?: string;
  taskId?: string;
  teamName?: string;
  lifecycle?: 'launched' | 'completed' | 'failed' | 'shutdown';
  dispatcherEvent?: SDKTaskDispatcherEvent;
  raw: import('@open-agent/agents').SubagentStreamEvent | SDKTaskDispatcherEvent;
}

export interface SubscribeOrchestrationEventsOptions {
  types?: SDKOrchestrationEventKind[];
  teamName?: string;
  signal?: AbortSignal;
}

export interface SDKTaskNotificationRecord {
  taskId: string;
  status: SDKTaskNotificationMessage['status'];
  teamName?: string;
  description?: string;
  completedAt?: string;
  outputFile?: string;
  summary: string;
  result?: string;
  usage?: SDKTaskNotificationMessage['usage'];
  orchestrationTemplates?: SDKTaskNotificationMessage['orchestration_templates'];
  followUps: WorkerFollowUpSuggestion[];
}

export type SDKTimelineItemKind = 'team_message' | SDKOrchestrationEventKind | 'task_notification';

export interface SDKTimelineItem {
  kind: SDKTimelineItemKind;
  timelineId?: string;
  cursor?: string;
  sessionId: string;
  timestamp: string;
  teamName?: string;
  workerId?: string;
  parentToolCallId?: string;
  readAt?: string;
  teamMessage?: TeamMessageRecord;
  orchestrationEvent?: SDKOrchestrationEvent;
  taskNotification?: SDKTaskNotificationRecord;
}

export interface TimelineInboxOptions {
  teamName?: string;
  memberName?: string;
  includeTeamMessages?: boolean;
  includeOrchestration?: boolean;
  orchestrationTypes?: SDKOrchestrationEventKind[];
  includeTaskNotifications?: boolean;
  consume?: boolean;
  acknowledge?: boolean;
  unreadOnly?: boolean;
  after?: string;
  limit?: number;
}

export interface SubscribeTimelineOptions extends TimelineInboxOptions {
  pollIntervalMs?: number;
  signal?: AbortSignal;
}

export type FollowUpExecutable =
  | WorkerFollowUpSuggestion
  | NonNullable<SDKPromptSuggestionMessage['scaffold']>;

export interface FollowUpExecutionResult {
  kind: 'worker' | 'team_message' | 'task_dispatcher';
  followUpKind: NonNullable<SDKPromptSuggestionMessage['scaffold']>['kind'];
  worker?: WorkerRecord;
  teamMessage?: TeamMessageRecord;
  dispatcher?: TaskDispatcherRecord;
  dispatcherStop?: TaskDispatcherStopResult;
  dispatcherRequeue?: TaskDispatcherRequeueResult;
}

/**
 * Returned by `query()`.  Implements `AsyncGenerator<SDKMessage>` so callers
 * can iterate with `for await … of` as well as calling control methods.
 */
export interface Query extends AsyncGenerator<SDKMessage, void> {
  /** Abort the running conversation (fires the AbortController if provided). */
  interrupt(): Promise<void>;
  /** Return whether this query is idle, running, failed, or closed. */
  getSessionState(): Promise<SessionStateSnapshot>;
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
  /** Return capability flags for the active provider/model pair. */
  getProviderCapabilities(model?: string): Promise<ProviderCapabilityRecord>;
  /** Return whether the active provider/model exposes native thinking blocks. */
  supportsThinking(model?: string): Promise<boolean>;
  /** Return whether the active provider/model supports structured output natively. */
  supportsStructuredOutput(model?: string): Promise<boolean>;
  /** Return available built-in agent profiles. */
  supportedAgents(): Promise<AgentInfo[]>;
  /** Return the resolved skill catalog for this session. */
  supportedSkills(): Promise<SkillCatalogEntry[]>;
  /** Return the authoritative runtime control-plane snapshot mirrored in AppState. */
  readRuntimeControlPlane(): Promise<RuntimeControlPlaneSnapshot>;
  /** Return runtime diagnostics from the authoritative control-plane snapshot. */
  listRuntimeDiagnostics(options?: RuntimeDiagnosticListOptions): Promise<RuntimeDiagnosticRecord[]>;
  /** Return the unified task/worker/dispatcher control-plane snapshot mirrored in AppState. */
  readOrchestrationControlPlane(options?: OrchestrationControlPlaneOptions): Promise<OrchestrationControlPlaneSnapshot>;
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
  /** Mark specific inbox messages as read without consuming them. */
  acknowledgeTeamInbox(input: TeamInboxAcknowledgeInput): Promise<{ acknowledged: number }>;
  /** List unresolved team approvals as structured control objects. */
  listPendingTeamApprovals(options: TeamApprovalListOptions): Promise<TeamApprovalRecord[]>;
  /** Respond to a pending team approval and optionally acknowledge the request. */
  respondToTeamApproval(input: TeamApprovalResponseInput): Promise<TeamApprovalResponseResult>;
  /** Return the unread inbox count for a member in the selected or named team. */
  getTeamInboxCount(memberName: string, options?: { teamName?: string }): Promise<number>;
  /** Read the selected team inbox and normalize messages into unified timeline items. */
  readTimelineInbox(options?: TimelineInboxOptions): Promise<SDKTimelineItem[]>;
  /** Subscribe to live worker orchestration events for this SDK session. */
  subscribeOrchestrationEvents(options?: SubscribeOrchestrationEventsOptions): AsyncIterable<SDKOrchestrationEvent>;
  /** Subscribe to a merged timeline of team inbox messages and worker orchestration events. */
  subscribeTimeline(options?: SubscribeTimelineOptions): AsyncIterable<SDKTimelineItem>;
  /** Execute a structured follow-up scaffold without manually decoding Task / SendMessage arguments. */
  executeFollowUp(followUp: FollowUpExecutable): Promise<FollowUpExecutionResult>;
  /** Return the currently registered runtime tools as capability metadata. */
  listRegisteredTools(): Promise<ToolCapabilityExportEntry[]>;
  /** Register or replace runtime tools for subsequent turns. */
  registerRuntimeTools(tools: ToolDefinition[]): Promise<RuntimeToolMutationResult>;
  /** Unregister runtime tools by name for subsequent turns. */
  unregisterRuntimeTools(names: string[]): Promise<RuntimeToolRemovalResult>;
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
  /** List currently live subagents with non-terminal states. */
  listRunningSubagents(options?: WorkerListOptions): Promise<SubagentRecord[]>;
  /** Cancel a running subagent by worker/session ID. */
  cancelSubagent(workerId: string): Promise<{ success: boolean }>;
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
  /** Claim the next available task and launch a worker in one orchestration step. */
  dispatchNextTask(input: TaskDispatchInput): Promise<TaskDispatchResult | null>;
  /** Start a background dispatcher loop that continuously claims and dispatches tasks. */
  startTaskDispatcher(input: TaskDispatcherStartInput): Promise<TaskDispatcherRecord>;
  /** Rehydrate a persisted dispatcher into a live loop using its durable control-plane state. */
  resumeTaskDispatcher(dispatcherId: string): Promise<TaskDispatcherRecord | null>;
  /** Return a single live task dispatcher tracked by this query handle. */
  getTaskDispatcher(dispatcherId: string): Promise<TaskDispatcherRecord | null>;
  /** List live task dispatchers tracked by this query handle. */
  listTaskDispatchers(options?: TaskDispatcherListOptions): Promise<TaskDispatcherRecord[]>;
  /** Inspect a dispatcher and emit structured health findings for stuck / expired / missing assignments. */
  inspectTaskDispatcherHealth(
    dispatcherId: string,
    options?: TaskDispatcherHealthOptions,
  ): Promise<TaskDispatcherHealthReport | null>;
  /** Return the latest persisted diagnosis object for a dispatcher, if one exists. */
  getTaskDispatcherDiagnosis(dispatcherId: string): Promise<TaskDispatcherHealthReport | null>;
  /** List persisted dispatcher diagnosis objects visible to this query handle. */
  listTaskDispatcherDiagnoses(options?: TaskDispatcherDiagnosisListOptions): Promise<TaskDispatcherHealthReport[]>;
  /** Force one active dispatcher assignment back to pending, optionally stopping its worker first. */
  requeueTaskDispatcherAssignment(input: TaskDispatcherRequeueInput): Promise<TaskDispatcherRequeueResult>;
  /** Stop a running task dispatcher. Active workers are drained before final stop. */
  stopTaskDispatcher(dispatcherId: string): Promise<TaskDispatcherStopResult>;
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
  /** Abort the current in-flight turn for this session. */
  interrupt(): Promise<void>;
  /** Return whether this session is idle, running, failed, or closed. */
  getSessionState(): Promise<SessionStateSnapshot>;
  /** Dynamically change the permission mode before the next turn. */
  setPermissionMode(mode: PermissionMode): Promise<void>;
  /** Swap the model before the next turn. */
  setModel(model?: string): Promise<void>;
  /** Adjust the extended-thinking token budget before the next turn. */
  setMaxThinkingTokens(maxThinkingTokens: number | null): Promise<void>;
  /** Return the list of available slash commands for this session. */
  supportedCommands(): Promise<SlashCommand[]>;
  /** Return the provider's model list. */
  supportedModels(): Promise<ModelInfo[]>;
  /** Return capability flags for the active provider/model pair. */
  getProviderCapabilities(model?: string): Promise<ProviderCapabilityRecord>;
  /** Return whether the active provider/model exposes native thinking blocks. */
  supportsThinking(model?: string): Promise<boolean>;
  /** Return whether the active provider/model supports structured output natively. */
  supportsStructuredOutput(model?: string): Promise<boolean>;
  /** Return available built-in agent profiles. */
  supportedAgents(): Promise<AgentInfo[]>;
  /** Return the resolved skill catalog for this session. */
  supportedSkills(): Promise<SkillCatalogEntry[]>;
  /** Return the authoritative runtime control-plane snapshot mirrored in AppState. */
  readRuntimeControlPlane(): Promise<RuntimeControlPlaneSnapshot>;
  /** Return runtime diagnostics from the authoritative control-plane snapshot. */
  listRuntimeDiagnostics(options?: RuntimeDiagnosticListOptions): Promise<RuntimeDiagnosticRecord[]>;
  /** Return the unified task/worker/dispatcher control-plane snapshot mirrored in AppState. */
  readOrchestrationControlPlane(options?: OrchestrationControlPlaneOptions): Promise<OrchestrationControlPlaneSnapshot>;
  /** Return the runtime status of every configured MCP server. */
  mcpServerStatus(): Promise<McpServerStatus[]>;
  /** Return account/billing information for the active API key. */
  accountInfo(): Promise<AccountInfo>;
  /** Return initialization metadata for this session handle. */
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
  /** Mark specific inbox messages as read without consuming them. */
  acknowledgeTeamInbox(input: TeamInboxAcknowledgeInput): Promise<{ acknowledged: number }>;
  /** List unresolved team approvals as structured control objects. */
  listPendingTeamApprovals(options: TeamApprovalListOptions): Promise<TeamApprovalRecord[]>;
  /** Respond to a pending team approval and optionally acknowledge the request. */
  respondToTeamApproval(input: TeamApprovalResponseInput): Promise<TeamApprovalResponseResult>;
  /** Return the unread inbox count for a member in the selected or named team. */
  getTeamInboxCount(memberName: string, options?: { teamName?: string }): Promise<number>;
  /** Read the selected team inbox and normalize messages into unified timeline items. */
  readTimelineInbox(options?: TimelineInboxOptions): Promise<SDKTimelineItem[]>;
  /** Subscribe to live worker orchestration events for this SDK session. */
  subscribeOrchestrationEvents(options?: SubscribeOrchestrationEventsOptions): AsyncIterable<SDKOrchestrationEvent>;
  /** Subscribe to a merged timeline of team inbox messages and worker orchestration events. */
  subscribeTimeline(options?: SubscribeTimelineOptions): AsyncIterable<SDKTimelineItem>;
  /** Execute a structured follow-up scaffold without manually decoding Task / SendMessage arguments. */
  executeFollowUp(followUp: FollowUpExecutable): Promise<FollowUpExecutionResult>;
  /** Return the currently registered runtime tools as capability metadata. */
  listRegisteredTools(): Promise<ToolCapabilityExportEntry[]>;
  /** Register or replace runtime tools for subsequent turns. */
  registerRuntimeTools(tools: ToolDefinition[]): Promise<RuntimeToolMutationResult>;
  /** Unregister runtime tools by name for subsequent turns. */
  unregisterRuntimeTools(names: string[]): Promise<RuntimeToolRemovalResult>;
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
  /** List currently live subagents with non-terminal states. */
  listRunningSubagents(options?: WorkerListOptions): Promise<SubagentRecord[]>;
  /** Cancel a running subagent by worker/session ID. */
  cancelSubagent(workerId: string): Promise<{ success: boolean }>;
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
  /** Claim the next available task and launch a worker in one orchestration step. */
  dispatchNextTask(input: TaskDispatchInput): Promise<TaskDispatchResult | null>;
  /** Start a background dispatcher loop that continuously claims and dispatches tasks. */
  startTaskDispatcher(input: TaskDispatcherStartInput): Promise<TaskDispatcherRecord>;
  /** Rehydrate a persisted dispatcher into a live loop using its durable control-plane state. */
  resumeTaskDispatcher(dispatcherId: string): Promise<TaskDispatcherRecord | null>;
  /** Return a single live task dispatcher tracked by this query handle. */
  getTaskDispatcher(dispatcherId: string): Promise<TaskDispatcherRecord | null>;
  /** List live task dispatchers tracked by this query handle. */
  listTaskDispatchers(options?: TaskDispatcherListOptions): Promise<TaskDispatcherRecord[]>;
  /** Inspect a dispatcher and emit structured health findings for stuck / expired / missing assignments. */
  inspectTaskDispatcherHealth(
    dispatcherId: string,
    options?: TaskDispatcherHealthOptions,
  ): Promise<TaskDispatcherHealthReport | null>;
  /** Return the latest persisted diagnosis object for a dispatcher, if one exists. */
  getTaskDispatcherDiagnosis(dispatcherId: string): Promise<TaskDispatcherHealthReport | null>;
  /** List persisted dispatcher diagnosis objects visible to this query handle. */
  listTaskDispatcherDiagnoses(options?: TaskDispatcherDiagnosisListOptions): Promise<TaskDispatcherHealthReport[]>;
  /** Force one active dispatcher assignment back to pending, optionally stopping its worker first. */
  requeueTaskDispatcherAssignment(input: TaskDispatcherRequeueInput): Promise<TaskDispatcherRequeueResult>;
  /** Stop a running task dispatcher. Active workers are drained before final stop. */
  stopTaskDispatcher(dispatcherId: string): Promise<TaskDispatcherStopResult>;
  /** Return visible background bash/agent tasks for the current runtime. */
  listBackgroundTasks(): Promise<BackgroundTaskSummary[]>;
  /** Return structured details for a specific background task, if found. */
  getBackgroundTask(taskId: string, options?: { block?: boolean; timeout?: number }): Promise<BackgroundTaskInspection | null>;
  /** Abort the current task. */
  stopTask(taskId: string): Promise<void>;
  /** Push an additional user message into the running session mid-stream. */
  streamInput(input: AsyncIterable<SDKUserMessage> | string): Promise<void>;
  /** Reconnect a specific MCP server by name (disconnect -> reconnect). */
  reconnectMcpServer(serverName: string): Promise<void>;
  /** Enable or disable a specific MCP server without removing its config. */
  toggleMcpServer(serverName: string, enabled: boolean): Promise<void>;
  /** Dynamically replace the full set of MCP servers for this session. */
  setMcpServers(
    servers: Record<string, McpServerConfig>,
  ): Promise<{ added: string[]; removed: string[]; errors: Record<string, string> }>;
  /** Restore files to the state before a checkpointed tool run. */
  rewindFiles(userMessageId: string, options?: RewindFilesOptions): Promise<RewindFilesResult>;
  /** Close the session and release resources. */
  close(): void;
  /** Supports `await using session = …` (TC39 explicit resource management). */
  [Symbol.asyncDispose](): Promise<void>;
}
